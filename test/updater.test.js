const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const u = require('../dist/updater');
const cli = path.join(__dirname, '../dist/cli.js');
const release = version => ({ version, url: `https://github.com/briqt/pty-bridge/releases/tag/v${version}` });
const remote = (version, extra = {}) => ({ schema_version: 1, latest_version: version, release_url: release(version).url, ...extra });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pty-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('semantic ordering, stable channel, and manifest validation', () => {
  assert.equal(u.available(release('1.10.0'), '1.9.0'), true);
  assert.equal(u.available(release('1.9.0'), '1.10.0'), false);
  assert.equal(u.available(release('1.9.0'), '1.9.0'), false);
  assert.equal(u.stableVersion('v1.6.0'), '1.6.0');
  for (const v of ['1.7.0-beta.1', 'garbage', '01.6.0']) assert.equal(u.stableVersion(v), null);
  assert.deepEqual(u.parseManifest(remote('1.6.0')), release('1.6.0'));
  assert.deepEqual(u.parseManifest(remote('1.6.0', { notice_id: '', notice: '' })), release('1.6.0'));
  assert.deepEqual(u.parseManifest(remote('1.6.0', { notice_id: 'n-1', notice: 'fix\u001b[31m now' })),
    { ...release('1.6.0'), noticeId: 'n-1', notice: 'fix [31m now' });
  for (const r of [null, {}, { ...remote('1.6.0'), schema_version: 2 }, remote('1.7.0-beta.1'),
    { ...remote('1.6.0'), release_url: 'https://example.com/download' },
    { ...remote('1.6.0'), release_url: release('1.7.0').url },
    remote('1.6.0', { notice_id: 'n-1' }), remote('1.6.0', { notice_id: 'bad id', notice: 'x' }),
    remote('1.6.0', { notice_id: 'n-1', notice: 'x'.repeat(1001) })]) assert.throws(() => u.parseManifest(r));
});

test('cache, independent notification cooldown, and a new version', async t => {
  const directory = await fixture(t);
  let now = 10 * u.MAX_AGE_MS, calls = 0, version = '99.0.0';
  const tips = [];
  const options = { directory, now: () => now, fetchManifest: async () => { calls++; return release(version); }, emit: x => tips.push(x) };
  assert.equal((await u.checkForUpdates(options)).status, 'available');
  assert.equal(tips.length, 1);
  now += 1000;
  await u.checkForUpdates(options);
  assert.equal(calls, 1);
  assert.equal(tips.length, 1);
  now += u.CHECK_INTERVAL_MS;
  await u.checkForUpdates(options);
  assert.equal(calls, 2);
  assert.equal(tips.length, 1);
  now += u.COOLDOWN_MS;
  await u.checkForUpdates(options);
  assert.equal(tips.length, 2);
  now += u.CHECK_INTERVAL_MS;
  version = '99.1.0';
  await u.checkForUpdates(options);
  assert.equal(tips.length, 3);
});

test('failed requests back off; stale cached notices stop', async t => {
  const directory = await fixture(t);
  let now = 10 * u.MAX_AGE_MS, calls = 0;
  const options = { directory, now: () => now, emit: () => {} };
  await u.checkForUpdates({ ...options, fetchManifest: async () => release('99.0.0') });
  const failing = { ...options, fetchManifest: async () => { calls++; throw new Error('offline'); } };
  now += u.MAX_AGE_MS + 1;
  let tips = 0;
  const result = await u.checkForUpdates({ ...failing, emit: () => tips++ });
  assert.equal(result.status, 'error');
  now += 1000;
  await u.checkForUpdates(failing);
  assert.equal(calls, 1);
  assert.equal(tips, 0);
  now += u.RETRY_MS;
  await u.checkForUpdates(failing);
  assert.equal(calls, 2);
});

test('explicit checks bypass cache and do not consume automatic cooldown', async t => {
  const directory = await fixture(t);
  let calls = 0, tips = 0;
  const options = { directory, fetchManifest: async () => { calls++; return release('99.0.0'); }, emit: () => tips++ };
  await u.checkForUpdates({ ...options, explicit: true });
  await u.checkForUpdates({ ...options, explicit: true });
  assert.equal(calls, 2);
  assert.equal(tips, 0);
  await u.checkForUpdates(options);
  assert.equal(calls, 2);
  assert.equal(tips, 1);
});

test('disabled flag and config do not fetch or create cache', async t => {
  const directory = await fixture(t);
  const fetchManifest = async () => { throw new Error('must not fetch'); };
  assert.equal((await u.checkForUpdates({ directory, disabled: true, fetchManifest })).status, 'disabled');
  assert.deepEqual(await fs.readdir(directory), []);
  await fs.writeFile(path.join(directory, 'config.json'), '{"disable_update_check":true}');
  assert.equal((await u.checkForUpdates({ directory, explicit: true, fetchManifest })).status, 'disabled');
  assert.deepEqual(await fs.readdir(directory), ['config.json']);
  await fs.writeFile(path.join(directory, 'config.json'), '{"disable_update_check":"false"}');
  assert.equal((await u.checkForUpdates({ directory, fetchManifest })).status, 'error');
});

