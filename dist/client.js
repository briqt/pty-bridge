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
exports.RpcTimeoutError = void 0;
exports.request = request;
exports.isRpcTimeout = isRpcTimeout;
const net = __importStar(require("net"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const protocol_1 = require("./protocol");
class RpcTimeoutError extends Error {
    constructor(message = 'Connection timeout') {
        super(message);
        this.name = 'RpcTimeoutError';
    }
}
exports.RpcTimeoutError = RpcTimeoutError;
function sendRequest(method, params = {}, timeoutMs) {
    const timeout = timeoutMs ?? protocol_1.DEFAULT_RPC_TIMEOUT_MS;
    const socketPath = (0, protocol_1.getSocketPath)();
    return new Promise((resolve, reject) => {
        const conn = net.createConnection(socketPath);
        const req = { id: crypto.randomBytes(4).toString('hex'), method, params };
        let buffer = '';
        let settled = false;
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            fn();
        };
        conn.on('connect', () => {
            conn.write(JSON.stringify(req) + '\n');
        });
        conn.on('data', (chunk) => {
            buffer += chunk.toString();
            const idx = buffer.indexOf('\n');
            if (idx !== -1) {
                try {
                    const res = JSON.parse(buffer.slice(0, idx));
                    conn.end();
                    finish(() => resolve(res));
                }
                catch {
                    conn.end();
                    finish(() => reject(new Error('Invalid response from daemon')));
                }
            }
        });
        conn.on('error', (err) => finish(() => reject(err)));
        conn.on('timeout', () => {
            conn.destroy();
            finish(() => reject(new RpcTimeoutError()));
        });
        conn.setTimeout(timeout);
    });
}
async function isDaemonRunning() {
    try {
        const res = await sendRequest('ping', {}, 2000);
        return !!res.result;
    }
    catch {
        return false;
    }
}
async function ensureDaemon() {
    if (await isDaemonRunning())
        return;
    try {
        fs.unlinkSync((0, protocol_1.getSocketPath)());
    }
    catch { }
    const daemonScript = path.join(__dirname, 'daemon.js');
    const lockPath = (0, protocol_1.getSocketPath)() + '.lock';
    let lockFd;
    try {
        lockFd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    }
    catch {
        for (let i = 0; i < 25; i++) {
            await new Promise(r => setTimeout(r, 200));
            if (await isDaemonRunning())
                return;
        }
        throw new Error('Daemon failed to start (another process may be starting it)');
    }
    try {
        return await new Promise((resolve, reject) => {
            const child = (0, child_process_1.fork)(daemonScript, [], {
                detached: true,
                stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            });
            child.on('message', (msg) => {
                if (msg === 'ready') {
                    child.disconnect();
                    child.unref();
                    resolve();
                }
            });
            child.on('error', reject);
            setTimeout(() => {
                child.disconnect?.();
                child.unref();
                reject(new Error('Daemon failed to start within 5 seconds'));
            }, 5000);
        });
    }
    finally {
        if (lockFd !== undefined)
            fs.closeSync(lockFd);
        try {
            fs.unlinkSync(lockPath);
        }
        catch { }
    }
}
async function request(method, params = {}, timeoutMs) {
    await ensureDaemon();
    const res = await sendRequest(method, params, timeoutMs);
    if (res.error)
        throw new Error(res.error);
    return res.result;
}
function isRpcTimeout(err) {
    return err instanceof RpcTimeoutError || (err instanceof Error && err.name === 'RpcTimeoutError');
}
