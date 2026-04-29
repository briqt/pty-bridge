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

export interface StartParams {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env?: Record<string, string>;
  keepaliveInterval?: number;
  wait?: number;
}

export interface ReadParams {
  sessionId: string;
  since?: number;
}

export interface WriteParams {
  sessionId: string;
  input: string;
}

export interface SendKeyParams {
  sessionId: string;
  key: string;
}

export interface KillParams {
  sessionId: string;
}

export interface ResizeParams {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface ExecParams {
  sessionId: string;
  command: string;
  waitMs: number;
}

export interface WaitForParams {
  sessionId: string;
  pattern: string;
  timeoutMs: number;
}

export const SOCKET_PATH = `/tmp/pty-bridge-${process.getuid?.() ?? 0}.sock`;
export const IDLE_TIMEOUT_MS = 300_000;

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
