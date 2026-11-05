const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const u = require('../dist/updater');
const cli = path.join(__dirname, '../dist/cli.js');
const release = version => ({ version, url: `https://github.com/briqt/pty-bridge/releases/tag/v${version}` });
const remote = version => ({ tag_name: `v${version}`, html_url: release(version).url, draft: false, prerelease: false });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pty-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('semantic ordering, stable channel, and release URL validation', () => {
  assert.equal(u.available(release('1.10.0'), '1.9.0'), true);
  assert.equal(u.available(release('1.9.0'), '1.10.0'), false);
  assert.equal(u.available(release('1.9.0'), '1.9.0'), false);
  assert.equal(u.stableVersion('v1.6.0'), '1.6.0');
  for (const v of ['1.7.0-beta.1', 'garbage', '01.6.0']) assert.equal(u.stableVersion(v), null);
  assert.deepEqual(u.parseRelease(remote('1.6.0')), release('1.6.0'));
  for (const r of [null, {}, { ...remote('1.6.0'), draft: true }, { ...remote('1.6.0'), prerelease: true },
    { ...remote('1.6.0'), html_url: 'https://example.com/download' },
    { ...remote('1.6.0'), html_url: release('1.7.0').url }]) assert.throws(() => u.parseRelease(r));
});

test('cache, independent notification cooldown, and a new version', async t => {
  const directory = await fixture(t);
  let now = 10 * u.MAX_AGE_MS, calls = 0, version = '99.0.0';
  const tips = [];
  const options = { directory, now: () => now, fetchRelease: async () => { calls++; return release(version); }, emit: x => tips.push(x) };
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
  await u.checkForUpdates({ ...options, fetchRelease: async () => release('99.0.0') });
  const failing = { ...options, fetchRelease: async () => { calls++; throw new Error('offline'); } };
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
  const options = { directory, fetchRelease: async () => { calls++; return release('99.0.0'); }, emit: () => tips++ };
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
  const fetchRelease = async () => { throw new Error('must not fetch'); };
  assert.equal((await u.checkForUpdates({ directory, disabled: true, fetchRelease })).status, 'disabled');
  assert.deepEqual(await fs.readdir(directory), []);
  await fs.writeFile(path.join(directory, 'config.json'), '{"disable_update_check":true}');
  assert.equal((await u.checkForUpdates({ directory, explicit: true, fetchRelease })).status, 'disabled');
  assert.deepEqual(await fs.readdir(directory), ['config.json']);
  await fs.writeFile(path.join(directory, 'config.json'), '{"disable_update_check":"false"}');
  assert.equal((await u.checkForUpdates({ directory, fetchRelease })).status, 'error');
});

test('corrupt cache and future timestamps recover; invalid state rejected', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'update_check.json');
  const now = 100000000;
  const options = { directory, now: () => now, fetchRelease: async () => release('1.0.0') };
  for (const raw of ['{bad', JSON.stringify({ schema: 1, lastSuccess: now + 1, nextCheck: now + 100, notifiedAt: 0 })]) {
    await fs.writeFile(file, raw);
    assert.equal((await u.checkForUpdates(options)).status, 'up-to-date');
    assert.equal(JSON.parse(await fs.readFile(file)).lastSuccess, now);
  }
  assert.equal(u.parseState({ schema: 1, lastSuccess: 0, nextCheck: 'bad', notifiedAt: 0 }, now).nextCheck, 0);
});

test('concurrent checks share lock; only one request and notification', async t => {
  const directory = await fixture(t);
  let unblock, started;
  const waiting = new Promise(resolve => { unblock = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0, tips = 0;
  const options = { directory, fetchRelease: async () => { calls++; started(); await waiting; return release('99.0.0'); }, emit: () => tips++ };
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
    assert.deepEqual(await u.fetchLatestRelease(), release('1.6.0'));
    global.fetch = async () => new Response('no', { status: 429 });
    await assert.rejects(u.fetchLatestRelease(), /429/);
    global.fetch = async () => new Response('x'.repeat(65537));
    await assert.rejects(u.fetchLatestRelease(), /too large/);
    global.fetch = async () => new Response('{bad');
    await assert.rejects(u.fetchLatestRelease());
    global.fetch = async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const start = Date.now();
    await assert.rejects(u.fetchLatestRelease(), /aborted/);
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
  const skill = await fs.readFile(path.join(__dirname, '../skill/SKILL.md'), 'utf8');
  assert.equal(skill.match(/^  version: "([^"]+)"$/m)?.[1], pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});
