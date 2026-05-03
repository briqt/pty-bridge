import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { Session, loadPty } from './session';
import { SOCKET_PATH, IDLE_TIMEOUT_MS, KEY_MAP } from './protocol';
import type { Request, Response, StartParams, ReadParams, WriteParams, SendKeyParams, KillParams, ResizeParams, ExecParams, WaitForParams, SnapshotParams } from './protocol';

const sessions = new Map<string, Session>();
let idleTimer: NodeJS.Timeout | null = null;
const daemonStartedAt = new Date().toISOString();
let totalSessionCount = 0;

function genId(): string {
  return crypto.randomBytes(4).toString('hex');
}

function hasAliveSessions(): boolean {
  for (const session of sessions.values()) {
    if (session.isAlive) return true;
  }
  return false;
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
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
}

function getSession(id: string): Session {
  const session = sessions.get(id);
  if (!session) {
    const available = Array.from(sessions.keys());
    const hint = available.length > 0
      ? ` Available sessions: ${available.join(', ')}`
      : ' No active sessions.';
    throw new Error(`Session not found: ${id}.${hint}`);
  }
  return session;
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
      const session = new Session(id, p.command, p.args || [], p.cols || 120, p.rows || 40, p.cwd || process.cwd(), p.env, p.keepaliveInterval);
      sessions.set(id, session);
      totalSessionCount++;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const wait = typeof p.wait === 'number' && p.wait >= 0 ? p.wait : 500;
      await new Promise(r => setTimeout(r, wait));
      return { sessionId: id, output: session.read() };
    }
    case 'read': {
      const p = req.params as unknown as ReadParams;
      const session = getSession(p.sessionId);
      return {
        output: session.read(p.since, p.buffer),
        isAlive: session.isAlive,
        exitCode: session.exitCode,
        totalLines: session.bufferLineCount(),
        bufferType: session.activeBufferType(),
      };
    }
    case 'write': {
      const p = req.params as unknown as WriteParams;
      const session = getSession(p.sessionId);
      session.write(p.input);
      return { ok: true };
    }
    case 'sendkey': {
      const p = req.params as unknown as SendKeyParams;
      const session = getSession(p.sessionId);
      const sequence = KEY_MAP[p.key.toLowerCase()];
      if (!sequence) throw new Error(`Unknown key: ${p.key}. Available: ${Object.keys(KEY_MAP).join(', ')}`);
      session.write(sequence);
      return { ok: true };
    }
    case 'exec': {
      const p = req.params as unknown as ExecParams;
      const session = getSession(p.sessionId);
      const startLine = session.lineCount();
      session.write(p.command + '\r');
      if (p.waitForIdle && p.waitForIdle > 0) {
        // Smart wait: poll until output stabilizes
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
      return { output: session.readFrom(startLine), isAlive: session.isAlive, exitCode: session.exitCode };
    }
    case 'waitFor': {
      const p = req.params as unknown as WaitForParams;
      const session = getSession(p.sessionId);
      // Check existing content first
      const startLine = session.lineCount();
      const existing = session.readFull();
      if (existing.includes(p.pattern)) {
        return { matched: true, output: '' };
      }
      // Incremental matching: only scan new lines every 200ms
      return new Promise<unknown>((resolve) => {
        const startTime = Date.now();
        const timer = setInterval(() => {
          const newContent = session.readFrom(startLine);
          if (newContent.includes(p.pattern)) {
            clearInterval(timer);
            resolve({ matched: true, output: newContent });
          } else if (Date.now() - startTime >= p.timeoutMs) {
            clearInterval(timer);
            resolve({ matched: false, output: newContent, error: `Timeout after ${p.timeoutMs}ms waiting for pattern: ${p.pattern}` });
          }
        }, 200);
      });
    }
    case 'snapshot': {
      const p = req.params as unknown as SnapshotParams;
      const session = getSession(p.sessionId);
      return { success: true, ...session.snapshot() };
    }
    case 'list': {
      return { sessions: Array.from(sessions.values()).map(s => s.info()) };
    }
    case 'kill': {
      const p = req.params as unknown as KillParams;
      const session = getSession(p.sessionId);
      session.kill();
      sessions.delete(p.sessionId);
      resetIdleTimer();
      return { ok: true };
    }
    case 'resize': {
      const p = req.params as unknown as ResizeParams;
      const session = getSession(p.sessionId);
      session.resize(p.cols, p.rows);
      return { ok: true };
    }
    case 'status': {
      const alive = Array.from(sessions.values()).filter(s => s.isAlive).length;
      return {
        daemonStartedAt,
        pid: process.pid,
        activeSessions: alive,
        totalSessions: totalSessionCount,
        memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100,
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
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  const server = net.createServer((conn) => {
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line) as Request;
          handleRequest(req).then((res) => {
            conn.write(JSON.stringify(res) + '\n');
          });
        } catch {
          conn.write(JSON.stringify({ id: '', error: 'Invalid JSON' }) + '\n');
        }
      }
    });
  });

  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600);
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
