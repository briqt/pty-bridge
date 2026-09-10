"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KEY_MAP = exports.DEFAULT_RPC_TIMEOUT_MS = exports.WAIT_FOR_LOOKBACK_LINES = exports.RAW_BUFFER_CAP = exports.DEFAULT_MAX_BYTES = exports.IDLE_TIMEOUT_MS = exports.SOCKET_PATH = void 0;
exports.getSocketPath = getSocketPath;
exports.getStatePath = getStatePath;
exports.defaultOwner = defaultOwner;
exports.truncateUtf8 = truncateUtf8;
exports.rpcTimeoutForWait = rpcTimeoutForWait;
const os_1 = require("os");
const path_1 = require("path");
function getSocketPath() {
    if (process.env.PTY_BRIDGE_SOCKET)
        return process.env.PTY_BRIDGE_SOCKET;
    if ((0, os_1.platform)() === 'win32') {
        const username = process.env.USERNAME || process.env.USER || 'default';
        return `\\\\.\\pipe\\pty-bridge-${username}`;
    }
    return `/tmp/pty-bridge-${process.getuid?.() ?? 0}.sock`;
}
function getStatePath() {
    if (process.env.PTY_BRIDGE_STATE)
        return process.env.PTY_BRIDGE_STATE;
    const socket = getSocketPath();
    if ((0, os_1.platform)() === 'win32') {
        const username = process.env.USERNAME || process.env.USER || 'default';
        return (0, path_1.join)((0, os_1.tmpdir)(), `pty-bridge-${username}.state.json`);
    }
    return `${socket}.state.json`;
}
function defaultOwner() {
    return process.env.PTY_BRIDGE_OWNER || process.env.USER || process.env.USERNAME || 'default';
}
exports.SOCKET_PATH = getSocketPath();
exports.IDLE_TIMEOUT_MS = 300_000;
exports.DEFAULT_MAX_BYTES = 256_000;
exports.RAW_BUFFER_CAP = 8 * 1024 * 1024;
exports.WAIT_FOR_LOOKBACK_LINES = 200;
exports.DEFAULT_RPC_TIMEOUT_MS = 30_000;
function truncateUtf8(text, maxBytes) {
    const totalBytes = Buffer.byteLength(text, 'utf8');
    if (maxBytes <= 0 || totalBytes <= maxBytes) {
        return { output: text, truncated: false, totalBytes, returnedBytes: totalBytes };
    }
    let end = Math.min(text.length, maxBytes);
    while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) {
        end--;
    }
    let cut = text.slice(0, end);
    const nl = cut.lastIndexOf('\n');
    if (nl > 0)
        cut = cut.slice(0, nl);
    return {
        output: cut,
        truncated: true,
        totalBytes,
        returnedBytes: Buffer.byteLength(cut, 'utf8'),
    };
}
function rpcTimeoutForWait(waitMs, globalTimeout) {
    if (globalTimeout)
        return globalTimeout;
    return Math.max(exports.DEFAULT_RPC_TIMEOUT_MS, waitMs + 5_000);
}
exports.KEY_MAP = {
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
