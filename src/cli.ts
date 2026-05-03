#!/usr/bin/env node

import { request } from './client';

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`pty-bridge — manage interactive terminal sessions

Usage:
  pty-bridge start <command> [args...]                Start a PTY session
  pty-bridge read <id> [--full] [--buffer <type>]     Read terminal output (incremental by default)
  pty-bridge write <id> <input>                       Send input (or pipe via stdin)
  pty-bridge exec <id> <command> [--wait <ms>]        Execute command and return new output
                                [--wait-for-idle <ms>]
  pty-bridge sendkey <id> <key>                       Send special key (ctrl-c, enter, tab, up, etc.)
  pty-bridge wait-for <id> <pattern> [--timeout <s>]  Block until pattern appears in output
  pty-bridge snapshot <id>                            Capture current visible screen
  pty-bridge list                                     List active sessions
  pty-bridge kill <id>                                Terminate a session
  pty-bridge resize <id> <cols> <rows>                Resize terminal
  pty-bridge status                                   Show daemon status

Start options:
  --keepalive <secs>   Send keepalive to PTY every N seconds
  --wait <ms>          Initial wait before returning output (default: 500)

Read options:
  --buffer <type>      Buffer to read from: active (default), normal, or alternate

Exec options:
  --wait-for-idle <ms> Wait for output to stabilize (poll interval) before returning`);
  process.exit(command ? 1 : 0);
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
  const rest = argList.filter((_, i) => i !== idx && i !== idx + 1);
  return { value, rest };
}

