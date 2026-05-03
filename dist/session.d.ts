export declare function loadPty(): Promise<void>;
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
}
export interface SnapshotData {
    lines: string[];
    cursorX: number;
    cursorY: number;
    bufferType: string;
    cols: number;
    rows: number;
}
export declare class Session {
    readonly id: string;
    readonly command: string;
    readonly startedAt: string;
    private _lastActivityAt;
    private pty;
    private terminal;
    private _isAlive;
    private _exitCode;
    private cols;
    private rows;
    private lastReadLineNormal;
    private lastReadLineAlt;
    private lastBufferType;
    private keepaliveTimer;
    constructor(id: string, command: string, args: string[], cols: number, rows: number, cwd: string, env?: Record<string, string>, keepaliveInterval?: number);
    get pid(): number;
    get isAlive(): boolean;
    get exitCode(): number | undefined;
    get lastActivityAt(): string;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    private getBuffer;
    private findLastContentLine;
    activeBufferType(): string;
    snapshot(): SnapshotData;
    read(since?: number, buffer?: 'active' | 'normal' | 'alternate'): string;
    readFrom(startLine: number, buffer?: 'active' | 'normal' | 'alternate'): string;
    readFull(buffer?: 'active' | 'normal' | 'alternate'): string;
    lineCount(): number;
    bufferLineCount(): number;
    kill(): void;
    info(): SessionInfo;
}
