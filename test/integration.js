#!/usr/bin/env node
'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const SOCKET = path.join(os.tmpdir(), `pty-bridge-test-${process.pid}.sock`);
const STATE = `${SOCKET}.state.json`;

const envBase = {
  ...process.env,
  PTY_BRIDGE_SOCKET: SOCKET,
  PTY_BRIDGE_STATE: STATE,
  PTY_BRIDGE_OWNER: 'tester',
  PTY_BRIDGE_NO_UPDATE_CHECK: '1',
};

let failed = 0;
let passed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function run(args, extraEnv = {}, timeout = 20000) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...envBase, ...extraEnv },
    encoding: 'utf8',
    timeout,
  });
}

function sessionId(stdout) {
  const m = String(stdout).match(/Session: ([0-9a-f]+)/);
  return m ? m[1] : '';
}

function meta(stderr) {
  const m = String(stderr).match(/\[([^\]]+)\]/);
  return m ? m[1] : '';
}

function cleanup() {
  try {
    const st = run(['status']);
    const m = String(st.stdout).match(/Daemon PID:\s+(\d+)/);
    if (m) {
      try { process.kill(parseInt(m[1], 10), 'SIGKILL'); } catch {}
    }
  } catch {}
  try { fs.unlinkSync(SOCKET); } catch {}
  try { fs.unlinkSync(STATE); } catch {}
  try { fs.unlinkSync(SOCKET + '.lock'); } catch {}
}

process.on('exit', cleanup);

