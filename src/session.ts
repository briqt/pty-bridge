import { Terminal } from '@xterm/headless';
import type { IPty } from '@lydell/node-pty';

let ptyModule: typeof import('@lydell/node-pty');

export async function loadPty(): Promise<void> {
  try {
    ptyModule = await import('@lydell/node-pty');
  } catch {
    try {
      ptyModule = await import('node-pty' as string) as typeof import('@lydell/node-pty');
    } catch {
      throw new Error('Neither @lydell/node-pty nor node-pty is available');
    }
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export interface SessionInfo {
  id: string;
  command: string;
  pid: number;
  isAlive: boolean;
  cols: number;
  rows: number;
  startedAt: string;
  lastActivityAt: string;
  bufferLines: number;
  exitCode?: number;
  uptime: string;
}

export class Session {
  readonly id: string;
  readonly command: string;
  readonly startedAt: string;
  private _lastActivityAt: string;
  private pty: IPty;
  private terminal: Terminal;
  private _isAlive = true;
  private _exitCode: number | undefined;
  private cols: number;
  private rows: number;
  private lastReadLine = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(id: string, command: string, args: string[], cols: number, rows: number, cwd: string, env?: Record<string, string>, keepaliveInterval?: number) {
    this.id = id;
    this.command = command;
    this.cols = cols;
    this.rows = rows;
    this.startedAt = new Date().toISOString();
    this._lastActivityAt = this.startedAt;

    this.pty = ptyModule.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, ...env, TERM: 'xterm-256color' } as Record<string, string>,
      handleFlowControl: true,
    });

    this.terminal = new Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: 50000,
    });

    this.pty.onData((data: string) => {
      this.terminal.write(data);
    });

    this.pty.onExit(({ exitCode }: { exitCode: number }) => {
      this._isAlive = false;
      this._exitCode = exitCode;
      if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    });

    if (keepaliveInterval && keepaliveInterval > 0) {
      this.keepaliveTimer = setInterval(() => {
        if (this._isAlive) this.pty.write('');
      }, keepaliveInterval * 1000);
    }
  }

  get pid(): number { return this.pty.pid; }
  get isAlive(): boolean { return this._isAlive; }
  get exitCode(): number | undefined { return this._exitCode; }
  get lastActivityAt(): string { return this._lastActivityAt; }

  write(data: string): void {
    if (!this._isAlive) throw new Error('Session is not alive');
    this._lastActivityAt = new Date().toISOString();
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
    this.terminal.resize(cols, rows);
  }

  private findLastContentLine(): number {
    const buf = this.terminal.buffer.active;
    for (let i = buf.length - 1; i >= 0; i--) {
      const line = buf.getLine(i);
      if (line && line.translateToString(true).trim() !== '') return i;
    }
    return -1;
  }

  // Incremental read: returns lines from `since` to last content line, advances cursor.
  read(since?: number): string {
    this._lastActivityAt = new Date().toISOString();
    const buf = this.terminal.buffer.active;
    const fromLine = since ?? this.lastReadLine;
    const lastContentLine = this.findLastContentLine();
    if (lastContentLine < fromLine) {
      this.lastReadLine = lastContentLine + 1;
      return '';
    }
    const lines: string[] = [];
    for (let i = fromLine; i <= lastContentLine; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    this.lastReadLine = lastContentLine + 1;
    return lines.join('\n');
  }

  // Read from a specific line without advancing the incremental cursor.
  readFrom(startLine: number): string {
    const buf = this.terminal.buffer.active;
    const lastContentLine = this.findLastContentLine();
    if (lastContentLine < startLine) return '';
    const lines: string[] = [];
    for (let i = startLine; i <= lastContentLine; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  }

  // Full buffer read (no cursor side effects).
  readFull(): string {
    return this.readFrom(0);
  }

  lineCount(): number {
    return this.findLastContentLine() + 1;
  }

  bufferLineCount(): number {
    return this.lineCount();
  }

  kill(): void {
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this._isAlive) this.pty.kill();
    this.terminal.dispose();
  }

  info(): SessionInfo {
    const uptimeMs = Date.now() - new Date(this.startedAt).getTime();
    return {
      id: this.id,
      command: this.command,
      pid: this.pid,
      isAlive: this._isAlive,
      cols: this.cols,
      rows: this.rows,
      startedAt: this.startedAt,
      lastActivityAt: this._lastActivityAt,
      bufferLines: this.bufferLineCount(),
      exitCode: this._exitCode,
      uptime: formatUptime(uptimeMs),
    };
  }
}
