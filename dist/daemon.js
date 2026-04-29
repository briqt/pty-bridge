"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const net = __importStar(require("net"));
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
const session_1 = require("./session");
const protocol_1 = require("./protocol");
const sessions = new Map();
let idleTimer = null;
const daemonStartedAt = new Date().toISOString();
let totalSessionCount = 0;
function genId() {
    return crypto.randomBytes(4).toString('hex');
}
function hasAliveSessions() {
    for (const session of sessions.values()) {
        if (session.isAlive)
            return true;
    }
    return false;
}
function resetIdleTimer() {
    if (idleTimer)
        clearTimeout(idleTimer);
    idleTimer = null;
    if (!hasAliveSessions()) {
        idleTimer = setTimeout(() => {
            if (!hasAliveSessions()) {
                cleanup();
                process.exit(0);
            }
        }, protocol_1.IDLE_TIMEOUT_MS);
    }
}
function cleanup() {
    for (const session of sessions.values()) {
        try {
            session.kill();
        }
        catch { }
    }
    sessions.clear();
    try {
        fs.unlinkSync(protocol_1.SOCKET_PATH);
    }
    catch { }
}
function getSession(id) {
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
async function handleRequest(req) {
    try {
        const result = await dispatch(req);
        return { id: req.id, result };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { id: req.id, error: msg };
    }
}
async function dispatch(req) {
    switch (req.method) {
        case 'start': {
            const p = req.params;
            const id = genId();
            const session = new session_1.Session(id, p.command, p.args || [], p.cols || 120, p.rows || 40, p.cwd || process.cwd(), p.env, p.keepaliveInterval);
            sessions.set(id, session);
            totalSessionCount++;
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
            const wait = typeof p.wait === 'number' && p.wait >= 0 ? p.wait : 500;
            await new Promise(r => setTimeout(r, wait));
            return { sessionId: id, output: session.read() };
        }
        case 'read': {
            const p = req.params;
            const session = getSession(p.sessionId);
            return { output: session.read(p.since), isAlive: session.isAlive, exitCode: session.exitCode, totalLines: session.bufferLineCount() };
        }
        case 'write': {
            const p = req.params;
            const session = getSession(p.sessionId);
            session.write(p.input);
            return { ok: true };
        }
        case 'sendkey': {
            const p = req.params;
            const session = getSession(p.sessionId);
            const sequence = protocol_1.KEY_MAP[p.key.toLowerCase()];
            if (!sequence)
                throw new Error(`Unknown key: ${p.key}. Available: ${Object.keys(protocol_1.KEY_MAP).join(', ')}`);
            session.write(sequence);
            return { ok: true };
        }
        case 'exec': {
            const p = req.params;
            const session = getSession(p.sessionId);
            const startLine = session.lineCount();
            session.write(p.command + '\r');
            await new Promise(r => setTimeout(r, p.waitMs || 200));
            return { output: session.readFrom(startLine), isAlive: session.isAlive, exitCode: session.exitCode };
        }
        case 'waitFor': {
            const p = req.params;
            const session = getSession(p.sessionId);
            const initialOutput = session.readFull();
            const initialLen = initialOutput.length;
            if (initialOutput.includes(p.pattern)) {
                return { matched: true, output: '' };
            }
            return new Promise((resolve) => {
                const startTime = Date.now();
                const timer = setInterval(() => {
                    const current = session.readFull();
                    const incremental = current.substring(initialLen);
                    if (incremental.includes(p.pattern)) {
                        clearInterval(timer);
                        resolve({ matched: true, output: incremental });
                    }
                    else if (Date.now() - startTime >= p.timeoutMs) {
                        clearInterval(timer);
                        resolve({ matched: false, output: incremental, error: `Timeout after ${p.timeoutMs}ms waiting for pattern: ${p.pattern}` });
                    }
                }, 500);
            });
        }
        case 'list': {
            return { sessions: Array.from(sessions.values()).map(s => s.info()) };
        }
        case 'kill': {
            const p = req.params;
            const session = getSession(p.sessionId);
            session.kill();
            sessions.delete(p.sessionId);
            resetIdleTimer();
            return { ok: true };
        }
        case 'resize': {
            const p = req.params;
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
async function main() {
    await (0, session_1.loadPty)();
    try {
        fs.unlinkSync(protocol_1.SOCKET_PATH);
    }
    catch { }
    const server = net.createServer((conn) => {
        let buffer = '';
        conn.on('data', (chunk) => {
            buffer += chunk.toString();
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (!line.trim())
                    continue;
                try {
                    const req = JSON.parse(line);
                    handleRequest(req).then((res) => {
                        conn.write(JSON.stringify(res) + '\n');
                    });
                }
                catch {
                    conn.write(JSON.stringify({ id: '', error: 'Invalid JSON' }) + '\n');
                }
            }
        });
    });
    server.listen(protocol_1.SOCKET_PATH, () => {
        fs.chmodSync(protocol_1.SOCKET_PATH, 0o600);
        if (process.send)
            process.send('ready');
        resetIdleTimer();
    });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
}
main().catch((err) => {
    process.stderr.write(`Daemon error: ${err}\n`);
    process.exit(1);
});
