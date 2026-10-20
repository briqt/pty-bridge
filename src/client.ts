import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fork } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { getSocketPath, getLockPath, DEFAULT_RPC_TIMEOUT_MS } from './protocol';
import type { Request, Response } from './protocol';

export class RpcTimeoutError extends Error {
  constructor(message = 'Connection timeout') {
    super(message);
    this.name = 'RpcTimeoutError';
  }
}

function sendRequest(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Response> {
  const timeout = timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const socketPath = getSocketPath();
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    const req: Request = { id: crypto.randomBytes(4).toString('hex'), method, params };
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    conn.on('connect', () => {
      conn.write(JSON.stringify(req) + '\n');
    });

    conn.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        try {
          const res = JSON.parse(buffer.slice(0, idx)) as Response;
          conn.end();
          finish(() => resolve(res));
        } catch {
          conn.end();
          finish(() => reject(new Error('Invalid response from daemon')));
        }
      }
    });

    conn.on('error', (err) => finish(() => reject(err)));
    conn.on('timeout', () => {
      conn.destroy();
      finish(() => reject(new RpcTimeoutError()));
    });
    conn.setTimeout(timeout);
  });
}

async function isDaemonRunning(): Promise<boolean> {
  try {
    const res = await sendRequest('ping', {}, 2000);
    return !!res.result;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;

  try { fs.unlinkSync(getSocketPath()); } catch {}

  const daemonScript = path.join(__dirname, 'daemon.js');

  const lockPath = getLockPath();
  let lockFd: number | undefined;
  try {
    lockFd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
  } catch {
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (await isDaemonRunning()) return;
    }
    throw new Error('Daemon failed to start (another process may be starting it)');
  }

  try {
    return await new Promise<void>((resolve, reject) => {
      const child = fork(daemonScript, [], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });

      child.on('message', (msg) => {
        if (msg === 'ready') {
          child.disconnect();
          child.unref();
          resolve();
        }
      });

      child.on('error', reject);

      setTimeout(() => {
        child.disconnect?.();
        child.unref();
        reject(new Error('Daemon failed to start within 5 seconds'));
      }, 5000);
    });
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

export async function request(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
  await ensureDaemon();
  const res = await sendRequest(method, params, timeoutMs);
  if (res.error) throw new Error(res.error);
  return res.result;
}

export function isRpcTimeout(err: unknown): boolean {
  return err instanceof RpcTimeoutError || (err instanceof Error && err.name === 'RpcTimeoutError');
}

/** Probe an existing daemon only: doctor must not start or replace sessions. */
export async function inspectDaemon(): Promise<unknown> {
  try {
    const response = await sendRequest('status', {}, 2000);
    return response.error ? { error: response.error } : response.result;
  } catch { return null; }
}
