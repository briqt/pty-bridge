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
const protocol_1 = require("./protocol");
const output_1 = require("./output");
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
    owner;
    name;
    lastExecStartLine = 0;
    lastExecEcho;
    lastExecStartRaw = 0;
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
    rawOutput = new output_1.RawOutputBuffer(protocol_1.RAW_BUFFER_CAP);
    readColumns = { normal: 0, alternate: 0 };
    constructor(id, command, args, cols, rows, cwd, env, keepaliveInterval, owner = '', name = '') {
        this.id = id;
        this.command = command;
        this.owner = owner;
        this.name = name;
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
            this.appendRaw(data);
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
    get rawLength() { return this.rawOutput.end; }
    get columns() { return this.cols; }
    appendRaw(data) { this.rawOutput.append(data); }
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
    markExecStart(echo) {
        this.lastExecStartLine = this.lineCount();
        this.lastExecStartRaw = this.rawOutput.end;
        this.lastExecEcho = echo;
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
        const collected = [];
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
    incrementalCursor(buffer) {
        const buf = this.getBuffer(buffer);
        const currentType = buf.type;
        return currentType === 'normal' ? this.lastReadLineNormal : this.lastReadLineAlt;
    }
    // Incremental read: returns lines from `since` to last content line, advances cursor.
    read(since, buffer) {
        this._lastActivityAt = new Date().toISOString();
        const buf = this.getBuffer(buffer);
        const currentType = buf.type;
        if ((!buffer || buffer === 'active') && since === undefined) {
            if (currentType !== this.lastBufferType) {
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
        if (since === undefined && (!buffer || buffer === 'active')) {
            if (currentType === 'normal')
                this.lastReadLineNormal = lastContentLine + 1;
            else
                this.lastReadLineAlt = lastContentLine + 1;
        }
        return lines.join('\n');
    }
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
    /** Rendered rows from `startLine` to the last content line, with soft-wrap flags. */
    readRows(startLine, buffer) {
        const buf = this.getBuffer(buffer);
        const last = this.findLastContentLine(buf);
        const rows = [];
        for (let i = Math.max(0, startLine); i <= last; i++) {
            const line = buf.getLine(i);
            rows.push({ text: line ? line.translateToString(true) : '', wrapped: !!line?.isWrapped });
        }
        return rows;
    }
    readLastLines(n, buffer) {
        if (n <= 0)
            return '';
        const buf = this.getBuffer(buffer);
        const last = this.findLastContentLine(buf);
        if (last < 0)
            return '';
        return this.readFrom(Math.max(0, last - n + 1), buffer);
    }
    readFull(buffer) {
        return this.readFrom(0, buffer);
    }
    readRaw(opts = {}) {
        return this.rawOutput.read({
            ...opts,
            since: opts.fromLastExec ? this.lastExecStartRaw : opts.since,
        });
    }
    readRendered(opts = {}) {
        const buf = this.getBuffer(opts.buffer);
        const type = buf.type;
        const incremental = opts.since == null && opts.last == null && !opts.fromLastExec;
        if (incremental && type !== this.lastBufferType) {
            if (type === 'normal')
                this.lastReadLineNormal = 0;
            else
                this.lastReadLineAlt = 0;
            this.readColumns[type] = 0;
            this.lastBufferType = type;
        }
        const end = this.findLastContentLine(buf) + 1;
        const start = opts.fromLastExec ? this.lastExecStartLine
            : opts.last != null ? Math.max(0, end - opts.last)
                : opts.since ?? this.incrementalCursor(opts.buffer);
        const column = opts.column ?? (incremental ? this.readColumns[type] : 0);
        const text = Buffer.from(this.readFrom(start, opts.buffer), 'utf8').subarray(column).toString('utf8');
        const chunk = (0, protocol_1.truncateUtf8)(text, opts.maxBytes ?? protocol_1.DEFAULT_MAX_BYTES);
        const cursor = chunk.truncated ? (0, output_1.renderedCursor)(start, chunk.output, column) : end;
        if (incremental) {
            const [line, col = '0'] = String(cursor).split(':');
            if (type === 'normal')
                this.lastReadLineNormal = Number(line);
            else
                this.lastReadLineAlt = Number(line);
            this.readColumns[type] = Number(col);
        }
        return { ...chunk, startCursor: column ? `${start}:${column}` : start, cursor };
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
    persistMeta() {
        return {
            id: this.id,
            command: this.command,
            pid: this.pid,
            owner: this.owner,
            name: this.name,
            startedAt: this.startedAt,
        };
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
            owner: this.owner,
            name: this.name,
            lastExecStartLine: this.lastExecStartLine,
        };
    }
}
exports.Session = Session;
