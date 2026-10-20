import { Terminal } from '@xterm/headless';
import type { IPty } from '@lydell/node-pty';
import type { IBuffer } from '@xterm/headless';
import { RAW_BUFFER_CAP, DEFAULT_MAX_BYTES, truncateUtf8 } from './protocol';
import { RawOutputBuffer, renderedCursor } from './output';

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
  bufferType: 'normal' | 'alternate';
  owner: string;
  lastExecStartLine: number;
}

export interface SnapshotData {
  lines: string[];
  cursorX: number;
  cursorY: number;
  bufferType: string;
  cols: number;
  rows: number;
}

export class Session {
  readonly id: string;
  readonly command: string;
  readonly startedAt: string;
  readonly owner: string;
  lastExecStartLine = 0;
  lastExecStartRaw = 0;
  private _lastActivityAt: string;
  private pty: IPty;
  private terminal: Terminal;
  private _isAlive = true;
  private _exitCode: number | undefined;
  private cols: number;
  private rows: number;
  private lastReadLineNormal = 0;
  private lastReadLineAlt = 0;
  private lastBufferType: 'normal' | 'alternate' = 'normal';
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private rawOutput = new RawOutputBuffer(RAW_BUFFER_CAP);
  private readColumns = { normal: 0, alternate: 0 };

