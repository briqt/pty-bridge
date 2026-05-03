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
    buffer?: 'active' | 'normal' | 'alternate';
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
    waitForIdle?: number;
}
export interface WaitForParams {
    sessionId: string;
    pattern: string;
    timeoutMs: number;
}
export interface SnapshotParams {
    sessionId: string;
}
export declare const SOCKET_PATH: string;
export declare const IDLE_TIMEOUT_MS = 300000;
export declare const KEY_MAP: Record<string, string>;
