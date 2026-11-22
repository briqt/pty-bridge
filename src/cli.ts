#!/usr/bin/env node

import { request, isRpcTimeout, inspectDaemon } from './client';
import { getSocketPath } from './protocol';
import { loadPty } from './session';
import * as fs from 'fs';
import * as path from 'path';
import { CURRENT_VERSION as VERSION, checkForUpdates, noticeMessage, updateMessage } from './updater';
import { defaultOwner, lockOwner, rpcTimeoutForWait, sessionNameProblem } from './protocol';

const args = process.argv.slice(2);

let globalTimeout: number | undefined;
let globalOwner: string | undefined;
let noUpdateCheck = false;
function fail(message: string): never { console.error(`Error: ${message}`); process.exit(1); }
function positive(value: string | undefined, name: string): number {
  if (!value || !/^\d+$/.test(value) || Number(value) <= 0) fail(`${name} requires a positive integer`);
  return Number(value);
}
// Global options work before the subcommand; subcommand parsers keep child arguments intact.
while (['--timeout', '--rpc-timeout-ms', '--owner', '--no-update-check'].includes(args[0])) {
  const flag = args.shift()!;
  if (flag === '--no-update-check') { noUpdateCheck = true; continue; }
  const value = args.shift();
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
  if (flag === '--owner') globalOwner = value;
  else globalTimeout = positive(value, flag);
}
const command = args[0];
if (command && !['start', '--help', '-h'].includes(command)) {
  for (const flag of ['--rpc-timeout-ms', ...(command === 'wait-for' ? [] : ['--timeout'])]) {
    const parsed = parseFlag(args, flag);
    if (parsed.value !== undefined) { globalTimeout = positive(parsed.value, flag); args.splice(0, args.length, ...parsed.rest); }
  }
  // Accept options before the session id as well as after it.
  if (['read', 'exec', 'write', 'sendkey', 'snapshot', 'kill', 'resize', 'wait-for'].includes(command)) {
    const prefix: string[] = [];
    const values = new Set(['--owner', '--wait', '--wait-for-idle', '--max-bytes', '--from', '--last', '--lines', '--buffer', '--timeout']);
    while (args[1]?.startsWith('-') && !['--help', '-h'].includes(args[1])) {
      const flag = args.splice(1, 1)[0]; prefix.push(flag);
      if (values.has(flag)) {
        if (!args[1] || args[1].startsWith('--')) fail(`${flag} requires a value`);
        prefix.push(args.splice(1, 1)[0]);
      }
    }
    if (prefix.length) args.push(...prefix);
  }
}