  constructor(
    id: string,
    command: string,
    args: string[],
    cols: number,
    rows: number,
    cwd: string,
    env?: Record<string, string>,
    keepaliveInterval?: number,
    owner = '',
  ) {
    this.id = id;
    this.command = command;
    this.owner = owner;
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
      this.appendRaw(data);
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
  get rawLength(): number { return this.rawOutput.end; }

  private appendRaw(data: string): void { this.rawOutput.append(data); }

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

  markExecStart(): void {
    this.lastExecStartLine = this.lineCount();
    this.lastExecStartRaw = this.rawOutput.end;
  }

  private getBuffer(which?: 'active' | 'normal' | 'alternate'): IBuffer {
    if (!which || which === 'active') return this.terminal.buffer.active;
    return which === 'normal' ? this.terminal.buffer.normal : this.terminal.buffer.alternate;
  }

  private findLastContentLine(buf?: IBuffer): number {
    const b = buf ?? this.terminal.buffer.active;
    for (let i = b.length - 1; i >= 0; i--) {
      const line = b.getLine(i);
      if (line && line.translateToString(true).trim() !== '') return i;
    }
    return -1;
  }

  activeBufferType(): string {
    return this.terminal.buffer.active.type;
  }

  snapshot(): SnapshotData {
    const buf = this.terminal.buffer.active;
    const startRow = buf.viewportY;
    const collected: string[] = [];
    for (let i = 0; i < this.rows; i++) {
      const line = buf.getLine(startRow + i);
      collected.push(line ? line.translateToString(true) : '');
    }
    return {
      lines: collected,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
      bufferType: buf.type,
      cols: this.cols,
      rows: this.rows,
    };
  }

  incrementalCursor(buffer?: 'active' | 'normal' | 'alternate'): number {
    const buf = this.getBuffer(buffer);
    const currentType = buf.type as 'normal' | 'alternate';
    return currentType === 'normal' ? this.lastReadLineNormal : this.lastReadLineAlt;
  }

  // Incremental read: returns lines from `since` to last content line, advances cursor.
  read(since?: number, buffer?: 'active' | 'normal' | 'alternate'): string {
    this._lastActivityAt = new Date().toISOString();
    const buf = this.getBuffer(buffer);
    const currentType = buf.type as 'normal' | 'alternate';

    if ((!buffer || buffer === 'active') && since === undefined) {
      if (currentType !== this.lastBufferType) {
        if (currentType === 'normal') this.lastReadLineNormal = 0;
        else this.lastReadLineAlt = 0;
        this.lastBufferType = currentType;
      }
    }

    const cursor = currentType === 'normal' ? this.lastReadLineNormal : this.lastReadLineAlt;
    const fromLine = since ?? cursor;
    const lastContentLine = this.findLastContentLine(buf);
    if (lastContentLine < fromLine) {
      if (since === undefined && (!buffer || buffer === 'active')) {
        if (currentType === 'normal') this.lastReadLineNormal = lastContentLine + 1;
        else this.lastReadLineAlt = lastContentLine + 1;
      }
      return '';
    }
    const lines: string[] = [];
    for (let i = fromLine; i <= lastContentLine; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    if (since === undefined && (!buffer || buffer === 'active')) {
      if (currentType === 'normal') this.lastReadLineNormal = lastContentLine + 1;
      else this.lastReadLineAlt = lastContentLine + 1;
    }
    return lines.join('\n');
  }

  readFrom(startLine: number, buffer?: 'active' | 'normal' | 'alternate'): string {
    const buf = this.getBuffer(buffer);
    const lastContentLine = this.findLastContentLine(buf);
    if (lastContentLine < startLine) return '';
    const lines: string[] = [];
    for (let i = startLine; i <= lastContentLine; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  }

  readLastLines(n: number, buffer?: 'active' | 'normal' | 'alternate'): string {
    if (n <= 0) return '';
    const buf = this.getBuffer(buffer);
    const last = this.findLastContentLine(buf);
    if (last < 0) return '';
    return this.readFrom(Math.max(0, last - n + 1), buffer);
  }

  readFull(buffer?: 'active' | 'normal' | 'alternate'): string {
    return this.readFrom(0, buffer);
  }

  readRaw(opts: { since?: number; last?: number; fromLastExec?: boolean; advance?: boolean; maxBytes?: number } = {}) {
    return this.rawOutput.read({
      ...opts,
      since: opts.fromLastExec ? this.lastExecStartRaw : opts.since,
    });
  }

  readRendered(opts: { since?: number; column?: number; last?: number; fromLastExec?: boolean; maxBytes?: number; buffer?: 'active' | 'normal' | 'alternate' } = {}) {
    const buf = this.getBuffer(opts.buffer);
    const type = buf.type as 'normal' | 'alternate';
    const incremental = opts.since == null && opts.last == null && !opts.fromLastExec;
    if (incremental && type !== this.lastBufferType) {
      if (type === 'normal') this.lastReadLineNormal = 0;
      else this.lastReadLineAlt = 0;
      this.readColumns[type] = 0;
      this.lastBufferType = type;
    }
    const end = this.findLastContentLine(buf) + 1;
    const start = opts.fromLastExec ? this.lastExecStartLine
      : opts.last != null ? Math.max(0, end - opts.last)
      : opts.since ?? this.incrementalCursor(opts.buffer);
    const column = opts.column ?? (incremental ? this.readColumns[type] : 0);
    const text = Buffer.from(this.readFrom(start, opts.buffer), 'utf8').subarray(column).toString('utf8');
    const chunk = truncateUtf8(text, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    const cursor = chunk.truncated ? renderedCursor(start, chunk.output, column) : end;
    if (incremental) {
      const [line, col = '0'] = String(cursor).split(':');
      if (type === 'normal') this.lastReadLineNormal = Number(line);
      else this.lastReadLineAlt = Number(line);
      this.readColumns[type] = Number(col);
    }
    return { ...chunk, startCursor: column ? `${start}:${column}` : start, cursor };
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

  persistMeta(): { id: string; command: string; pid: number; owner: string; startedAt: string } {
    return {
      id: this.id,
      command: this.command,
      pid: this.pid,
      owner: this.owner,
      startedAt: this.startedAt,
    };
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
      bufferType: this.terminal.buffer.active.type as 'normal' | 'alternate',
      owner: this.owner,
      lastExecStartLine: this.lastExecStartLine,
    };
  }
}
