#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("./client");
const protocol_1 = require("./protocol");
const args = process.argv.slice(2);
let globalTimeout;
const timeoutIdx = args.indexOf('--timeout');
if (timeoutIdx !== -1 && args[0] !== 'wait-for') {
    const beforeCommand = timeoutIdx === 0;
    if (beforeCommand) {
        globalTimeout = parseInt(args[timeoutIdx + 1], 10);
        if (isNaN(globalTimeout) || globalTimeout <= 0) {
            console.error('Error: --timeout must be a positive integer (milliseconds)');
            process.exit(1);
        }
        args.splice(timeoutIdx, 2);
    }
    else {
        console.error('Error: --timeout must appear before the subcommand, e.g. pty-bridge --timeout 60000 exec <id> "cmd". For exec wait budget use --wait <ms>. For wait-for, use --timeout <seconds> as a subcommand flag.');
        process.exit(1);
    }
}
const command = args[0];
function usage() {
    console.log(`pty-bridge — manage interactive terminal sessions

Usage:
  pty-bridge [--timeout <ms>] [--owner <name>] <command> [options]

  pty-bridge start <command> [args...]                Start a PTY session
  pty-bridge read <id> [options]                      Read terminal output
  pty-bridge write <id> <input>                       Send input (or pipe via stdin)
  pty-bridge exec <id> <command> [options]            Execute command and return new output
  pty-bridge sendkey <id> <key>                       Send special key (ctrl-c, enter, tab, up, etc.)
  pty-bridge wait-for <id> <pattern> [--timeout <s>]  Block until pattern appears
  pty-bridge snapshot <id>                            Capture current visible screen
  pty-bridge list                                     List active and lost sessions
  pty-bridge kill <id>                                Terminate a session
  pty-bridge resize <id> <cols> <rows>                Resize terminal
  pty-bridge status                                   Show daemon status

Start options:
  --keepalive <secs>   Send keepalive to PTY every N seconds
  --wait <ms>          Initial wait before returning output (default: 500)
  --cols <n> --rows <n>
  --owner <name>       Session owner (default: $PTY_BRIDGE_OWNER or $USER)

Read options:
  --full               Entire buffer (does not advance incremental cursor)
  --from <n>           From line n (does not advance cursor)
  --from-exec          From last exec start (resume after timeout)
  --last <n>, --lines <n>
                       Last n lines (does not advance cursor)
  --raw                Unwrapped PTY byte stream (skips xterm wrapping)
  --max-bytes <n>      Truncate (default 256000; 0 = unlimited)
  --buffer <type>      active (default), normal, or alternate

Exec options:
  --wait <ms>          Wait budget before returning (default: 200; 30000 with --wait-exit)
  --wait-for-idle <ms> Poll until output stabilizes
  --wait-exit          Shell only: inject a sentinel and return done/failed + exit code
  --max-bytes <n>      Truncate returned output
  --force              Override owner check

Write/sendkey/kill/resize:
  --owner <name>       Caller identity (default: $PTY_BRIDGE_OWNER or $USER)
  --force              Allow mutating a session owned by someone else

Wait-for options:
  --timeout <s>        Seconds to wait (default: 30)
  --from <n>           Search from line n (default: last 200 lines + new output)
  --from-now           Only match output that appears after this call`);
    const isHelp = command === '--help' || command === '-h';
    process.exit(isHelp || !command ? 0 : 1);
}
async function readStdin() {
    if (process.stdin.isTTY)
        return '';
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString();
}
function parseFlag(argList, flag) {
    const idx = argList.indexOf(flag);
    if (idx === -1)
        return { value: undefined, rest: argList };
    const value = argList[idx + 1];
    const rest = argList.filter((_, i) => i !== idx && i !== idx + 1);
    return { value, rest };
}
function parseBoolFlag(argList, flag) {
    const present = argList.includes(flag);
    return { present, rest: argList.filter(a => a !== flag) };
}
function rejectUnknownFlags(rest, context) {
    const unknown = rest.filter(a => a.startsWith('-') && a !== '--');
    if (unknown.length > 0) {
        console.error(`Error: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} for ${context}`);
        process.exit(1);
    }
}
function parseOwnerForce(argList) {
    const o = parseFlag(argList, '--owner');
    const f = parseBoolFlag(o.rest, '--force');
    return { owner: o.value || (0, protocol_1.defaultOwner)(), force: f.present, rest: f.rest };
}
function writeMeta(fields) {
    const parts = Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${k}=${v}`);
    process.stderr.write(`[${parts.join(' ')}]\n`);
}
function printExecResult(result) {
    if (result.output)
        console.log(result.output);
    writeMeta({
        status: result.status,
        cursor: result.cursor,
        startCursor: result.startCursor,
        alive: result.isAlive,
        truncated: result.truncated,
        totalBytes: result.totalBytes,
        returnedBytes: result.returnedBytes,
        exitCode: result.exitCode,
    });
    if (!result.isAlive) {
        console.log(`\n[Process exited with code ${result.exitCode ?? 'unknown'}]`);
    }
}
async function peekAfterTimeout(sessionId) {
    try {
        return await (0, client_1.request)('peekExec', { sessionId });
    }
    catch {
        return null;
    }
}
async function main() {
    if (!command || command === '--help' || command === '-h')
        usage();
    try {
        switch (command) {
            case 'start': {
                const cmd = args[1];
                if (!cmd) {
                    console.error('Error: command required');
                    usage();
                }
                let cmdArgs = args.slice(2);
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
                const keepaliveInterval = ka.value ? parseInt(ka.value, 10) : undefined;
                const wait = w.value ? parseInt(w.value, 10) : undefined;
                const cols = colsFlag.value ? parseInt(colsFlag.value, 10) : 120;
                const rows = rowsFlag.value ? parseInt(rowsFlag.value, 10) : 40;
                const owner = ownerFlag.value || (0, protocol_1.defaultOwner)();
                const result = await (0, client_1.request)('start', {
                    command: cmd,
                    args: cmdArgs,
                    cols,
                    rows,
                    cwd: process.cwd(),
                    owner,
                    ...(keepaliveInterval ? { keepaliveInterval } : {}),
                    ...(wait !== undefined && !isNaN(wait) ? { wait } : {}),
                }, globalTimeout);
                console.log(`Session: ${result.sessionId} owner=${result.owner || owner}`);
                if (result.output)
                    console.log(result.output);
                break;
            }
            case 'read': {
                const id = args[1];
                if (!id) {
                    console.error('Error: session id required');
                    usage();
                }
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
                const from = fromFlag.value ? parseInt(fromFlag.value, 10) : undefined;
                const maxBytes = maxFlag.value ? parseInt(maxFlag.value, 10) : undefined;
                const buf = bufFlag.value;
                const exclusive = [full.present, from !== undefined, last !== undefined, fromExec.present].filter(Boolean).length;
                if (exclusive > 1) {
                    console.error('Error: --full, --from, --from-exec, and --last/--lines are mutually exclusive');
                    process.exit(1);
                }
                if (lastRaw !== undefined && (last === undefined || isNaN(last) || last < 0)) {
                    console.error('Error: --last/--lines must be a non-negative integer');
                    process.exit(1);
                }
                if (fromFlag.value !== undefined && (from === undefined || isNaN(from) || from < 0)) {
                    console.error('Error: --from must be a non-negative integer');
                    process.exit(1);
                }
                const params = { sessionId: id };
                if (full.present)
                    params.since = 0;
                if (from !== undefined)
                    params.since = from;
                if (last !== undefined)
                    params.last = last;
                if (fromExec.present)
                    params.fromLastExec = true;
                if (raw.present)
                    params.raw = true;
                if (buf)
                    params.buffer = buf;
                if (maxBytes !== undefined) {
                    if (isNaN(maxBytes) || maxBytes < 0) {
                        console.error('Error: --max-bytes must be a non-negative integer (0 = unlimited)');
                        process.exit(1);
                    }
                    params.maxBytes = maxBytes;
                }
                const result = await (0, client_1.request)('read', params, globalTimeout);
                if (result.output)
                    console.log(result.output);
                writeMeta({
                    lines: result.totalLines,
                    alive: result.isAlive,
                    buffer: result.bufferType ?? '?',
                    cursor: result.cursor,
                    startCursor: result.startCursor,
                    truncated: result.truncated,
                    totalBytes: result.totalBytes,
                    returnedBytes: result.returnedBytes,
                    raw: result.raw,
                    exitCode: result.exitCode,
                });
                break;
            }
            case 'write': {
                const id = args[1];
                if (!id) {
                    console.error('Error: session id required');
                    usage();
                }
                const parsed = parseOwnerForce(args.slice(2));
                const stdinFlag = parseBoolFlag(parsed.rest, '--stdin');
                const textArgs = stdinFlag.rest;
                let input;
                if (stdinFlag.present) {
                    input = await readStdin();
                }
                else if (textArgs.length > 0) {
                    input = textArgs.join(' ');
                }
                else {
                    console.error('Error: input required (as argument or --stdin)');
                    usage();
                    return;
                }
                if (!input) {
                    console.error('Error: empty input');
                    process.exit(1);
                }
                await (0, client_1.request)('write', { sessionId: id, input, owner: parsed.owner, force: parsed.force }, globalTimeout);
                break;
            }
            case 'exec': {
                const id = args[1];
                if (!id) {
                    console.error('Error: session id required');
                    usage();
                }
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
                if (execArgs.length === 0) {
                    console.error('Error: command required');
                    usage();
                }
                const cmd = execArgs.join(' ');
                const waitMs = w.value ? parseInt(w.value, 10) : (waitExit.present ? 30000 : (idle.value ? 5000 : 200));
                if (isNaN(waitMs) || waitMs < 0) {
                    console.error('Error: --wait must be a non-negative integer');
                    process.exit(1);
                }
                const waitForIdle = idle.value ? parseInt(idle.value, 10) : undefined;
                const maxBytes = maxFlag.value ? parseInt(maxFlag.value, 10) : undefined;
                const params = {
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
                const socketTimeout = (0, protocol_1.rpcTimeoutForWait)(waitMs, globalTimeout);
                try {
                    const result = await (0, client_1.request)('exec', params, socketTimeout);
                    printExecResult(result);
                }
                catch (err) {
                    if (!(0, client_1.isRpcTimeout)(err))
                        throw err;
                    const peek = await peekAfterTimeout(id);
                    if (peek) {
                        peek.status = peek.status || 'still_running';
                        printExecResult(peek);
                    }
                    else {
                        writeMeta({ status: 'still_running', alive: true, error: 'rpc_timeout' });
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
                if (!id || !key) {
                    console.error('Error: session id and key required');
                    usage();
                }
                await (0, client_1.request)('sendkey', { sessionId: id, key, owner: parsed.owner, force: parsed.force }, globalTimeout);
                break;
            }
            case 'wait-for': {
                const id = args[1];
                const pattern = args[2];
                if (!id || !pattern) {
                    console.error('Error: session id and pattern required');
                    usage();
                }
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
                if (isNaN(timeoutSec) || timeoutSec <= 0) {
                    console.error('Error: invalid timeout value');
                    process.exit(1);
                }
                const from = fromFlag.value ? parseInt(fromFlag.value, 10) : undefined;
                if (fromFlag.value !== undefined && (from === undefined || isNaN(from) || from < 0)) {
                    console.error('Error: --from must be a non-negative integer');
                    process.exit(1);
                }
                const timeoutMs = timeoutSec * 1000;
                const socketTimeout = (0, protocol_1.rpcTimeoutForWait)(timeoutMs, globalTimeout);
                const result = await (0, client_1.request)('waitFor', {
                    sessionId: id,
                    pattern,
                    timeoutMs,
                    ...(fromNow.present ? { fromNow: true } : {}),
                    ...(from !== undefined ? { from } : {}),
                }, socketTimeout);
                if (result.output)
                    console.log(result.output);
                writeMeta({ matched: result.matched, cursor: result.cursor, startCursor: result.startCursor });
                if (!result.matched) {
                    console.error(result.error || `Timeout waiting for pattern: ${pattern}`);
                    process.exit(1);
                }
                break;
            }
            case 'snapshot': {
                const id = args[1];
                if (!id) {
                    console.error('Error: session id required');
                    usage();
                }
                rejectUnknownFlags(args.slice(2), 'snapshot');
                const result = await (0, client_1.request)('snapshot', { sessionId: id }, globalTimeout);
                console.log(`[buffer=${result.bufferType}  cursor=${result.cursorX},${result.cursorY}  size=${result.cols}x${result.rows}]`);
                console.log(result.lines.join('\n'));
                break;
            }
            case 'list': {
                rejectUnknownFlags(args.slice(1), 'list');
                const result = await (0, client_1.request)('list', {}, globalTimeout);
                if (result.lostCount && result.lostCount > 0) {
                    console.error(`Warning: daemon restarted at ${result.lastRestartAt ?? 'unknown'}, ${result.lostCount} session(s) lost`);
                }
                if (result.sessions.length === 0) {
                    console.log('No active sessions');
                }
                else {
                    for (const s of result.sessions) {
                        const status = s.isAlive ? 'alive' : 'dead';
                        console.log(`${s.id}  ${s.command}  pid=${s.pid}  ${status}  owner=${s.owner || '-'}  buffer=${s.bufferType}  uptime=${s.uptime}  lines=${s.bufferLines}  lastActivity=${s.lastActivityAt}`);
                    }
                }
                if (result.lostSessions) {
                    for (const s of result.lostSessions) {
                        console.log(`lost  ${s.id}  ${s.command}  pid=${s.pid}  owner=${s.owner || '-'}  started=${s.startedAt}  lostAt=${s.lostAt}  (reattach not supported; remote nohup may still be running)`);
                    }
                }
                break;
            }
            case 'kill': {
                const id = args[1];
                if (!id) {
                    console.error('Error: session id required');
                    usage();
                }
                const parsed = parseOwnerForce(args.slice(2));
                rejectUnknownFlags(parsed.rest, 'kill');
                await (0, client_1.request)('kill', { sessionId: id, owner: parsed.owner, force: parsed.force }, globalTimeout);
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
                await (0, client_1.request)('resize', { sessionId: id, cols, rows, owner: parsed.owner, force: parsed.force }, globalTimeout);
                console.log(`Session ${id} resized to ${cols}x${rows}`);
                break;
            }
            case 'status': {
                rejectUnknownFlags(args.slice(1), 'status');
                const result = await (0, client_1.request)('status', {}, globalTimeout);
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
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if ((0, client_1.isRpcTimeout)(err)) {
            writeMeta({ status: 'still_running', error: 'rpc_timeout' });
            console.error('Error: RPC timed out. If this was exec, the command was already sent — do not resend. Use: pty-bridge read <id> --from-exec');
            process.exit(0);
        }
        console.error(`Error: ${msg}`);
        process.exit(1);
    }
}
main();