function dependencyVersion(name: string): string | null {
  try {
    let directory = path.dirname(require.resolve(name));
    for (let i = 0; i < 8; i++) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (pkg.name === name) return pkg.version;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {}
  return null;
}

function usage(): void {
  console.log(`pty-bridge — persistent interactive terminal sessions

Usage:
  pty-bridge [--rpc-timeout-ms <ms>] [--owner <name>] <command> [options]

  pty-bridge start <command> [args...]                Start a PTY session
  pty-bridge exec <session> <command> [options]       Send a command line and return its output
  pty-bridge write <session> <input>                  Send input as-is (or pipe via --stdin)
  pty-bridge sendkey <session> <key>                  Send special key (enter, tab, ctrl-c, up, etc.)
  pty-bridge read <session> [options]                 Read output (incremental by default)
  pty-bridge wait-for <session> <pattern> [--timeout <s>]  Block until pattern appears
  pty-bridge snapshot <session>                       Capture current visible screen
  pty-bridge list                                     List active and lost sessions
  pty-bridge kill <session>                           Terminate a session
  pty-bridge resize <session> <cols> <rows>           Resize terminal
  pty-bridge status                                   Show daemon status
  pty-bridge doctor [--json]                          Inspect versions/paths without starting a daemon
  pty-bridge check-update [--json]                    Check the published release manifest (no daemon)
  pty-bridge --version                                CLI version

<session> is a session id or the name given with start --name.
Metadata goes to stderr as one [key=value ...] line; fields appear only when they matter.

Global options:
  --rpc-timeout-ms <n>  RPC timeout in ms (before or after subcommand)
  --owner <name>        Caller identity for locked sessions
  --help                Works on subcommands too
  --no-update-check     Disable update checks; place before the subcommand

Start options:
  --name <name>        Stable handle usable instead of the id (unique among live sessions)
  --owner <name>       Lock the session; others then need --owner <name> or --force
                       (default: $PTY_BRIDGE_OWNER; unset = unlocked)
  --keepalive <secs>   Send keepalive to PTY every N seconds
  --wait <ms>          Initial wait before returning output (default: 500)
  --cols <n> --rows <n>  Terminal size (default: 120x40)
  --json               Print sessionId, name and owner as JSON

Exec options:
  --wait-exit          Shell only: wait for the command to finish; returns done/failed + exitCode
  --wait <ms>          Wait budget before returning (default: 200; 30000 with --wait-exit)
  --wait-for-idle <ms> Poll until output stabilizes
  --max-bytes <n>      Truncate returned output (default 256000; 0 = unlimited)

Read options:
  --full               Entire buffer (does not advance incremental cursor)
  --from <n[:byte]>    From a rendered line/byte-column, or a raw byte offset
  --from-exec          From last exec start (resume after timeout)
  --last <n>, --lines <n>
                       Last n lines (does not advance cursor)
  --raw                Unwrapped UTF-8 stream; cursor/--from are absolute byte offsets
  --max-bytes <n>      Truncate (default 256000; 0 = unlimited)
  --buffer <type>      active (default), normal, or alternate

Write/exec/sendkey/kill/resize on a locked session:
  --owner <name>       Caller identity (default: $PTY_BRIDGE_OWNER, else the OS user)
  --force              Explicit takeover of a session locked by someone else

Wait-for options:
  --timeout <s>        Seconds to wait (default: 30)
  --from <n>           Search from line n (default: last 200 lines + new output)
  --from-now           Only match output that appears after this call

List options:
  --json --alive-only --owner <name>`);
  const isHelp = args.includes('--help') || args.includes('-h');
  process.exit(isHelp || !command ? 0 : 1);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

function parseFlag(argList: string[], flag: string): { value: string | undefined; rest: string[] } {
  const idx = argList.indexOf(flag);
  if (idx === -1) return { value: undefined, rest: argList };
  const value = argList[idx + 1];
  if (value === undefined || value.startsWith('--')) fail(`${flag} requires a value`);
  const rest = argList.filter((_, i) => i !== idx && i !== idx + 1);
  return { value, rest };
}

function parseBoolFlag(argList: string[], flag: string): { present: boolean; rest: string[] } {
  const present = argList.includes(flag);
  return { present, rest: argList.filter(a => a !== flag) };
}

function rejectUnknownFlags(rest: string[], context: string): void {
  const unknown = rest.filter(a => a.startsWith('-') && a !== '--');
  if (unknown.length > 0) {
    console.error(`Error: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} for ${context}`);
    process.exit(1);
  }
}

function parseOwnerForce(argList: string[]): { owner: string; force: boolean; rest: string[] } {
  const o = parseFlag(argList, '--owner');
  const f = parseBoolFlag(o.rest, '--force');
  return { owner: o.value || globalOwner || defaultOwner(), force: f.present, rest: f.rest };
}

function writeMeta(fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  process.stderr.write(`[${parts.join(' ')}]\n`);
}

interface ExecLikeResult {
  output: string;
  status?: string;
  isAlive: boolean;
  exitCode?: number;
  startCursor?: number | string;
  cursor?: number | string;
  truncated?: boolean;
  totalBytes?: number;
  returnedBytes?: number;
}

/** Only actionable fields: a cursor when there is more to read, totals when truncated, alive only when false. */
function printExecResult(result: ExecLikeResult): void {
  if (result.output) console.log(result.output);
  const more = result.truncated || result.status === 'still_running';
  writeMeta({
    status: result.status,
    exitCode: result.exitCode,
    alive: result.isAlive ? undefined : false,
    cursor: more ? result.cursor : undefined,
    truncated: result.truncated || undefined,
    totalBytes: result.truncated ? result.totalBytes : undefined,
    returnedBytes: result.truncated ? result.returnedBytes : undefined,
  });
}

async function peekAfterTimeout(sessionId: string): Promise<ExecLikeResult | null> {
  try {
    return await request('peekExec', { sessionId }) as ExecLikeResult;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (command === '--version' || command === '-V') { console.log(VERSION); return; }
  const wantsHelp = command === 'start' ? ['--help', '-h'].includes(args[1]) : args.slice(1).some(a => a === '--help' || a === '-h');
  if (!command || command === '--help' || command === '-h' || wantsHelp) usage();

  try {
    switch (command) {
      case 'check-update': {
        const json = parseBoolFlag(args.slice(1), '--json');
        if (json.rest.length) fail('check-update accepts only --json');
        const result = await checkForUpdates({ explicit: true, disabled: noUpdateCheck });
        if (json.present) console.log(JSON.stringify(result));
        else {
          if (result.status === 'available') console.log(updateMessage({ version: result.latestVersion!, url: result.releaseUrl! }));
          else console.log(`Update check: ${result.status}${result.error ? ` (${result.error})` : ''}`);
          if (result.notice) console.log(noticeMessage({ version: result.latestVersion!, url: result.releaseUrl!, notice: result.notice }));
        }
        if (result.status === 'error' || result.status === 'busy') process.exitCode = 1;
        break;
      }
      case 'start': {
        const cmd = args[1];
        if (!cmd) { console.error('Error: command required'); usage(); }
        let cmdArgs = args.slice(2);
        const json = parseBoolFlag(cmdArgs, '--json'); cmdArgs = json.rest;
        const ka = parseFlag(cmdArgs, '--keepalive');
        cmdArgs = ka.rest;
        const w = parseFlag(cmdArgs, '--wait');
        cmdArgs = w.rest;
        const colsFlag = parseFlag(cmdArgs, '--cols');
        cmdArgs = colsFlag.rest;
        const rowsFlag = parseFlag(cmdArgs, '--rows');
        cmdArgs = rowsFlag.rest;
        const ownerFlag = parseFlag(cmdArgs, '--owner');
        cmdArgs = ownerFlag.rest;
        const nameFlag = parseFlag(cmdArgs, '--name');
        cmdArgs = nameFlag.rest;
        const name = nameFlag.value;
        if (name !== undefined) { const problem = sessionNameProblem(name); if (problem) fail(problem); }
        const keepaliveInterval = ka.value ? parseInt(ka.value, 10) : undefined;
        const wait = w.value ? parseInt(w.value, 10) : undefined;
        const cols = colsFlag.value ? parseInt(colsFlag.value, 10) : 120;
        const rows = rowsFlag.value ? parseInt(rowsFlag.value, 10) : 40;
        const owner = ownerFlag.value || globalOwner || lockOwner();
        const result = await request('start', {
          command: cmd,
          args: cmdArgs,
          cols,
          rows,
          cwd: process.cwd(),
          ...(owner ? { owner } : {}),
          ...(name ? { name } : {}),
          ...(keepaliveInterval ? { keepaliveInterval } : {}),
          ...(wait !== undefined && !isNaN(wait) ? { wait } : {}),
        }, globalTimeout) as { sessionId: string; output: string; owner?: string; name?: string; cursor?: number };
        if (name && !result.name) {
          console.error(`Warning: the running daemon predates session names, so '${name}' was ignored; use the id. Names work once that daemon exits (after its sessions end).`);
        }
        if (json.present) console.log(JSON.stringify(result));
        else {
          const tags = [result.name ? `name=${result.name}` : '', result.owner ? `owner=${result.owner}` : ''].filter(Boolean).join(' ');
          console.log(`Session: ${result.sessionId}${tags ? ` ${tags}` : ''}`);
          if (result.output) console.log(result.output);
        }
        break;
      }

      case 'read': {
        const id = args[1];
        if (!id) { console.error('Error: session id required'); usage(); }
        let readArgs = args.slice(2);
        const full = parseBoolFlag(readArgs, '--full');
        readArgs = full.rest;
        const raw = parseBoolFlag(readArgs, '--raw');
        readArgs = raw.rest;
        const fromExec = parseBoolFlag(readArgs, '--from-exec');
        readArgs = fromExec.rest;
        const fromFlag = parseFlag(readArgs, '--from');
        readArgs = fromFlag.rest;
        const lastFlag = parseFlag(readArgs, '--last');
        readArgs = lastFlag.rest;
        const linesFlag = parseFlag(readArgs, '--lines');
        readArgs = linesFlag.rest;
        const maxFlag = parseFlag(readArgs, '--max-bytes');
        readArgs = maxFlag.rest;
        const bufFlag = parseFlag(readArgs, '--buffer');
        readArgs = bufFlag.rest;
        rejectUnknownFlags(readArgs, 'read');

        const lastRaw = lastFlag.value ?? linesFlag.value;
        const last = lastRaw ? parseInt(lastRaw, 10) : undefined;
        const fromParts = fromFlag.value?.split(':');
        const from = fromParts ? Number(fromParts[0]) : undefined;
        const column = fromParts?.[1] !== undefined ? Number(fromParts[1]) : undefined;
        const maxBytes = maxFlag.value ? parseInt(maxFlag.value, 10) : undefined;
        const buf = bufFlag.value as 'active' | 'normal' | 'alternate' | undefined;

        const exclusive = [full.present, from !== undefined, last !== undefined, fromExec.present].filter(Boolean).length;
        if (exclusive > 1) {
          console.error('Error: --full, --from, --from-exec, and --last/--lines are mutually exclusive');
          process.exit(1);
        }
        if (lastRaw !== undefined && (last === undefined || isNaN(last) || last < 0)) {
          console.error('Error: --last/--lines must be a non-negative integer');
          process.exit(1);
        }
        if (fromFlag.value !== undefined && (!/^\d+(?::\d+)?$/.test(fromFlag.value) || from === undefined || !Number.isSafeInteger(from) || (column !== undefined && !Number.isSafeInteger(column)))) {
          console.error('Error: --from must be a non-negative line[:byte-column] or raw byte offset');
          process.exit(1);
        }

        const params: Record<string, unknown> = { sessionId: id };
        if (full.present) params.since = 0;
        if (from !== undefined) params.since = from;
        if (column !== undefined) { if (raw.present) fail('raw --from must be a byte offset without a column'); params.column = column; }
        if (last !== undefined) params.last = last;
        if (fromExec.present) params.fromLastExec = true;
        if (raw.present) params.raw = true;
        if (buf) params.buffer = buf;
        if (maxBytes !== undefined) {
          if (isNaN(maxBytes) || maxBytes < 0) {
            console.error('Error: --max-bytes must be a non-negative integer (0 = unlimited)');
            process.exit(1);
          }
          params.maxBytes = maxBytes;
        }

        const result = await request('read', params, globalTimeout) as {
          output: string; isAlive: boolean; exitCode?: number; totalLines: number; bufferType?: string;
          cursor?: number | string; startCursor?: number | string; truncated?: boolean; totalBytes?: number; returnedBytes?: number; raw?: boolean; lostBytes?: number;
        };
        if (result.output) { if (raw.present) process.stdout.write(result.output); else console.log(result.output); }
        writeMeta({
          cursor: result.cursor,
          buffer: result.bufferType === 'alternate' ? 'alternate' : undefined,
          alive: result.isAlive ? undefined : false,
          exitCode: result.isAlive ? undefined : result.exitCode,
          truncated: result.truncated || undefined,
          totalBytes: result.truncated ? result.totalBytes : undefined,
          returnedBytes: result.truncated ? result.returnedBytes : undefined,
          lostBytes: result.lostBytes || undefined,
        });
        break;
      }

      case 'write': {
        const id = args[1];
        if (!id) { console.error('Error: session id required'); usage(); }
        const parsed = parseOwnerForce(args.slice(2));
        const stdinFlag = parseBoolFlag(parsed.rest, '--stdin');
        const textArgs = stdinFlag.rest;
        let input: string;
        if (stdinFlag.present) {
          input = await readStdin();
        } else if (textArgs.length > 0) {
          input = textArgs.join(' ');
        } else {
          console.error('Error: input required (as argument or --stdin)');
          usage();
          return;
        }
        if (!input) { console.error('Error: empty input'); process.exit(1); }
        await request('write', { sessionId: id, input, owner: parsed.owner, force: parsed.force }, globalTimeout);
        break;
      }

      case 'exec': {
        const id = args[1];
        if (!id) { console.error('Error: session id required'); usage(); }
        let execArgs = args.slice(2);
        const parsed = parseOwnerForce(execArgs);
        execArgs = parsed.rest;
        const w = parseFlag(execArgs, '--wait');
        execArgs = w.rest;
        const idle = parseFlag(execArgs, '--wait-for-idle');
        execArgs = idle.rest;
        const waitExit = parseBoolFlag(execArgs, '--wait-exit');
        execArgs = waitExit.rest;
        const maxFlag = parseFlag(execArgs, '--max-bytes');
        execArgs = maxFlag.rest;
        if (execArgs.includes('--timeout')) {
          console.error('Error: --timeout is a global flag and must appear before the subcommand: pty-bridge --timeout <ms> exec ... . Use --wait <ms> for the exec wait budget.');
          process.exit(1);
        }
        if (waitExit.present && idle.value) {
          console.error('Error: --wait-exit and --wait-for-idle cannot be combined');
          process.exit(1);
        }
        if (execArgs.length === 0) { console.error('Error: command required'); usage(); }
        const cmd = execArgs.join(' ');
        const waitMs = w.value ? parseInt(w.value, 10) : (waitExit.present ? 30000 : (idle.value ? 5000 : 200));
        if (isNaN(waitMs) || waitMs < 0) {
          console.error('Error: --wait must be a non-negative integer');
          process.exit(1);
        }
        const waitForIdle = idle.value ? parseInt(idle.value, 10) : undefined;
        const maxBytes = maxFlag.value ? parseInt(maxFlag.value, 10) : undefined;
        const params: Record<string, unknown> = {
          sessionId: id,
          command: cmd,
          waitMs,
          owner: parsed.owner,
          force: parsed.force,
          ...(waitForIdle ? { waitForIdle } : {}),
          ...(waitExit.present ? { waitExit: true } : {}),
        };
        if (maxBytes !== undefined) {
          if (isNaN(maxBytes) || maxBytes < 0) {
            console.error('Error: --max-bytes must be a non-negative integer (0 = unlimited)');
            process.exit(1);
          }
          params.maxBytes = maxBytes;
        }
        const socketTimeout = rpcTimeoutForWait(waitMs, globalTimeout);
        try {
          const result = await request('exec', params, socketTimeout) as ExecLikeResult;
          printExecResult(result);
        } catch (err: unknown) {
          if (!isRpcTimeout(err)) throw err;
          const peek = await peekAfterTimeout(id);
          if (peek) {
            peek.status = peek.status || 'still_running';
            printExecResult(peek);
          } else {
            writeMeta({ status: 'still_running', error: 'rpc_timeout' });
            console.error('RPC timed out; command was already sent. Use: pty-bridge read <id> --from-exec');
          }
        }
        break;
      }

      case 'sendkey': {
        const id = args[1];
        const parsed = parseOwnerForce(args.slice(2));
        const key = parsed.rest[0];
        rejectUnknownFlags(parsed.rest.slice(1), 'sendkey');
        if (!id || !key) { console.error('Error: session id and key required'); usage(); }
        await request('sendkey', { sessionId: id, key, owner: parsed.owner, force: parsed.force }, globalTimeout);
        break;
      }

      case 'wait-for': {
        const id = args[1];
        const pattern = args[2];
        if (!id || !pattern) { console.error('Error: session id and pattern required'); usage(); }
        let wfArgs = args.slice(3);
        const t = parseFlag(wfArgs, '--timeout');
        wfArgs = t.rest;
        const fromFlag = parseFlag(wfArgs, '--from');
        wfArgs = fromFlag.rest;
        const fromNow = parseBoolFlag(wfArgs, '--from-now');
        wfArgs = fromNow.rest;
        rejectUnknownFlags(wfArgs, 'wait-for');
        if (fromNow.present && fromFlag.value) {
          console.error('Error: --from and --from-now are mutually exclusive');
          process.exit(1);
        }
        const timeoutSec = t.value ? parseInt(t.value, 10) : 30;
        if (isNaN(timeoutSec) || timeoutSec <= 0) { console.error('Error: invalid timeout value'); process.exit(1); }
        const from = fromFlag.value ? parseInt(fromFlag.value, 10) : undefined;
        if (fromFlag.value !== undefined && (from === undefined || isNaN(from) || from < 0)) {
          console.error('Error: --from must be a non-negative integer');
          process.exit(1);
        }
        const timeoutMs = timeoutSec * 1000;
        const socketTimeout = rpcTimeoutForWait(timeoutMs, globalTimeout);
        const result = await request('waitFor', {
          sessionId: id,
          pattern,
          timeoutMs,
          ...(fromNow.present ? { fromNow: true } : {}),
          ...(from !== undefined ? { from } : {}),
        }, socketTimeout) as { matched: boolean; output: string; error?: string; cursor?: number; startCursor?: number };
        if (result.output) console.log(result.output);
        writeMeta({ matched: result.matched, cursor: result.cursor });
        if (!result.matched) {
          console.error(result.error || `Timeout waiting for pattern: ${pattern}`);
          process.exit(1);
        }
        break;
      }

      case 'snapshot': {
        const id = args[1];
        if (!id) { console.error('Error: session id required'); usage(); }
        rejectUnknownFlags(parseOwnerForce(args.slice(2)).rest, 'snapshot');
        const result = await request('snapshot', { sessionId: id }, globalTimeout) as { success: boolean; lines: string[]; cursorX: number; cursorY: number; bufferType: string; cols: number; rows: number };
        console.log(`[buffer=${result.bufferType}  cursor=${result.cursorX},${result.cursorY}  size=${result.cols}x${result.rows}]`);
        console.log(result.lines.join('\n'));
        break;
      }

      case 'list': {
        const filterOwner = parseFlag(args.slice(1), '--owner');
        const json = parseBoolFlag(filterOwner.rest, '--json');
        const alive = parseBoolFlag(json.rest, '--alive-only');
        rejectUnknownFlags(alive.rest, 'list');
        const result = await request('list', {}, globalTimeout) as {
          sessions: Array<{ id: string; command: string; pid: number; isAlive: boolean; uptime: string; bufferLines: number; bufferType: string; lastActivityAt: string; owner?: string; name?: string }>;
          lostSessions?: Array<{ id: string; command: string; pid: number; owner: string; name?: string; startedAt: string; lostAt: string }>;
          lastRestartAt?: string;
          lostCount?: number;
        };
        const owner = filterOwner.value || globalOwner;
        result.sessions = result.sessions.filter(s => (!owner || s.owner === owner) && (!alive.present || s.isAlive));
        result.lostSessions = (result.lostSessions || []).filter(s => !alive.present && (!owner || s.owner === owner));
        if (json.present) { console.log(JSON.stringify(result)); break; }
        if (result.lostCount && result.lostCount > 0) {
          console.error(`Warning: daemon restarted at ${result.lastRestartAt ?? 'unknown'}, ${result.lostCount} session(s) lost`);
        }
        if (result.sessions.length === 0) {
          console.log('No active sessions');
        } else {
          for (const s of result.sessions) {
            const status = s.isAlive ? 'alive' : 'dead';
            const tags = `${s.name ? `  name=${s.name}` : ''}${s.owner ? `  owner=${s.owner}` : ''}`;
            console.log(`${s.id}${tags}  ${s.command}  pid=${s.pid}  ${status}  buffer=${s.bufferType}  uptime=${s.uptime}  lines=${s.bufferLines}  lastActivity=${s.lastActivityAt}`);
          }
        }
        if (result.lostSessions) {
          for (const s of result.lostSessions) {
            const tags = `${s.name ? `  name=${s.name}` : ''}${s.owner ? `  owner=${s.owner}` : ''}`;
            console.log(`lost  ${s.id}${tags}  ${s.command}  pid=${s.pid}  started=${s.startedAt}  lostAt=${s.lostAt}  (reattach not supported; remote nohup may still be running)`);
          }
        }
        break;
      }

      case 'kill': {
        const id = args[1];
        if (!id) { console.error('Error: session id required'); usage(); }
        const parsed = parseOwnerForce(args.slice(2));
        rejectUnknownFlags(parsed.rest, 'kill');
        await request('kill', { sessionId: id, owner: parsed.owner, force: parsed.force }, globalTimeout);
        console.log(`Session ${id} killed`);
        break;
      }

      case 'resize': {
        const id = args[1];
        const parsed = parseOwnerForce(args.slice(2));
        const cols = parseInt(parsed.rest[0], 10);
        const rows = parseInt(parsed.rest[1], 10);
        rejectUnknownFlags(parsed.rest.slice(2), 'resize');
        if (!id || isNaN(cols) || isNaN(rows)) {
          console.error('Error: session id, cols, and rows required');
          usage();
        }
        await request('resize', { sessionId: id, cols, rows, owner: parsed.owner, force: parsed.force }, globalTimeout);
        console.log(`Session ${id} resized to ${cols}x${rows}`);
        break;
      }

      case 'doctor': {
        const json = parseBoolFlag(args.slice(1), '--json');
        rejectUnknownFlags(json.rest, 'doctor');
        let nativePty = true; let nativeError: string | undefined;
        try { await loadPty(); } catch (err) { nativePty = false; nativeError = String(err); }
        const daemon = await inspectDaemon();
        const dependencyVersions = Object.fromEntries(['@lydell/node-pty', '@xterm/headless'].map(name => [name, dependencyVersion(name)]));
        const result = { version: VERSION, dependencyVersions, cliPath: __filename, node: process.version, nodePath: process.execPath, socket: getSocketPath(), owner: globalOwner || lockOwner() || null, nativePty, nativeError, daemon, capabilities: ['absolute-raw-byte-cursors', 'rendered-column-cursors', 'owner-guard', 'wait-exit', 'session-names', 'exec-echo-stripping', 'compact-metadata'] };
        console.log(json.present ? JSON.stringify(result) : JSON.stringify(result, null, 2));
        if (!nativePty) process.exitCode = 1;
        break;
      }

      case 'status': {
        rejectUnknownFlags(args.slice(1), 'status');
        const result = await request('status', {}, globalTimeout) as {
          daemonStartedAt: string; pid: number; activeSessions: number; totalSessions: number; memoryUsageMB: number;
          lastRestartAt?: string; lostCount?: number;
        };
        console.log(`Daemon PID:        ${result.pid}`);
        console.log(`Started at:        ${result.daemonStartedAt}`);
        console.log(`Active sessions:   ${result.activeSessions}`);
        console.log(`Total sessions:    ${result.totalSessions}`);
        console.log(`Memory usage:      ${result.memoryUsageMB} MB`);
        if (result.lostCount && result.lostCount > 0) {
          console.log(`Last restart:      ${result.lastRestartAt ?? 'unknown'}`);
          console.log(`Lost sessions:     ${result.lostCount}`);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        usage();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isRpcTimeout(err)) {
      writeMeta({ status: 'still_running', error: 'rpc_timeout' });
      console.error('Error: RPC timed out. If this was exec, the command was already sent — do not resend. Use: pty-bridge read <id> --from-exec');
      process.exit(0);
    }
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

main().then(async () => {
  // Keep help/version/doctor offline and leave high-frequency PTY I/O untouched.
  if (['start', 'list', 'status'].includes(command) && !process.exitCode) {
    await checkForUpdates({ disabled: noUpdateCheck });
  }
}).catch(err => { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; });
