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
exports.Session = void 0;
exports.loadPty = loadPty;
const headless_1 = require("@xterm/headless");
let ptyModule;
async function loadPty() {
    try {
        ptyModule = await Promise.resolve().then(() => __importStar(require('@lydell/node-pty')));
    }
    catch {
        try {
            ptyModule = await Promise.resolve(`${'node-pty'}`).then(s => __importStar(require(s)));
        }
        catch {
            throw new Error('Neither @lydell/node-pty nor node-pty is available');
        }
    }
}
function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}
class Session {
    id;
    command;
    startedAt;
    _lastActivityAt;
    pty;
    terminal;
    _isAlive = true;
    _exitCode;
    cols;
    rows;
    lastReadLineNormal = 0;
    lastReadLineAlt = 0;
    lastBufferType = 'normal';
    keepaliveTimer = null;
    constructor(id, command, args, cols, rows, cwd, env, keepaliveInterval) {
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
            env: { ...process.env, ...env, TERM: 'xterm-256color' },
            handleFlowControl: true,
        });
        this.terminal = new headless_1.Terminal({
            allowProposedApi: true,
            cols,
            rows,
            scrollback: 50000,
        });
        this.pty.onData((data) => {
            this.terminal.write(data);
        });
        this.pty.onExit(({ exitCode }) => {
            this._isAlive = false;
            this._exitCode = exitCode;
            if (this.keepaliveTimer) {
                clearInterval(this.keepaliveTimer);
                this.keepaliveTimer = null;
            }
        });
        if (keepaliveInterval && keepaliveInterval > 0) {
            this.keepaliveTimer = setInterval(() => {
                if (this._isAlive)
                    this.pty.write('');
            }, keepaliveInterval * 1000);
        }
    }
    get pid() { return this.pty.pid; }
    get isAlive() { return this._isAlive; }
    get exitCode() { return this._exitCode; }
    get lastActivityAt() { return this._lastActivityAt; }
    write(data) {
        if (!this._isAlive)
            throw new Error('Session is not alive');
        this._lastActivityAt = new Date().toISOString();
        this.pty.write(data);
    }
    resize(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        this.pty.resize(cols, rows);
        this.terminal.resize(cols, rows);
    }
    getBuffer(which) {
        if (!which || which === 'active')
            return this.terminal.buffer.active;
        return which === 'normal' ? this.terminal.buffer.normal : this.terminal.buffer.alternate;
    }
    findLastContentLine(buf) {
        const b = buf ?? this.terminal.buffer.active;
        for (let i = b.length - 1; i >= 0; i--) {
            const line = b.getLine(i);
            if (line && line.translateToString(true).trim() !== '')
                return i;
        }
        return -1;
    }
    activeBufferType() {
        return this.terminal.buffer.active.type;
    }
    snapshot() {
        const buf = this.terminal.buffer.active;
        const startRow = buf.viewportY;
        const lines = [];
        for (let i = 0; i < this.rows; i++) {
            const line = buf.getLine(startRow + i);
            lines.push(line ? line.translateToString(true) : '');
        }
        return {
            lines,
            cursorX: buf.cursorX,
            cursorY: buf.cursorY,
            bufferType: buf.type,
            cols: this.cols,
            rows: this.rows,
        };
    }
    // Incremental read: returns lines from `since` to last content line, advances cursor.
    read(since, buffer) {
        this._lastActivityAt = new Date().toISOString();
        const buf = this.getBuffer(buffer);
        const currentType = buf.type;
        // Dual cursor logic: only applies when reading from active buffer with no explicit `since`
        if ((!buffer || buffer === 'active') && since === undefined) {
            if (currentType !== this.lastBufferType) {
                // Buffer switched — reset target buffer's cursor
                if (currentType === 'normal')
                    this.lastReadLineNormal = 0;
                else
                    this.lastReadLineAlt = 0;
                this.lastBufferType = currentType;
            }
        }
        const cursor = currentType === 'normal' ? this.lastReadLineNormal : this.lastReadLineAlt;
        const fromLine = since ?? cursor;
        const lastContentLine = this.findLastContentLine(buf);
        if (lastContentLine < fromLine) {
            if (since === undefined && (!buffer || buffer === 'active')) {
                if (currentType === 'normal')
                    this.lastReadLineNormal = lastContentLine + 1;
                else
                    this.lastReadLineAlt = lastContentLine + 1;
            }
            return '';
        }
        const lines = [];
        for (let i = fromLine; i <= lastContentLine; i++) {
            const line = buf.getLine(i);
            lines.push(line ? line.translateToString(true) : '');
        }
        // Update cursor only for incremental reads (no explicit since, active buffer)
        if (since === undefined && (!buffer || buffer === 'active')) {
            if (currentType === 'normal')
                this.lastReadLineNormal = lastContentLine + 1;
            else
                this.lastReadLineAlt = lastContentLine + 1;
        }
        return lines.join('\n');
    }
    // Read from a specific line without advancing the incremental cursor.
    readFrom(startLine, buffer) {
        const buf = this.getBuffer(buffer);
        const lastContentLine = this.findLastContentLine(buf);
        if (lastContentLine < startLine)
            return '';
        const lines = [];
        for (let i = startLine; i <= lastContentLine; i++) {
            const line = buf.getLine(i);
            lines.push(line ? line.translateToString(true) : '');
        }
        return lines.join('\n');
    }
    // Full buffer read (no cursor side effects).
    readFull(buffer) {
        return this.readFrom(0, buffer);
    }
    lineCount() {
        return this.findLastContentLine() + 1;
    }
    bufferLineCount() {
        return this.lineCount();
    }
    kill() {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
        if (this._isAlive)
            this.pty.kill();
        this.terminal.dispose();
    }
    info() {
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
            bufferType: this.terminal.buffer.active.type,
        };
    }
}
exports.Session = Session;
