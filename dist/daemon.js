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
const string_decoder_1 = require("string_decoder");
const session_1 = require("./session");
const output_1 = require("./output");
const exec_output_1 = require("./exec-output");
const VERSION = require('../package.json').version;
const protocol_1 = require("./protocol");
const sessions = new Map();
let idleTimer = null;
const daemonStartedAt = new Date().toISOString();
let totalSessionCount = 0;
let lastRestartAt;
let lostSessions = [];
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
function persistState(cleanShutdown = false) {
    const state = {
        daemonPid: process.pid,
        daemonStartedAt,
        cleanShutdown,
        lastRestartAt,
        sessions: cleanShutdown ? [] : Array.from(sessions.values()).map(s => s.persistMeta()),
        lostSessions: cleanShutdown ? [] : lostSessions.slice(0, 50),
    };
    try {
        fs.writeFileSync((0, protocol_1.getStatePath)(), JSON.stringify(state));
    }
    catch {
        // Persistence is best-effort; never crash the daemon for it.
    }
}
function recoverState() {
    let prev;
    try {
        prev = JSON.parse(fs.readFileSync((0, protocol_1.getStatePath)(), 'utf8'));
    }
    catch {
        return;
    }
    if (!prev)
        return;
    if (!prev.cleanShutdown && Array.isArray(prev.sessions) && prev.sessions.length > 0) {
        const lostAt = new Date().toISOString();
        lastRestartAt = lostAt;
        const newlyLost = prev.sessions.map(s => ({
            id: s.id,
            command: s.command,
            pid: s.pid,
            owner: s.owner || '',
            ...(s.name ? { name: s.name } : {}),
            startedAt: s.startedAt,
            lostAt,
        }));
        lostSessions = [...newlyLost, ...(prev.lostSessions || [])].slice(0, 50);
    }
    else if (Array.isArray(prev.lostSessions)) {
        lostSessions = prev.lostSessions.slice(0, 50);
        lastRestartAt = prev.lastRestartAt;
    }
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
    persistState(true);
    try {
        fs.unlinkSync((0, protocol_1.getSocketPath)());
    }
    catch { }
}
/** Resolve a session by id, or by name (a live session wins over exited ones). */
function findSession(ref) {
    const byId = sessions.get(ref);
    if (byId)
        return byId;
    let exited;
    for (const s of sessions.values()) {
        if (s.name !== ref)
            continue;
        if (s.isAlive)
            return s;
        if (!exited || s.startedAt > exited.startedAt)
            exited = s;
    }
    return exited;
}
function getSession(id) {
    const session = findSession(id);
    if (!session) {
        const available = Array.from(sessions.values()).map(s => s.name ? `${s.id}(${s.name})` : s.id);
        const hint = available.length > 0
            ? ` Available sessions: ${available.join(', ')}`
            : ' No active sessions.';
        const lostHint = lostSessions.length > 0
            ? ` Daemon restarted at ${lastRestartAt ?? 'unknown'}; ${lostSessions.length} session(s) lost.`
            : '';
        throw new Error(`Session not found: ${id}.${hint}${lostHint}`);
    }
    return session;
}
function assertOwner(session, auth, action) {
    if (auth?.force)
        return;
    if (!session.owner)
        return;
    const caller = auth?.owner || '';
    if (session.owner !== caller) {
        throw new Error(`Session ${session.id} is owned by '${session.owner}', caller is '${caller || 'unset'}'. Use --owner '${session.owner}' only for your own session; --force requires an explicit takeover.`);
    }
}
function maxBytesOf(value) {
    return value === undefined ? protocol_1.DEFAULT_MAX_BYTES : value;
}
function wrapOutput(output, maxBytes, extra = {}) {
    const trunc = (0, protocol_1.truncateUtf8)(output, maxBytes);
    return {
        output: trunc.output,
        truncated: trunc.truncated,
        totalBytes: trunc.totalBytes,
        returnedBytes: trunc.returnedBytes,
        ...extra,
    };
}
async function waitForMatch(session, startLine, matches, timeoutMs) {
    const existing = session.readFrom(startLine);
    if (matches(existing))
        return { matched: true, output: existing };
    return new Promise((resolve) => {
        const startTime = Date.now();
        const timer = setInterval(() => {
            const content = session.readFrom(startLine);
            if (matches(content)) {
                clearInterval(timer);
                resolve({ matched: true, output: content });
            }
            else if (Date.now() - startTime >= timeoutMs) {
                clearInterval(timer);
                resolve({ matched: false, output: content });
            }
        }, 100);
    });
}
/** Poll until the exec sentinel is printed; an exit code at the very end must be stable for one poll. */
async function waitForSentinel(session, marker, timeoutMs) {
    const base = Math.max(0, session.lastExecStartLine - 1);
    const deadline = Date.now() + timeoutMs;
    let pending;
    for (;;) {
        const found = (0, exec_output_1.findSentinel)(session.readRows(base), 0, marker);
        if (found) {
            const key = `${found.row}:${found.col}:${found.exitCode}`;
            if (!found.atEnd || pending === key)
                return;
            pending = key;
        }
        else {
            pending = undefined;
        }
        if (!session.isAlive || Date.now() >= deadline)
            return;
        await new Promise(r => setTimeout(r, 100));
    }
}
/** Output of the last exec without the echoed input, sentinel or redrawn prompt. */
function execResult(session, maxBytes) {
    const startLine = session.lastExecStartLine;
    // The command is typed on the prompt row, one row above the exec start line.
    const base = Math.max(0, startLine - 1);
    const echo = session.lastExecEcho;
    const extracted = (0, exec_output_1.extractExecOutput)(session.readRows(base), startLine - base, echo);
    const trunc = wrapOutput(extracted.output, maxBytes);
    let status;
    let exitCode = session.exitCode;
    if (echo?.marker && extracted.matched) {
        exitCode = extracted.exitCode;
        status = exitCode === 0 ? 'done' : 'failed';
    }
    else if (session.isAlive) {
        status = 'still_running';
    }
    else {
        status = !echo?.marker && session.exitCode === 0 ? 'done' : 'failed';
    }
    const bodyLine = base + extracted.bodyRow;
    return {
        ...trunc,
        status,
        isAlive: session.isAlive,
        exitCode,
        startCursor: bodyLine,
        cursor: trunc.truncated ? (0, output_1.renderedCursor)(bodyLine, trunc.output) : session.lineCount(),
    };
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
            const name = p.name || '';
            if (name) {
                const problem = (0, protocol_1.sessionNameProblem)(name);
                if (problem)
                    throw new Error(problem);
                for (const s of sessions.values()) {
                    if (s.name === name && s.isAlive) {
                        throw new Error(`Session name '${name}' is already used by live session ${s.id}. Use that session if it is yours, or choose another name.`);
                    }
                }
            }
            const id = genId();
            const session = new session_1.Session(id, p.command, p.args || [], p.cols || 120, p.rows || 40, p.cwd || process.cwd(), p.env, p.keepaliveInterval, p.owner || '', name);
            sessions.set(id, session);
            totalSessionCount++;
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
            persistState();
            const wait = typeof p.wait === 'number' && p.wait >= 0 ? p.wait : 500;
            await new Promise(r => setTimeout(r, wait));
            const startCursor = 0;
            const output = session.read();
            return {
                sessionId: id,
                owner: session.owner,
                name: session.name,
                output,
                status: session.isAlive ? 'still_running' : (session.exitCode === 0 ? 'done' : 'failed'),
                startCursor,
                cursor: session.lineCount(),
                isAlive: session.isAlive,
                exitCode: session.exitCode,
            };
        }
        case 'read': {
            const p = req.params;
            const session = getSession(p.sessionId);
            const mb = maxBytesOf(p.maxBytes);
            if (p.raw) {
                const advance = p.since == null && p.last == null && !p.fromLastExec;
                const raw = session.readRaw({ since: p.since, last: p.last, fromLastExec: p.fromLastExec, advance, maxBytes: mb });
                return { ...raw, isAlive: session.isAlive, exitCode: session.exitCode,
                    totalLines: session.bufferLineCount(), bufferType: session.activeBufferType(), raw: true };
            }
            return { ...session.readRendered({ ...p, maxBytes: mb }), isAlive: session.isAlive,
                exitCode: session.exitCode, totalLines: session.bufferLineCount(), bufferType: session.activeBufferType(), raw: false };
        }
        case 'write': {
            const p = req.params;
            const session = getSession(p.sessionId);
            assertOwner(session, p, 'write');
            session.write(p.input);
            persistState();
            return { ok: true };
        }
        case 'sendkey': {
            const p = req.params;
            const session = getSession(p.sessionId);
            assertOwner(session, p, 'sendkey');
            const sequence = protocol_1.KEY_MAP[p.key.toLowerCase()];
            if (!sequence)
                throw new Error(`Unknown key: ${p.key}. Available: ${Object.keys(protocol_1.KEY_MAP).join(', ')}`);
            session.write(sequence);
            persistState();
            return { ok: true };
        }
        case 'exec': {
            const p = req.params;
            const session = getSession(p.sessionId);
            assertOwner(session, p, 'exec');
            const mb = maxBytesOf(p.maxBytes);
            if (p.waitExit) {
                const token = crypto.randomBytes(4).toString('hex');
                const marker = `PTYBRIDGE_DONE_${token}:`;
                session.markExecStart({ tail: `${marker}$?`, marker });
                session.write(`${p.command}; echo ${marker}$?\r`);
                await waitForSentinel(session, marker, p.waitMs || 30000);
                const result = execResult(session, mb);
                persistState();
                return result;
            }
            const lastInputLine = p.command.split('\n').filter(line => line.trim()).pop() ?? '';
            session.markExecStart({ tail: lastInputLine, rows: (0, exec_output_1.echoSearchRows)(p.command, session.columns) });
            const startLine = session.lastExecStartLine;
            session.write(p.command + '\r');
            if (p.waitForIdle && p.waitForIdle > 0) {
                const maxWait = p.waitMs || 5000;
                const interval = p.waitForIdle;
                const deadline = Date.now() + maxWait;
                let prev = '';
                await new Promise(resolve => {
                    const check = () => {
                        const current = session.readFrom(startLine);
                        if (current === prev && current.length > 0) {
                            resolve();
                            return;
                        }
                        prev = current;
                        if (Date.now() + interval >= deadline) {
                            resolve();
                            return;
                        }
                        setTimeout(check, interval);
                    };
                    setTimeout(check, interval);
                });
            }
            else {
                await new Promise(r => setTimeout(r, p.waitMs || 200));
            }
            const result = execResult(session, mb);
            persistState();
            return result;
        }
        case 'peekExec': {
            const p = req.params;
            const session = getSession(p.sessionId);
            return execResult(session, maxBytesOf(p.maxBytes));
        }
        case 'waitFor': {
            const p = req.params;
            const session = getSession(p.sessionId);
            const lineCount = session.lineCount();
            let fromLine;
            if (p.fromNow)
                fromLine = lineCount;
            else if (typeof p.from === 'number')
                fromLine = p.from;
            else
                fromLine = Math.max(0, lineCount - protocol_1.WAIT_FOR_LOOKBACK_LINES);
            const waited = await waitForMatch(session, fromLine, (s) => s.includes(p.pattern), p.timeoutMs);
            if (!waited.matched) {
                return {
                    matched: false,
                    output: waited.output,
                    error: `Timeout after ${p.timeoutMs}ms waiting for pattern: ${p.pattern}`,
                    startCursor: fromLine,
                    cursor: session.lineCount(),
                };
            }
            return {
                matched: true,
                output: waited.output,
                startCursor: fromLine,
                cursor: session.lineCount(),
            };
        }
        case 'snapshot': {
            const p = req.params;
            const session = getSession(p.sessionId);
            return { success: true, ...session.snapshot() };
        }
        case 'list': {
            return {
                sessions: Array.from(sessions.values()).map(s => s.info()),
                lostSessions,
                lastRestartAt,
                lostCount: lostSessions.length,
            };
        }
        case 'kill': {
            const p = req.params;
            const session = getSession(p.sessionId);
            assertOwner(session, p, 'kill');
            session.kill();
            sessions.delete(session.id);
            persistState();
            resetIdleTimer();
            return { ok: true };
        }
        case 'resize': {
            const p = req.params;
            const session = getSession(p.sessionId);
            assertOwner(session, p, 'resize');
            session.resize(p.cols, p.rows);
            return { ok: true };
        }
        case 'status': {
            const alive = Array.from(sessions.values()).filter(s => s.isAlive).length;
            return {
                version: VERSION,
                daemonStartedAt,
                pid: process.pid,
                activeSessions: alive,
                totalSessions: totalSessionCount,
                memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100,
                lastRestartAt,
                lostCount: lostSessions.length,
                lostSessions,
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
    recoverState();
    try {
        fs.unlinkSync((0, protocol_1.getSocketPath)());
    }
    catch { }
    const server = net.createServer((conn) => {
        let buffer = '';
        const decoder = new string_decoder_1.StringDecoder('utf8');
        conn.on('data', (chunk) => {
            buffer += decoder.write(chunk);
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (!line.trim())
                    continue;
                try {
                    const req = JSON.parse(line);
                    handleRequest(req).then((res) => {
                        try {
                            conn.write(JSON.stringify(res) + '\n');
                        }
                        catch { }
                    });
                }
                catch {
                    try {
                        conn.write(JSON.stringify({ id: '', error: 'Invalid JSON' }) + '\n');
                    }
                    catch { }
                }
            }
        });
    });
    server.listen((0, protocol_1.getSocketPath)(), () => {
        try {
            fs.chmodSync((0, protocol_1.getSocketPath)(), 0o600);
        }
        catch { }
        persistState();
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