function startBash(extraEnv) {
  const r = run(['start', 'bash', '--norc', '--noprofile', '--wait', '400'], extraEnv);
  const id = sessionId(r.stdout);
  check('start bash', r.status === 0 && !!id, `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  return id;
}

console.log('pty-bridge integration tests');

cleanup();

// --- unknown flags error instead of silent ignore
{
  const r = run(['read', 'deadbeef', '--not-a-flag']);
  check('read unknown flag errors', r.status !== 0 && /unknown option/.test(r.stderr), r.stderr);
}

{
  const r = run(['exec', 'deadbeef', 'echo hi', '--timeout', '1000']);
  check('trailing RPC timeout is accepted before session lookup', /Session not found/.test(r.stderr), r.stderr);
}

{
  const r = run(['status', '--timeout', '5000']);
  check('status accepts a trailing RPC timeout', r.status === 0 && /Daemon PID/.test(r.stdout), r.stderr);
}

const id = startBash();
if (!id) {
  console.error('cannot continue without a session');
  process.exit(1);
}

// --- subcommand discovery, owner identity and machine-readable start
{
  for (const cmd of ['read', 'exec', 'snapshot', 'list', 'start', 'doctor']) {
    const help = run([cmd, '--help']);
    check(`${cmd} --help succeeds`, help.status === 0 && /Usage:/.test(help.stdout), help.stderr);
  }
  const started = run(['--owner', 'json-owner', 'start', 'bash', '--norc', '--noprofile', '--json', '--wait', '300']);
  let data; try { data = JSON.parse(started.stdout); } catch {}
  check('global owner and start --json', !!data?.sessionId && data.owner === 'json-owner', started.stdout + started.stderr);
  if (data?.sessionId) {
    const listed = run(['list', '--owner', 'json-owner', '--alive-only', '--json']);
    const list = JSON.parse(listed.stdout);
    check('list filters owner and live sessions', list.sessions.length === 1 && list.sessions[0].id === data.sessionId, listed.stdout);
    const exec = run(['--owner', 'json-owner', 'exec', '--wait', '300', data.sessionId, 'echo owner-ok']);
    check('options before session id are accepted', exec.status === 0 && /owner-ok/.test(exec.stdout), exec.stdout + exec.stderr);
    run(['kill', data.sessionId, '--owner', 'json-owner']);
  }
  const doctor = run(['doctor', '--json']);
  const report = JSON.parse(doctor.stdout);
  const version = require('../package.json').version;
  check('doctor includes CLI and daemon versions', report.version === version && report.daemon?.version === version && report.nativePty, doctor.stdout);
}

// --- raw CLI pagination preserves exact bytes, including CRLF and emoji
{
  const payload = 'abc中文🙂' + 'q'.repeat(300) + '\nend';
  const started = run(['start', process.execPath, '-e', `process.stdout.write(${JSON.stringify(payload)})`, '--wait', '600']);
  const sid = sessionId(started.stdout);
  let cursor = 0, collected = '';
  for (let i = 0; sid && i < 200; i++) {
    const chunk = run(['read', sid, '--raw', '--from', String(cursor), '--max-bytes', '7']);
    if (chunk.status !== 0) break;
    collected += chunk.stdout;
    cursor = Number((meta(chunk.stderr).match(/cursor=(\d+)/) || [])[1]);
    if (!/truncated=true/.test(chunk.stderr)) break;
  }
  check('raw CLI exact continuation has no missing or added bytes', collected === payload.replace(/\n/g, '\r\n'), JSON.stringify(collected));
  if (sid) run(['kill', sid]);
}

// --- wait-exit
{
  const r = run(['exec', id, 'echo hello-wait-exit', '--wait-exit', '--wait', '8000']);
  const m = meta(r.stderr);
  check('wait-exit stdout contains payload', /hello-wait-exit/.test(r.stdout), r.stdout);
  check('wait-exit status=done', /status=done/.test(m), m);
  check('wait-exit exitCode=0', /exitCode=0/.test(m), m);
  check('wait-exit strips sentinel', !/PTYBRIDGE_DONE_/.test(r.stdout), r.stdout);
  check('wait-exit returns only command output (no echo, no prompt)', r.stdout === 'hello-wait-exit\n', JSON.stringify(r.stdout));
  check('done metadata is compact', m === 'status=done exitCode=0', m);
}

{
  const r = run(['exec', id, 'printf abc', '--wait-exit', '--wait', '8000']);
  check('output without trailing newline is kept', r.stdout === 'abc\n' && /status=done/.test(r.stderr), JSON.stringify(r.stdout) + r.stderr);
}

{
  const r = run(['exec', id, 'false', '--wait-exit', '--wait', '8000']);
  const m = meta(r.stderr);
  check('wait-exit false status=failed', /status=failed/.test(m), m);
  check('wait-exit false exitCode=1', /exitCode=1/.test(m), m);
  check('wait-exit false session still alive (alive only reported when false)', !/alive=/.test(m), m);
}

// --- exec still_running + cursor
{
  const r = run(['exec', id, 'echo still-here', '--wait', '400']);
  const m = meta(r.stderr);
  check('plain exec still_running (shell session stays alive)', /status=still_running/.test(m), m);
  check('plain exec has cursor', /cursor=\d+/.test(m), m);
  check('plain exec output', /still-here/.test(r.stdout), r.stdout);
}

// --- read --lines is real
{
  run(['exec', id, 'python3 -c "print(\'L1\\nL2\\nL3\\nL4\\nL5\')"', '--wait-exit', '--wait', '8000']);
  const r = run(['read', id, '--lines', '3']);
  check('read --lines is not ignored', r.status === 0 && r.stdout.trim().length > 0, `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${r.stderr}`);
  check('read metadata has cursor', /cursor=\d+/.test(r.stderr), r.stderr);
}

{
  const r = run(['read', id, '--full', '--last', '2']);
  check('read mutually exclusive flags error', r.status !== 0 && /mutually exclusive/.test(r.stderr), r.stderr);
}

// --- max-bytes truncation
{
  const r = run(['exec', id, 'python3 -c "print(\'Z\'*4000)"', '--wait-exit', '--wait', '8000', '--max-bytes', '200']);
  const m = meta(r.stderr);
  check('max-bytes truncates', /truncated=true/.test(m), m);
  check('max-bytes reports totals', /totalBytes=\d+/.test(m) && /returnedBytes=\d+/.test(m), m);
  check('max-bytes returned smaller than total', (() => {
    const tot = Number((m.match(/totalBytes=(\d+)/) || [])[1]);
    const ret = Number((m.match(/returnedBytes=(\d+)/) || [])[1]);
    return tot > ret && ret > 0;
  })(), m);
}

// --- raw vs wrapped
{
  const wide = run(['start', 'bash', '--norc', '--noprofile', '--cols', '12', '--rows', '8', '--wait', '400']);
  const wid = sessionId(wide.stdout);
  check('narrow session started', !!wid, wide.stdout);
  if (wid) {
    const t0 = Date.now();
    const narrow = run(['exec', wid, 'echo ABCDEFGHIJKLMNOPQRSTUVWXYZ', '--wait-exit', '--wait', '8000']);
    check('narrow terminal: wrapped sentinel completes without waiting for timeout', /status=done/.test(narrow.stderr) && Date.now() - t0 < 6000, `${Date.now() - t0}ms ${narrow.stderr}`);
    check('narrow terminal: wrapped echo is stripped', narrow.stdout === 'ABCDEFGHIJKL\nMNOPQRSTUVWX\nYZ\n', JSON.stringify(narrow.stdout));
    const wrapped = run(['read', wid, '--full']);
    const raw = run(['read', wid, '--raw', '--full']);
    check('wrapped read splits long echo', /ABCDEFGHIJK/.test(wrapped.stdout), wrapped.stdout);
    check('raw read keeps unwrapped stream', /ABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(raw.stdout.replace(/\r/g, '')), raw.stdout);
    run(['kill', wid]);
  }
}

// --- owner guard
{
  const other = run(['exec', id, 'echo pwned', '--wait', '200'], { PTY_BRIDGE_OWNER: 'intruder' });
  check('owner mismatch rejected', other.status !== 0 && /owned by/.test(other.stderr), other.stderr);
  const forced = run(['exec', id, 'echo allowed-force', '--wait', '400', '--force'], { PTY_BRIDGE_OWNER: 'intruder' });
  check('owner mismatch allowed with --force', forced.status === 0 && /allowed-force/.test(forced.stdout), `status=${forced.status} ${forced.stdout} ${forced.stderr}`);
}

{
  const r = run(['list']);
  check('list shows owner', /owner=tester/.test(r.stdout), r.stdout);
}

// --- names and opt-in locking
{
  const unlocked = run(['start', 'bash', '--norc', '--noprofile', '--name', 'scratch.1', '--wait', '300'], { PTY_BRIDGE_OWNER: '' });
  check('start --name without owner prints an unlocked session', /^Session: [0-9a-f]{8} name=scratch\.1\n/.test(unlocked.stdout), unlocked.stdout + unlocked.stderr);
  const byName = run(['exec', 'scratch.1', 'echo by-name', '--wait-exit', '--wait', '8000'], { PTY_BRIDGE_OWNER: 'anyone' });
  check('unlocked session accepts any caller by name, no --force', byName.status === 0 && byName.stdout === 'by-name\n', byName.stdout + byName.stderr);
  const dup = run(['start', 'bash', '--norc', '--noprofile', '--name', 'scratch.1'], { PTY_BRIDGE_OWNER: '' });
  check('duplicate live session name is rejected', dup.status !== 0 && /already used/.test(dup.stderr), dup.stderr);
  const idLike = run(['start', 'bash', '--name', 'deadbeef']);
  check('id-shaped session name is rejected', idLike.status !== 0 && /look like a session id/.test(idLike.stderr), idLike.stderr);
  const listed = run(['list', '--json']);
  check('list exposes names', JSON.parse(listed.stdout).sessions.some(s => s.name === 'scratch.1' && !s.owner), listed.stdout);
  const killed = run(['kill', 'scratch.1'], { PTY_BRIDGE_OWNER: '' });
  check('kill by name removes the session', killed.status === 0 && !/scratch\.1/.test(run(['list']).stdout), killed.stdout + killed.stderr);

  const legacyUser = process.env.USER || process.env.USERNAME || 'default';
  const legacy = run(['start', 'bash', '--norc', '--noprofile', '--owner', legacyUser, '--wait', '300'], { PTY_BRIDGE_OWNER: '' });
  const lid = sessionId(legacy.stdout);
  const legacyExec = run(['exec', lid, 'echo legacy-ok', '--wait-exit', '--wait', '8000'], { PTY_BRIDGE_OWNER: '' });
  check('sessions locked to the OS user by older CLIs stay usable without flags', legacyExec.stdout === 'legacy-ok\n', legacyExec.stdout + legacyExec.stderr);
  run(['kill', lid], { PTY_BRIDGE_OWNER: '' });
}

// --- RPC timeout is still_running, not a failed exec (do not resend)
{
  const r = run(['--timeout', '400', 'exec', id, 'sleep 2; echo AFTERTO', '--wait', '8000'], {}, 15000);
  check('rpc timeout exit 0', r.status === 0, `status=${r.status} stderr=${r.stderr}`);
  check('rpc timeout reports still_running not Connection timeout failure', /status=still_running/.test(r.stderr) && !/Error: Connection timeout/.test(r.stderr), r.stderr);
  const caught = run(['wait-for', id, 'AFTERTO', '--timeout', '8']);
  check('timed-out exec still ran; resume via wait-for', caught.status === 0 && /AFTERTO/.test(caught.stdout), `${caught.stdout} ${caught.stderr}`);
}

// --- wait-for lookback (does not scan entire ancient history)
{
  const tokenOld = `OLDTOKEN${process.pid}`;
  const tokenNew = `NEWTOKEN${process.pid}`;
  run(['exec', id, `echo ${tokenOld}`, '--wait-exit', '--wait', '8000']);
  run(['exec', id, 'python3 -c "print(\'\\n\'.join(str(i) for i in range(250)))"', '--wait-exit', '--wait', '15000']);
  const old = run(['wait-for', id, tokenOld, '--timeout', '2']);
  check('wait-for does not match ancient pattern', old.status !== 0, `status=${old.status} stdout=${old.stdout} stderr=${old.stderr}`);
  const now = run(['exec', id, `echo ${tokenNew}`, '--wait', '200']);
  check('new token emitted', now.status === 0, now.stderr);
  const matched = run(['wait-for', id, tokenNew, '--timeout', '5']);
  check('wait-for matches recent pattern', matched.status === 0 && new RegExp(tokenNew).test(matched.stdout + matched.stderr), `${matched.stdout} ${matched.stderr}`);
}

// --- tombstone after daemon kill
{
  const st = run(['status']);
  const pidMatch = String(st.stdout).match(/Daemon PID:\s+(\d+)/);
  check('status has pid', !!pidMatch, st.stdout);
  if (pidMatch) {
    const dpid = parseInt(pidMatch[1], 10);
    try { process.kill(dpid, 'SIGKILL'); } catch {}
    // wait for death
    for (let i = 0; i < 20; i++) {
      try { process.kill(dpid, 0); execSync('sleep 0.1'); } catch { break; }
    }
    const listed = run(['list']);
    check('list warns about lost sessions after restart', /session\(s\) lost/.test(listed.stderr) || /lost  /.test(listed.stdout), `stdout=${listed.stdout}\nstderr=${listed.stderr}`);
    const st2 = run(['status']);
    check('status reports lost sessions', /Lost sessions:/.test(st2.stdout), st2.stdout);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
