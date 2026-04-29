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
    private lastReadLine;
    private keepaliveTimer;
    constructor(id: string, command: string, args: string[], cols: number, rows: number, cwd: string, env?: Record<string, string>, keepaliveInterval?: number);
    get pid(): number;
    get isAlive(): boolean;
    get exitCode(): number | undefined;
    get lastActivityAt(): string;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    private findLastContentLine;
    read(since?: number): string;
    readFrom(startLine: number): string;
    readFull(): string;
    lineCount(): number;
    bufferLineCount(): number;
    kill(): void;
    info(): SessionInfo;
}
