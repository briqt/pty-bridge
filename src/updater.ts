import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import * as semver from 'semver';
import { lock } from 'proper-lockfile';

export const CURRENT_VERSION: string = require('../package.json').version;
export const RELEASE_API = 'https://api.github.com/repos/briqt/pty-bridge/releases/latest';
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const RETRY_MS = 5 * 60 * 1000;
export const COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;

export interface Release { version: string; url: string }
export interface UpdateState {
  schema: 1;
  lastSuccess: number;
  nextCheck: number;
  release?: Release;
  notifiedVersion?: string;
  notifiedAt: number;
}
export interface UpdateResult {
  currentVersion: string;
  status: 'up-to-date' | 'available' | 'disabled' | 'busy' | 'error';
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt?: number;
  error?: string;
}
interface Options {
  explicit?: boolean;
  disabled?: boolean;
  directory?: string;
  now?: () => number;
  fetchRelease?: () => Promise<Release>;
  emit?: (message: string) => void;
}

export function updateDirectory(): string {
  return path.join(homedir(), '.config', 'agent-skills', 'pty-bridge');
}

export function stableVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const version = semver.valid(value.trim().replace(/^v/, ''));
  return version && !semver.prerelease(version) ? version : null;
}

function releaseUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\/github\.com\/briqt\/pty-bridge\/releases\/tag\/v?[0-9A-Za-z.+-]+$/.test(value);
}

export function parseRelease(value: unknown): Release {
  const item = value as Record<string, unknown> | null;
  const version = stableVersion(item?.tag_name);
  if (!version || item?.draft !== false || item?.prerelease !== false || !releaseUrl(item?.html_url)) {
    throw new Error('Invalid stable release metadata');
  }
  const urlVersion = stableVersion((item.html_url as string).split('/').pop());
  if (urlVersion !== version) throw new Error('Release URL and version disagree');
  return { version, url: item.html_url as string };
}

export async function fetchLatestRelease(): Promise<Release> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `pty-bridge/${CURRENT_VERSION}` },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Release check HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty release response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Release response too large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return parseRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { clearTimeout(timer); }
}

function emptyState(): UpdateState {
  return { schema: 1, lastSuccess: 0, nextCheck: 0, notifiedAt: 0 };
}

export function parseState(value: unknown, now: number): UpdateState {
  const s = value as UpdateState | null;
  if (!s || s.schema !== 1 || ![s.lastSuccess, s.nextCheck, s.notifiedAt].every(v => Number.isSafeInteger(v) && v >= 0)) return emptyState();
  if (s.release && (!stableVersion(s.release.version) || !releaseUrl(s.release.url))) return emptyState();
  if (s.notifiedVersion !== undefined && !stableVersion(s.notifiedVersion)) return emptyState();
  if (s.lastSuccess > now || s.notifiedAt > now || s.nextCheck > now + CHECK_INTERVAL_MS) return emptyState();
  return s;
}

export function available(release: Release | undefined, current = CURRENT_VERSION): boolean {
  return !!release && !!semver.valid(current) && semver.gt(release.version, current);
}

export function shouldNotify(state: UpdateState, now: number, current = CURRENT_VERSION): boolean {
  return now >= state.lastSuccess && now - state.lastSuccess <= MAX_AGE_MS && available(state.release, current)
    && (state.notifiedVersion !== state.release!.version || now - state.notifiedAt >= COOLDOWN_MS);
}

export function updateMessage(release: Release): string {
  return `[update] pty-bridge ${release.version} available (current ${CURRENT_VERSION}): ${release.url}\n`
    + 'Update CLI: npm i -g github:briqt/pty-bridge --install-links\n'
    + 'Check and update the companion skill: npx skills add briqt/pty-bridge -g -y\n'
    + 'Use pty-bridge doctor --json to inspect the running daemon; upgrading does not restart active sessions.';
}

async function readConfig(directory: string): Promise<boolean> {
  let raw: string;
  try { raw = await fs.readFile(path.join(directory, 'config.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  const config = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (config.disable_update_check !== undefined && typeof config.disable_update_check !== 'boolean')) {
    throw new Error(`Invalid update configuration: ${path.join(directory, 'config.json')}`);
  }
  return config.disable_update_check === true;
}

export async function checkForUpdates(options: Options = {}): Promise<UpdateResult> {
  const result = (status: UpdateResult['status'], extra: Partial<UpdateResult> = {}): UpdateResult => ({ currentVersion: CURRENT_VERSION, status, ...extra });
  if (options.disabled || /^(1|true)$/i.test(process.env.PTY_BRIDGE_NO_UPDATE_CHECK || '')) return result('disabled');
  const directory = options.directory || updateDirectory();
  let releaseLock: (() => Promise<void>) | undefined;
  let compromised = false;
  let temp: string | undefined;
  try {
    if (await readConfig(directory)) return result('disabled');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'update_check.json');
    // proper-lockfile provides atomic acquisition and stale-lock recovery. No waiting
    // behind another caller and no shared daemon/session state is touched.
    try { releaseLock = await lock(file, { realpath: false, retries: 0, stale: 10000, onCompromised: () => { compromised = true; } }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return result('busy'); throw error; }
    const now = (options.now || Date.now)();
    let state: UpdateState;
    try { state = parseState(JSON.parse(await fs.readFile(file, 'utf8')), now); }
    catch { state = emptyState(); }
    let errorMessage: string | undefined;
    if (options.explicit || now >= state.nextCheck) {
      try {
        state.release = await (options.fetchRelease || fetchLatestRelease)();
        state.lastSuccess = now;
        state.nextCheck = now + CHECK_INTERVAL_MS;
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'Update check failed';
        state.nextCheck = now + RETRY_MS;
      }
    }
    if (compromised) return result('busy');
    const fresh = state.release && now >= state.lastSuccess && now - state.lastSuccess <= MAX_AGE_MS;
    if (!options.explicit && shouldNotify(state, now)) {
      (options.emit || console.error)(updateMessage(state.release!));
      state.notifiedVersion = state.release!.version;
      state.notifiedAt = now;
    }
    temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (compromised) return result('busy');
    await fs.rename(temp, file);
    temp = undefined;
    if (errorMessage) return result('error', { error: errorMessage });
    if (!fresh) return result('error', { error: 'No fresh release information cached' });
    return result(available(state.release) ? 'available' : 'up-to-date', {
      latestVersion: state.release!.version, releaseUrl: state.release!.url, checkedAt: state.lastSuccess,
    });
  } catch (error) {
    return result('error', { error: error instanceof Error ? error.message : 'Update check failed' });
  } finally {
    if (temp) await fs.unlink(temp).catch(() => {});
    if (releaseLock) await releaseLock().catch(() => {});
  }
}
