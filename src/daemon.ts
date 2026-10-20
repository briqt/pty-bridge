import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { StringDecoder } from 'string_decoder';
import { Session, loadPty } from './session';
import { renderedCursor } from './output';
const VERSION: string = require('../package.json').version;
import {
  getSocketPath,
  getStatePath,
  IDLE_TIMEOUT_MS,
  KEY_MAP,
  DEFAULT_MAX_BYTES,
  WAIT_FOR_LOOKBACK_LINES,
  truncateUtf8,
} from './protocol';
import type {
  Request,
  Response,
  StartParams,
  ReadParams,
  WriteParams,
  SendKeyParams,
  KillParams,
  ResizeParams,
  ExecParams,
  WaitForParams,
  SnapshotParams,
  PeekExecParams,
  AuthParams,
  LostSessionInfo,
  PersistState,
  OpStatus,
} from './protocol';

const sessions = new Map<string, Session>();
let idleTimer: NodeJS.Timeout | null = null;
const daemonStartedAt = new Date().toISOString();
let totalSessionCount = 0;
let lastRestartAt: string | undefined;
let lostSessions: LostSessionInfo[] = [];

function genId(): string {
  return crypto.randomBytes(4).toString('hex');
}

function hasAliveSessions(): boolean {
  for (const session of sessions.values()) {
    if (session.isAlive) return true;
  }
  return false;
}

function persistState(cleanShutdown = false): void {
  const state: PersistState = {
    daemonPid: process.pid,
    daemonStartedAt,
    cleanShutdown,
    lastRestartAt,
    sessions: cleanShutdown ? [] : Array.from(sessions.values()).map(s => s.persistMeta()),
    lostSessions: cleanShutdown ? [] : lostSessions.slice(0, 50),
  };
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify(state));
  } catch {
    // Persistence is best-effort; never crash the daemon for it.
  }
}

function recoverState(): void {
  let prev: PersistState | undefined;
  try {
    prev = JSON.parse(fs.readFileSync(getStatePath(), 'utf8')) as PersistState;
  } catch {
    return;
  }
  if (!prev) return;
  if (!prev.cleanShutdown && Array.isArray(prev.sessions) && prev.sessions.length > 0) {
    const lostAt = new Date().toISOString();
    lastRestartAt = lostAt;
    const newlyLost: LostSessionInfo[] = prev.sessions.map(s => ({
      id: s.id,
      command: s.command,
      pid: s.pid,
      owner: s.owner || '',
      startedAt: s.startedAt,
      lostAt,
    }));
    lostSessions = [...newlyLost, ...(prev.lostSessions || [])].slice(0, 50);
  } else if (Array.isArray(prev.lostSessions)) {
    lostSessions = prev.lostSessions.slice(0, 50);
    lastRestartAt = prev.lastRestartAt;
  }
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!hasAliveSessions()) {
    idleTimer = setTimeout(() => {
      if (!hasAliveSessions()) {
        cleanup();
        process.exit(0);
      }
    }, IDLE_TIMEOUT_MS);
  }
}

function cleanup(): void {
  for (const session of sessions.values()) {
    try { session.kill(); } catch {}
  }
  sessions.clear();
  persistState(true);
  try { fs.unlinkSync(getSocketPath()); } catch {}
}

function getSession(id: string): Session {
  const session = sessions.get(id);
  if (!session) {
    const available = Array.from(sessions.keys());
    const hint = available.length > 0
      ? ` Available sessions: ${available.join(', ')}`
      : ' No active sessions.';
    const lostHint = lostSessions.length > 0
      ? ` Daemon restarted at ${lastRestartAt ?? 'unknown'}; ${lostSessions.length} session(s) lost.`
      : '';
    throw new Error(`Session not found: ${id}.${hint}${lostHint}`);
  }
  return session;
}

function assertOwner(session: Session, auth: AuthParams | undefined, action: string): void {
  if (auth?.force) return;
  if (!session.owner) return;
  const caller = auth?.owner || '';
  if (session.owner !== caller) {
    throw new Error(
      `Session ${session.id} is owned by '${session.owner}', caller is '${caller || 'unset'}'. Use --owner '${session.owner}' only for your own session; --force requires an explicit takeover.`,
    );
  }
}

function maxBytesOf(value: number | undefined): number {
  return value === undefined ? DEFAULT_MAX_BYTES : value;
}

function wrapOutput(output: string, maxBytes: number, extra: Record<string, unknown> = {}) {
  const trunc = truncateUtf8(output, maxBytes);
  return {
    output: trunc.output,
    truncated: trunc.truncated,
    totalBytes: trunc.totalBytes,
    returnedBytes: trunc.returnedBytes,
    ...extra,
  };
}