async function main(): Promise<void> {
  if (!command || command === '--help' || command === '-h') usage();

  try {
    switch (command) {
      case 'start': {
        const cmd = args[1];
        if (!cmd) { console.error('Error: command required'); usage(); }
        let cmdArgs = args.slice(2);
        const ka = parseFlag(cmdArgs, '--keepalive');
        cmdArgs = ka.rest;
        const w = parseFlag(cmdArgs, '--wait');
        cmdArgs = w.rest;
        const keepaliveInterval = ka.value ? parseInt(ka.value, 10) : undefined;
        const wait = w.value ? parseInt(w.value, 10) : undefined;
        const result = await request('start', {
          command: cmd,
          args: cmdArgs,
          cols: parseInt(process.env.COLUMNS || '120', 10),
          rows: parseInt(process.env.LINES || '40', 10),
          cwd: process.cwd(),
          ...(keepaliveInterval ? { keepaliveInterval } : {}),
          ...(wait !== undefined && !isNaN(wait) ? { wait } : {}),
        }) as { sessionId: string; output: string };
        console.log(`Session: ${result.sessionId}`);
        if (result.output) console.log(result.output);
        break;
      }

      case 'read': {
        const id = args[1];
        if (!id) { console.error('Error: session id required'); usage(); }
        let readArgs = args.slice(2);
        const full = readArgs.includes('--full');
        readArgs = readArgs.filter(a => a !== '--full');
        const bufFlag = parseFlag(readArgs, '--buffer');
        readArgs = bufFlag.rest;
        const buf = bufFlag.value as 'active' | 'normal' | 'alternate' | undefined;
        const params: Record<string, unknown> = { sessionId: id };
        if (full) params.since = 0;
        if (buf) params.buffer = buf;
        const result = await request('read', params) as { output: string; isAlive: boolean; exitCode?: number; totalLines: number; bufferType?: string };
        console.log(result.output);
        process.stderr.write(`[lines=${result.totalLines} alive=${result.isAlive} buffer=${result.bufferType ?? '?'}${result.exitCode !== undefined ? ` exitCode=${result.exitCode}` : ''}]\n`);
        break;
      }

      case 'write': {
        const id = args[1];
        if (!id) { console.error('Error: session id required'); usage(); }
        const useStdin = args.includes('--stdin');
        const textArgs = args.slice(2).filter(a => a !== '--stdin');
        let input: string;
        if (useStdin) {
          input = await readStdin();
        } else if (textArgs.length > 0) {
          input = textArgs.join(' ');
        } else {
          console.error('Error: input required (as argument or --stdin)');
          usage();
          return;
        }
        if (!input) { console.error('Error: empty input'); process.exit(1); }
        await request('write', { sessionId: id, input });
        break;
      }

      case 'exec': {
        const id = args[1];
        if (!id) { console.error('Error: session id required'); usage(); }
        let execArgs = args.slice(2);
        const w = parseFlag(execArgs, '--wait');
        execArgs = w.rest;
        const idle = parseFlag(execArgs, '--wait-for-idle');
        execArgs = idle.rest;
        const waitMs = w.value ? parseInt(w.value, 10) : (idle.value ? 5000 : 200);
        const waitForIdle = idle.value ? parseInt(idle.value, 10) : undefined;
        if (execArgs.length === 0) { console.error('Error: command required'); usage(); }
        const cmd = execArgs.join(' ');
        const result = await request('exec', { sessionId: id, command: cmd, waitMs, ...(waitForIdle ? { waitForIdle } : {}) }) as { output: string; isAlive: boolean; exitCode?: number };
        console.log(result.output);
        if (!result.isAlive) {
          console.log(`\n[Process exited with code ${result.exitCode ?? 'unknown'}]`);
        }
        break;
      }

      case 'sendkey': {
        const id = args[1];
        const key = args[2];
        if (!id || !key) { console.error('Error: session id and key required'); usage(); }
        await request('sendkey', { sessionId: id, key });
        break;
      }

      case 'wait-for': {
        const id = args[1];
        const pattern = args[2];
        if (!id || !pattern) { console.error('Error: session id and pattern required'); usage(); }
        let wfArgs = args.slice(3);
        const t = parseFlag(wfArgs, '--timeout');
        const timeoutSec = t.value ? parseInt(t.value, 10) : 30;
        if (isNaN(timeoutSec) || timeoutSec <= 0) { console.error('Error: invalid timeout value'); process.exit(1); }
        const timeoutMs = timeoutSec * 1000;
        const socketTimeout = timeoutMs + 5000;
        const result = await request('waitFor', { sessionId: id, pattern, timeoutMs }, socketTimeout) as { matched: boolean; output: string; error?: string };
        if (result.output) console.log(result.output);
        if (!result.matched) {
          console.error(result.error || `Timeout waiting for pattern: ${pattern}`);
          process.exit(1);
        }
        break;
      }

      case 'snapshot': {
        const id = args[1];
        if (!id) { console.error('Error: session id required'); usage(); }
        const result = await request('snapshot', { sessionId: id }) as { success: boolean; lines: string[]; cursorX: number; cursorY: number; bufferType: string; cols: number; rows: number };
        console.log(`[buffer=${result.bufferType}  cursor=${result.cursorX},${result.cursorY}  size=${result.cols}x${result.rows}]`);
        console.log(result.lines.join('\n'));
        break;
      }

      case 'list': {
        const result = await request('list') as { sessions: Array<{ id: string; command: string; pid: number; isAlive: boolean; uptime: string; bufferLines: number; bufferType: string; lastActivityAt: string }> };
        if (result.sessions.length === 0) {
          console.log('No active sessions');
        } else {
          for (const s of result.sessions) {
            const status = s.isAlive ? 'alive' : 'dead';
            console.log(`${s.id}  ${s.command}  pid=${s.pid}  ${status}  buffer=${s.bufferType}  uptime=${s.uptime}  lines=${s.bufferLines}  lastActivity=${s.lastActivityAt}`);
          }
        }
        break;
      }

      case 'kill': {
        const id = args[1];
        if (!id) { console.error('Error: session id required'); usage(); }
        await request('kill', { sessionId: id });
        console.log(`Session ${id} killed`);
        break;
      }

      case 'resize': {
        const id = args[1];
        const cols = parseInt(args[2], 10);
        const rows = parseInt(args[3], 10);
        if (!id || isNaN(cols) || isNaN(rows)) {
          console.error('Error: session id, cols, and rows required');
          usage();
        }
        await request('resize', { sessionId: id, cols, rows });
        console.log(`Session ${id} resized to ${cols}x${rows}`);
        break;
      }

      case 'status': {
        const result = await request('status') as { daemonStartedAt: string; pid: number; activeSessions: number; totalSessions: number; memoryUsageMB: number };
        console.log(`Daemon PID:        ${result.pid}`);
        console.log(`Started at:        ${result.daemonStartedAt}`);
        console.log(`Active sessions:   ${result.activeSessions}`);
        console.log(`Total sessions:    ${result.totalSessions}`);
        console.log(`Memory usage:      ${result.memoryUsageMB} MB`);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        usage();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

main();