test('corrupt cache and future timestamps recover; invalid state rejected', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'update_check.json');
  const now = 100000000;
  const options = { directory, now: () => now, fetchManifest: async () => release('1.0.0') };
  for (const raw of ['{bad', JSON.stringify({ schema: 2, lastSuccess: now + 1, nextCheck: now + 100, notifiedAt: 0, notifiedNoticeAt: 0 }),
    JSON.stringify({ schema: 1, lastSuccess: now - 1, nextCheck: now + 100, notifiedAt: 0 })]) {
    await fs.writeFile(file, raw);
    assert.equal((await u.checkForUpdates(options)).status, 'up-to-date');
    assert.equal(JSON.parse(await fs.readFile(file)).lastSuccess, now);
  }
  assert.equal(u.parseState({ schema: 2, lastSuccess: 0, nextCheck: 'bad', notifiedAt: 0, notifiedNoticeAt: 0 }, now).nextCheck, 0);
});

test('concurrent checks share lock; only one request and notification', async t => {
  const directory = await fixture(t);
  let unblock, started;
  const waiting = new Promise(resolve => { unblock = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0, tips = 0;
  const options = { directory, fetchManifest: async () => { calls++; started(); await waiting; return release('99.0.0'); }, emit: () => tips++ };
  const first = u.checkForUpdates(options);
  await ready;
  try { assert.equal((await u.checkForUpdates(options)).status, 'busy'); }
  finally { unblock(); }
  await first;
  assert.equal(calls, 1);
  assert.equal(tips, 1);
  assert.deepEqual(await fs.readdir(directory), ['update_check.json']);
});

test('unusable cache directory fails without throwing', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'file');
  await fs.writeFile(file, 'not a directory');
  assert.equal((await u.checkForUpdates({ directory: file })).status, 'error');
});

test('HTTP parsing bounds response, rejects status and aborts stalled requests', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => new Response(JSON.stringify(remote('1.6.0')));
    assert.deepEqual(await u.fetchManifest(), release('1.6.0'));
    global.fetch = async () => new Response('no', { status: 429 });
    await assert.rejects(u.fetchManifest(), /429/);
    global.fetch = async () => new Response('x'.repeat(65537));
    await assert.rejects(u.fetchManifest(), /too large/);
    global.fetch = async () => new Response('{bad');
    await assert.rejects(u.fetchManifest());
    global.fetch = async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const start = Date.now();
    await assert.rejects(u.fetchManifest(), /aborted/);
    assert.ok(Date.now() - start < 4000);
  } finally { global.fetch = original; }
});

test('CLI disable flags, JSON output, help and version remain deterministic', () => {
  for (const args of [['--no-update-check', 'check-update', '--json'], ['check-update', '--json']]) {
    const out = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, PTY_BRIDGE_NO_UPDATE_CHECK: 'true' } });
    assert.equal(out.status, 0);
    assert.equal(JSON.parse(out.stdout).status, 'disabled');
    assert.equal(out.stderr, '');
  }
  for (const args of [['--version'], ['--help'], ['check-update', '--help']]) {
    const out = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 1000 });
    assert.equal(out.status, 0);
    assert.equal(out.stderr, '');
  }
  const invalid = spawnSync(process.execPath, [cli, 'check-update', '--wat'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
});

test('skill metadata and lockfile versions match the package release', async () => {
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  const skill = await fs.readFile(path.join(__dirname, '../skills/pty-bridge/SKILL.md'), 'utf8');
  assert.equal(skill.match(/^  version: "([^"]+)"$/m)?.[1], pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('announcements: independent cooldown, new id at once, withdrawal and newer local builds', async t => {
  const directory = await fixture(t);
  let now = 10 * u.MAX_AGE_MS;
  let manifest = { ...release(u.CURRENT_VERSION), noticeId: 'n-1', notice: 'please update the skill' };
  const tips = [];
  const options = { directory, now: () => now, fetchManifest: async () => manifest, emit: x => tips.push(x) };
  const first = await u.checkForUpdates(options);
  assert.equal(first.status, 'up-to-date');
  assert.deepEqual(tips, ['[notice] pty-bridge: please update the skill']);
  now += u.CHECK_INTERVAL_MS;
  await u.checkForUpdates(options);
  assert.equal(tips.length, 1);
  now += u.COOLDOWN_MS;
  await u.checkForUpdates(options);
  assert.equal(tips.length, 2);
  manifest = { ...manifest, noticeId: 'n-2', notice: 'second' };
  now += u.CHECK_INTERVAL_MS;
  await u.checkForUpdates(options);
  assert.equal(tips.at(-1), '[notice] pty-bridge: second');
  manifest = release(u.CURRENT_VERSION);
  now += u.CHECK_INTERVAL_MS + u.COOLDOWN_MS;
  await u.checkForUpdates(options);
  assert.equal(tips.length, 3);
  const explicit = await u.checkForUpdates({ ...options, explicit: true, fetchManifest: async () => ({ ...release('0.0.1'), noticeId: 'old', notice: 'old news' }) });
  assert.equal(explicit.notice, undefined);
});

test('published notice.json is valid and never ahead of the package version', async () => {
  const file = path.join(__dirname, '../notice.json');
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const manifest = u.parseManifest(JSON.parse(raw));
  assert.equal(u.available(manifest, require('../package.json').version), false);
});