async function waitForMatch(
  session: Session,
  startLine: number,
  matches: (output: string) => boolean,
  timeoutMs: number,
): Promise<{ matched: boolean; output: string }> {
  const existing = session.readFrom(startLine);
  if (matches(existing)) return { matched: true, output: existing };
  return new Promise((resolve) => {
    const startTime = Date.now();
    const timer = setInterval(() => {
      const content = session.readFrom(startLine);
      if (matches(content)) {
        clearInterval(timer);
        resolve({ matched: true, output: content });
      } else if (Date.now() - startTime >= timeoutMs) {
        clearInterval(timer);
        resolve({ matched: false, output: content });
      }
    }, 100);
  });
}

function stripSentinel(output: string, token: string): { output: string; exitCode?: number } {
  const marker = `PTYBRIDGE_DONE_${token}:`;
  const match = output.match(new RegExp(`${marker}(\\d+)`));
  const exitCode = match ? parseInt(match[1], 10) : undefined;
  const cleaned = output
    .split('\n')
    .filter(line => !line.includes(marker))
    .join('\n');
  return { output: cleaned, exitCode };
}

async function handleRequest(req: Request): Promise<Response> {
  try {
    const result = await dispatch(req);
    return { id: req.id, result };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id: req.id, error: msg };
  }
}

