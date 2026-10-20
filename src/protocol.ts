import { platform, tmpdir } from 'os';
import { join } from 'path';

export function getSocketPath(): string {
  if (process.env.PTY_BRIDGE_SOCKET) return process.env.PTY_BRIDGE_SOCKET;
  if (platform() === 'win32') {
    const username = process.env.USERNAME || process.env.USER || 'default';
    return `\\\\.\\pipe\\pty-bridge-${username}`;
  }
  return `/tmp/pty-bridge-${process.getuid?.() ?? 0}.sock`;
}

export function getStatePath(): string {
  if (process.env.PTY_BRIDGE_STATE) return process.env.PTY_BRIDGE_STATE;
  const socket = getSocketPath();
  if (platform() === 'win32') {
    const username = process.env.USERNAME || process.env.USER || 'default';
    return join(tmpdir(), `pty-bridge-${username}.state.json`);
  }
  return `${socket}.state.json`;
}

export function getLockPath(): string {
  // Named pipes are endpoints, not filesystem directories. O_CREAT cannot create
  // a startup lock beneath \\.\pipe on Windows.
  return platform() === 'win32' ? `${getStatePath()}.lock` : `${getSocketPath()}.lock`;
}

export function defaultOwner(): string {
  return process.env.PTY_BRIDGE_OWNER || process.env.USER || process.env.USERNAME || 'default';
}

export const SOCKET_PATH = getSocketPath();
export const IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_BYTES = 256_000;
export const RAW_BUFFER_CAP = 8 * 1024 * 1024;
export const WAIT_FOR_LOOKBACK_LINES = 200;
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export type OpStatus = 'done' | 'still_running' | 'failed';

export interface Request {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface Response {
  id: string;
  result?: unknown;
  error?: string;
}

export interface AuthParams {
  owner?: string;
  force?: boolean;
}

export interface StartParams {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env?: Record<string, string>;
  keepaliveInterval?: number;
  wait?: number;
  owner?: string;
}

export interface ReadParams {
  sessionId: string;
  since?: number;
  column?: number;
  last?: number;
  buffer?: 'active' | 'normal' | 'alternate';
  raw?: boolean;
  maxBytes?: number;
  fromLastExec?: boolean;
}

export interface WriteParams extends AuthParams {
  sessionId: string;
  input: string;
}

export interface SendKeyParams extends AuthParams {
  sessionId: string;
  key: string;
}

export interface KillParams extends AuthParams {
  sessionId: string;
}

export interface ResizeParams extends AuthParams {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface ExecParams extends AuthParams {
  sessionId: string;
  command: string;
  waitMs: number;
  waitForIdle?: number;
  waitExit?: boolean;
  maxBytes?: number;
}

export interface WaitForParams {
  sessionId: string;
  pattern: string;
  timeoutMs: number;
  from?: number;
  fromNow?: boolean;
}

export interface SnapshotParams {
  sessionId: string;
}

export interface PeekExecParams {
  sessionId: string;
  maxBytes?: number;
}

export interface LostSessionInfo {
  id: string;
  command: string;
  pid: number;
  owner: string;
  startedAt: string;
  lostAt: string;
}

export interface PersistState {
  daemonPid: number;
  daemonStartedAt: string;
  cleanShutdown: boolean;
  lastRestartAt?: string;
  sessions: Array<{
    id: string;
    command: string;
    pid: number;
    owner: string;
    startedAt: string;
  }>;
  lostSessions: LostSessionInfo[];
}

export function truncateUtf8(text: string, maxBytes: number): {
  output: string;
  truncated: boolean;
  totalBytes: number;
  returnedBytes: number;
} {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (maxBytes <= 0 || totalBytes <= maxBytes) {
    return { output: text, truncated: false, totalBytes, returnedBytes: totalBytes };
  }
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  if (end === 0) throw new Error('max-bytes is too small for the next UTF-8 character; increase it (at least 4 bytes handles any character)');
  const output = bytes.subarray(0, end).toString('utf8');
  return { output, truncated: true, totalBytes, returnedBytes: end };
}

export function rpcTimeoutForWait(waitMs: number, globalTimeout?: number): number {
  if (globalTimeout) return globalTimeout;
  return Math.max(DEFAULT_RPC_TIMEOUT_MS, waitMs + 5_000);
}

export const KEY_MAP: Record<string, string> = {
  'enter': '\r',
  'return': '\r',
  'tab': '\t',
  'escape': '\x1b',
  'esc': '\x1b',
  'space': ' ',
  'backspace': '\x7f',
  'delete': '\x1b[3~',
  'up': '\x1b[A',
  'down': '\x1b[B',
  'right': '\x1b[C',
  'left': '\x1b[D',
  'home': '\x1b[H',
  'end': '\x1b[F',
  'pageup': '\x1b[5~',
  'pagedown': '\x1b[6~',
  'ctrl-a': '\x01',
  'ctrl-b': '\x02',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-e': '\x05',
  'ctrl-f': '\x06',
  'ctrl-g': '\x07',
  'ctrl-h': '\x08',
  'ctrl-i': '\x09',
  'ctrl-j': '\x0a',
  'ctrl-k': '\x0b',
  'ctrl-l': '\x0c',
  'ctrl-m': '\x0d',
  'ctrl-n': '\x0e',
  'ctrl-o': '\x0f',
  'ctrl-p': '\x10',
  'ctrl-q': '\x11',
  'ctrl-r': '\x12',
  'ctrl-s': '\x13',
  'ctrl-t': '\x14',
  'ctrl-u': '\x15',
  'ctrl-v': '\x16',
  'ctrl-w': '\x17',
  'ctrl-x': '\x18',
  'ctrl-y': '\x19',
  'ctrl-z': '\x1a',
  'ctrl-\\': '\x1c',
  'ctrl-]': '\x1d',
};
