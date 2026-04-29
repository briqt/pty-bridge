import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fork } from 'child_process';
import { SOCKET_PATH } from './protocol';
import type { Request, Response } from './protocol';

function sendRequest(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Response> {
  const timeout = timeoutMs ?? parseInt(process.env.PTY_BRIDGE_TIMEOUT || '30000', 10);
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCKET_PATH);
    const req: Request = { id: crypto.randomBytes(4).toString('hex'), method, params };
    let buffer = '';

    conn.on('connect', () => {
      conn.write(JSON.stringify(req) + '\n');
    });

    conn.on('data', (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        try {
          const res = JSON.parse(buffer.slice(0, idx)) as Response;
          conn.end();
          resolve(res);
        } catch {
          conn.end();
          reject(new Error('Invalid response from daemon'));
        }
      }
    });

    conn.on('error', (err) => reject(err));
    conn.on('timeout', () => { conn.destroy(); reject(new Error('Connection timeout')); });
    conn.setTimeout(timeout);
  });
}

async function isDaemonRunning(): Promise<boolean> {
  try {
    const res = await sendRequest('ping');
    return !!res.result;
  } catch {
    return false;
  }
}
async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;

  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  const daemonScript = path.join(__dirname, 'daemon.js');

  return new Promise<void>((resolve, reject) => {
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
}

export async function request(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
  await ensureDaemon();
  const res = await sendRequest(method, params, timeoutMs);
  if (res.error) throw new Error(res.error);
  return res.result;
}