async function dispatch(req: Request): Promise<unknown> {
  switch (req.method) {
    case 'start': {
      const p = req.params as unknown as StartParams;
      const id = genId();
      const session = new Session(
        id,
        p.command,
        p.args || [],
        p.cols || 120,
        p.rows || 40,
        p.cwd || process.cwd(),
        p.env,
        p.keepaliveInterval,
        p.owner || '',
      );
      sessions.set(id, session);
      totalSessionCount++;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      persistState();
      const wait = typeof p.wait === 'number' && p.wait >= 0 ? p.wait : 500;
      await new Promise(r => setTimeout(r, wait));
      const startCursor = 0;
      const output = session.read();
      return {
        sessionId: id,
        owner: session.owner,
        output,
        status: session.isAlive ? 'still_running' : (session.exitCode === 0 ? 'done' : 'failed'),
        startCursor,
        cursor: session.lineCount(),
        isAlive: session.isAlive,
        exitCode: session.exitCode,
      };
    }
    case 'read': {
      const p = req.params as unknown as ReadParams;
      const session = getSession(p.sessionId);
      const mb = maxBytesOf(p.maxBytes);
      if (p.raw) {
        const advance = p.since == null && p.last == null && !p.fromLastExec;
        const raw = session.readRaw({ since: p.since, last: p.last, fromLastExec: p.fromLastExec, advance, maxBytes: mb });
        return { ...raw, isAlive: session.isAlive, exitCode: session.exitCode,
          totalLines: session.bufferLineCount(), bufferType: session.activeBufferType(), raw: true };
      }
      return { ...session.readRendered({ ...p, maxBytes: mb }), isAlive: session.isAlive,
        exitCode: session.exitCode, totalLines: session.bufferLineCount(), bufferType: session.activeBufferType(), raw: false };
    }
    case 'write': {
      const p = req.params as unknown as WriteParams;
      const session = getSession(p.sessionId);
      assertOwner(session, p, 'write');
      session.write(p.input);
      persistState();
      return { ok: true };
    }
    case 'sendkey': {
      const p = req.params as unknown as SendKeyParams;
      const session = getSession(p.sessionId);
      assertOwner(session, p, 'sendkey');
      const sequence = KEY_MAP[p.key.toLowerCase()];
      if (!sequence) throw new Error(`Unknown key: ${p.key}. Available: ${Object.keys(KEY_MAP).join(', ')}`);
      session.write(sequence);
      persistState();
      return { ok: true };
    }
    case 'exec': {
      const p = req.params as unknown as ExecParams;
      const session = getSession(p.sessionId);
      assertOwner(session, p, 'exec');
      const mb = maxBytesOf(p.maxBytes);
      session.markExecStart();
      const startLine = session.lastExecStartLine;
      if (p.waitExit) {
        const token = crypto.randomBytes(4).toString('hex');
        const marker = `PTYBRIDGE_DONE_${token}:`;
        session.write(`${p.command}; echo ${marker}$?\r`);
        const doneRe = new RegExp(`${marker}\\d+`);
        const waited = await waitForMatch(session, startLine, (s) => doneRe.test(s), p.waitMs || 30000);
        const stripped = stripSentinel(waited.output, token);
        let status: OpStatus;
        if (waited.matched) status = stripped.exitCode === 0 ? 'done' : 'failed';
        else status = session.isAlive ? 'still_running' : 'failed';
        const trunc = wrapOutput(stripped.output, mb);
        persistState();
        return {
          ...trunc,
          status,
          isAlive: session.isAlive,
          exitCode: waited.matched ? stripped.exitCode : session.exitCode,
          startCursor: startLine,
          cursor: trunc.truncated ? renderedCursor(startLine, trunc.output) : session.lineCount(),
        };
      }
      session.write(p.command + '\r');
      if (p.waitForIdle && p.waitForIdle > 0) {
        const maxWait = p.waitMs || 5000;
        const interval = p.waitForIdle;
        const deadline = Date.now() + maxWait;
        let prev = '';
        await new Promise<void>(resolve => {
          const check = () => {
            const current = session.readFrom(startLine);
            if (current === prev && current.length > 0) { resolve(); return; }
            prev = current;
            if (Date.now() + interval >= deadline) { resolve(); return; }
            setTimeout(check, interval);
          };
          setTimeout(check, interval);
        });
      } else {
        await new Promise(r => setTimeout(r, p.waitMs || 200));
      }
      const output = session.readFrom(startLine);
      let status: OpStatus;
      if (!session.isAlive) status = session.exitCode === 0 ? 'done' : 'failed';
      else status = 'still_running';
      const trunc = wrapOutput(output, mb);
      persistState();
      return {
        ...trunc,
        status,
        isAlive: session.isAlive,
        exitCode: session.exitCode,
        startCursor: startLine,
        cursor: trunc.truncated ? renderedCursor(startLine, trunc.output) : session.lineCount(),
      };
    }
    case 'peekExec': {
      const p = req.params as unknown as PeekExecParams;
      const session = getSession(p.sessionId);
      const mb = maxBytesOf(p.maxBytes);
      const startLine = session.lastExecStartLine;
      const trunc = wrapOutput(session.readFrom(startLine), mb);
      return {
        ...trunc,
        status: session.isAlive ? 'still_running' : (session.exitCode === 0 ? 'done' : 'failed'),
        isAlive: session.isAlive,
        exitCode: session.exitCode,
        startCursor: startLine,
        cursor: trunc.truncated ? renderedCursor(startLine, trunc.output) : session.lineCount(),
      };
    }
    case 'waitFor': {
      const p = req.params as unknown as WaitForParams;
      const session = getSession(p.sessionId);
      const lineCount = session.lineCount();
      let fromLine: number;
      if (p.fromNow) fromLine = lineCount;
      else if (typeof p.from === 'number') fromLine = p.from;
      else fromLine = Math.max(0, lineCount - WAIT_FOR_LOOKBACK_LINES);
      const waited = await waitForMatch(session, fromLine, (s) => s.includes(p.pattern), p.timeoutMs);
      if (!waited.matched) {
        return {
          matched: false,
          output: waited.output,
          error: `Timeout after ${p.timeoutMs}ms waiting for pattern: ${p.pattern}`,
          startCursor: fromLine,
          cursor: session.lineCount(),
        };
      }
      return {
        matched: true,
        output: waited.output,
        startCursor: fromLine,
        cursor: session.lineCount(),
      };
    }
    case 'snapshot': {
      const p = req.params as unknown as SnapshotParams;
      const session = getSession(p.sessionId);
      return { success: true, ...session.snapshot() };
    }
    case 'list': {
      return {
        sessions: Array.from(sessions.values()).map(s => s.info()),
        lostSessions,
        lastRestartAt,
        lostCount: lostSessions.length,
      };
    }
    case 'kill': {
      const p = req.params as unknown as KillParams;
      const session = getSession(p.sessionId);
      assertOwner(session, p, 'kill');
      session.kill();
      sessions.delete(p.sessionId);
      persistState();
      resetIdleTimer();
      return { ok: true };
    }
    case 'resize': {
      const p = req.params as unknown as ResizeParams;
      const session = getSession(p.sessionId);
      assertOwner(session, p, 'resize');
      session.resize(p.cols, p.rows);
      return { ok: true };
    }
    case 'status': {
      const alive = Array.from(sessions.values()).filter(s => s.isAlive).length;
      return {
        version: VERSION,
        daemonStartedAt,
        pid: process.pid,
        activeSessions: alive,
        totalSessions: totalSessionCount,
        memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100,
        lastRestartAt,
        lostCount: lostSessions.length,
        lostSessions,
      };
    }
    case 'ping':
      return { ok: true };
    default:
      throw new Error(`Unknown method: ${req.method}`);
  }
}

async function main(): Promise<void> {
  await loadPty();
  recoverState();
  try { fs.unlinkSync(getSocketPath()); } catch {}

  const server = net.createServer((conn) => {
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    conn.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line) as Request;
          handleRequest(req).then((res) => {
            try { conn.write(JSON.stringify(res) + '\n'); } catch {}
          });
        } catch {
          try { conn.write(JSON.stringify({ id: '', error: 'Invalid JSON' }) + '\n'); } catch {}
        }
      }
    });
  });

  server.listen(getSocketPath(), () => {
    try { fs.chmodSync(getSocketPath(), 0o600); } catch {}
    persistState();
    if (process.send) process.send('ready');
    resetIdleTimer();
  });

  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
}

main().catch((err) => {
  process.stderr.write(`Daemon error: ${err}\n`);
  process.exit(1);
});
