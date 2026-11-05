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
exports.MAX_AGE_MS = exports.COOLDOWN_MS = exports.RETRY_MS = exports.CHECK_INTERVAL_MS = exports.RELEASE_API = exports.CURRENT_VERSION = void 0;
exports.updateDirectory = updateDirectory;
exports.stableVersion = stableVersion;
exports.parseRelease = parseRelease;
exports.fetchLatestRelease = fetchLatestRelease;
exports.parseState = parseState;
exports.available = available;
exports.shouldNotify = shouldNotify;
exports.updateMessage = updateMessage;
exports.checkForUpdates = checkForUpdates;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const os_1 = require("os");
const crypto_1 = require("crypto");
const semver = __importStar(require("semver"));
const proper_lockfile_1 = require("proper-lockfile");
exports.CURRENT_VERSION = require('../package.json').version;
exports.RELEASE_API = 'https://api.github.com/repos/briqt/pty-bridge/releases/latest';
exports.CHECK_INTERVAL_MS = 60 * 60 * 1000;
exports.RETRY_MS = 5 * 60 * 1000;
exports.COOLDOWN_MS = 24 * 60 * 60 * 1000;
exports.MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;
function updateDirectory() {
    return path.join((0, os_1.homedir)(), '.config', 'agent-skills', 'pty-bridge');
}
function stableVersion(value) {
    if (typeof value !== 'string')
        return null;
    const version = semver.valid(value.trim().replace(/^v/, ''));
    return version && !semver.prerelease(version) ? version : null;
}
function releaseUrl(value) {
    return typeof value === 'string' && /^https:\/\/github\.com\/briqt\/pty-bridge\/releases\/tag\/v?[0-9A-Za-z.+-]+$/.test(value);
}
function parseRelease(value) {
    const item = value;
    const version = stableVersion(item?.tag_name);
    if (!version || item?.draft !== false || item?.prerelease !== false || !releaseUrl(item?.html_url)) {
        throw new Error('Invalid stable release metadata');
    }
    const urlVersion = stableVersion(item.html_url.split('/').pop());
    if (urlVersion !== version)
        throw new Error('Release URL and version disagree');
    return { version, url: item.html_url };
}
async function fetchLatestRelease() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
        const response = await fetch(exports.RELEASE_API, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': `pty-bridge/${exports.CURRENT_VERSION}` },
            signal: controller.signal,
            redirect: 'error',
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Release check HTTP ${response.status}`);
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('Empty release response');
        const chunks = [];
        let size = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                size += value.byteLength;
                if (size > MAX_BYTES) {
                    await reader.cancel();
                    throw new Error('Release response too large');
                }
                chunks.push(value);
            }
        }
        finally {
            reader.releaseLock();
        }
        return parseRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }
    finally {
        clearTimeout(timer);
    }
}
function emptyState() {
    return { schema: 1, lastSuccess: 0, nextCheck: 0, notifiedAt: 0 };
}
function parseState(value, now) {
    const s = value;
    if (!s || s.schema !== 1 || ![s.lastSuccess, s.nextCheck, s.notifiedAt].every(v => Number.isSafeInteger(v) && v >= 0))
        return emptyState();
    if (s.release && (!stableVersion(s.release.version) || !releaseUrl(s.release.url)))
        return emptyState();
    if (s.notifiedVersion !== undefined && !stableVersion(s.notifiedVersion))
        return emptyState();
    if (s.lastSuccess > now || s.notifiedAt > now || s.nextCheck > now + exports.CHECK_INTERVAL_MS)
        return emptyState();
    return s;
}
function available(release, current = exports.CURRENT_VERSION) {
    return !!release && !!semver.valid(current) && semver.gt(release.version, current);
}
function shouldNotify(state, now, current = exports.CURRENT_VERSION) {
    return now >= state.lastSuccess && now - state.lastSuccess <= exports.MAX_AGE_MS && available(state.release, current)
        && (state.notifiedVersion !== state.release.version || now - state.notifiedAt >= exports.COOLDOWN_MS);
}
function updateMessage(release) {
    return `[update] pty-bridge ${release.version} available (current ${exports.CURRENT_VERSION}): ${release.url}\n`
        + 'Update CLI: npm i -g github:briqt/pty-bridge --install-links\n'
        + 'Check and update the companion skill: npx skills add briqt/pty-bridge -g -y\n'
        + 'Use pty-bridge doctor --json to inspect the running daemon; upgrading does not restart active sessions.';
}
async function readConfig(directory) {
    let raw;
    try {
        raw = await fs.readFile(path.join(directory, 'config.json'), 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
    const config = JSON.parse(raw);
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || (config.disable_update_check !== undefined && typeof config.disable_update_check !== 'boolean')) {
        throw new Error(`Invalid update configuration: ${path.join(directory, 'config.json')}`);
    }
    return config.disable_update_check === true;
}
async function checkForUpdates(options = {}) {
    const result = (status, extra = {}) => ({ currentVersion: exports.CURRENT_VERSION, status, ...extra });
    if (options.disabled || /^(1|true)$/i.test(process.env.PTY_BRIDGE_NO_UPDATE_CHECK || ''))
        return result('disabled');
    const directory = options.directory || updateDirectory();
    let releaseLock;
    let compromised = false;
    let temp;
    try {
        if (await readConfig(directory))
            return result('disabled');
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, 'update_check.json');
        // proper-lockfile provides atomic acquisition and stale-lock recovery. No waiting
        // behind another caller and no shared daemon/session state is touched.
        try {
            releaseLock = await (0, proper_lockfile_1.lock)(file, { realpath: false, retries: 0, stale: 10000, onCompromised: () => { compromised = true; } });
        }
        catch (error) {
            if (error.code === 'ELOCKED')
                return result('busy');
            throw error;
        }
        const now = (options.now || Date.now)();
        let state;
        try {
            state = parseState(JSON.parse(await fs.readFile(file, 'utf8')), now);
        }
        catch {
            state = emptyState();
        }
        let errorMessage;
        if (options.explicit || now >= state.nextCheck) {
            try {
                state.release = await (options.fetchRelease || fetchLatestRelease)();
                state.lastSuccess = now;
                state.nextCheck = now + exports.CHECK_INTERVAL_MS;
            }
            catch (error) {
                errorMessage = error instanceof Error ? error.message : 'Update check failed';
                state.nextCheck = now + exports.RETRY_MS;
            }
        }
        if (compromised)
            return result('busy');
        const fresh = state.release && now >= state.lastSuccess && now - state.lastSuccess <= exports.MAX_AGE_MS;
        if (!options.explicit && shouldNotify(state, now)) {
            (options.emit || console.error)(updateMessage(state.release));
            state.notifiedVersion = state.release.version;
            state.notifiedAt = now;
        }
        temp = `${file}.${process.pid}.${(0, crypto_1.randomUUID)()}.tmp`;
        await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        if (compromised)
            return result('busy');
        await fs.rename(temp, file);
        temp = undefined;
        if (errorMessage)
            return result('error', { error: errorMessage });
        if (!fresh)
            return result('error', { error: 'No fresh release information cached' });
        return result(available(state.release) ? 'available' : 'up-to-date', {
            latestVersion: state.release.version, releaseUrl: state.release.url, checkedAt: state.lastSuccess,
        });
    }
    catch (error) {
        return result('error', { error: error instanceof Error ? error.message : 'Update check failed' });
    }
    finally {
        if (temp)
            await fs.unlink(temp).catch(() => { });
        if (releaseLock)
            await releaseLock().catch(() => { });
    }
}
