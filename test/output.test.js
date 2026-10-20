'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RawOutputBuffer, renderedCursor } = require('../dist/output');
const { truncateUtf8 } = require('../dist/protocol');

test('bounded raw reads and explicit continuation deliver every UTF-8 byte exactly once', () => {
  const text = 'abc中文🙂\nnext\r\n' + 'z'.repeat(600);
  for (const incremental of [false, true]) {
    const buffer = new RawOutputBuffer(4096);
    buffer.append(text);
    let cursor = 0, collected = '';
    for (let i = 0; i < 1000; i++) {
      const chunk = buffer.read({ ...(incremental ? { advance: true } : { since: cursor }), maxBytes: 7 });
      assert.equal(chunk.cursor - chunk.startCursor, Buffer.byteLength(chunk.output));
      assert.ok(chunk.returnedBytes <= 7);
      assert.ok(!chunk.output.includes('\ufffd'));
      collected += chunk.output;
      cursor = chunk.cursor;
      if (!chunk.truncated) break;
    }
    assert.equal(collected, text);
    assert.equal(cursor, Buffer.byteLength(text));
  }
});

test('raw cursors remain absolute after eviction and report lost bytes', () => {
  const buffer = new RawOutputBuffer(8);
  buffer.append('abc中文');
  assert.equal(buffer.end, 9);
  const initial = buffer.read({ since: 0 });
  assert.equal(initial.output, 'bc中文');
  assert.equal(initial.lostBytes, 1);
  buffer.append('defghijk');
  const next = buffer.read({ since: initial.cursor });
  assert.equal(next.startCursor, 9);
  assert.equal(next.cursor, 17);
  assert.equal(next.output, 'defghijk');
});

test('evicting a partial character never returns replacement characters', () => {
  const buffer = new RawOutputBuffer(5);
  buffer.append('中🙂a');
  assert.equal(buffer.read({ since: 0 }).output, '🙂a');
  buffer.append('b');
  const read = buffer.read({ since: 0 });
  assert.equal(read.output, 'ab');
  assert.equal(read.lostBytes, 7);
});

test('UTF-8 truncation never splits emoji or drops newline separators', () => {
  assert.equal(truncateUtf8('a\nb\nc', 4).output, 'a\nb\n');
  assert.equal(truncateUtf8('a🙂b', 5).output, 'a🙂');
  assert.throws(() => truncateUtf8('🙂', 3), /too small/);
});

test('rendered continuation keeps a byte column until its newline is delivered', () => {
  assert.equal(renderedCursor(12, 'abc中文'), '12:9');
  assert.equal(renderedCursor(12, '\nnext', 9), '13:4');
  assert.equal(renderedCursor(12, '\n', 9), 13);
});

test('rendered default reads resume within long lines without losing text', () => {
  const { Session } = require('../dist/session');
  const s = Object.create(Session.prototype);
  const text = 'abc中文🙂' + 'q'.repeat(30) + '\nlast';
  s.lastReadLineNormal = 0; s.lastReadLineAlt = 0; s.lastBufferType = 'normal';
  s.readColumns = { normal: 0, alternate: 0 };
  s.getBuffer = () => ({ type: 'normal' });
  s.findLastContentLine = () => 1;
  s.readFrom = line => text.split('\n').slice(line).join('\n');
  let collected = '';
  for (let i = 0; i < 100; i++) {
    const part = s.readRendered({ maxBytes: 7 });
    collected += part.output;
    if (!part.truncated) break;
  }
  assert.equal(collected, text);
  assert.equal(s.readRendered().output, '');
});

test('Windows startup lock resolves to a writable regular file, not a named pipe', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const protocol = require('../dist/protocol');
  const platform = os.platform, previous = process.env.PTY_BRIDGE_STATE;
  const state = path.join(os.tmpdir(), `pty-lock-test-${process.pid}.json`);
  try {
    os.platform = () => 'win32';
    process.env.PTY_BRIDGE_STATE = state;
    assert.equal(protocol.getLockPath(), state + '.lock');
    const fd = fs.openSync(protocol.getLockPath(), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.closeSync(fd);
  } finally {
    os.platform = platform;
    if (previous === undefined) delete process.env.PTY_BRIDGE_STATE;
    else process.env.PTY_BRIDGE_STATE = previous;
    try { fs.unlinkSync(state + '.lock'); } catch {}
  }
});

test('RPC client preserves Unicode when a response splits inside a UTF-8 character', async () => {
  const fs = require('node:fs'), net = require('node:net'), os = require('node:os'), path = require('node:path');
  const previous = process.env.PTY_BRIDGE_SOCKET;
  const endpoint = process.platform === 'win32'
    ? '\\\\.\\pipe\\pty-unicode-rpc-' + process.pid
    : path.join(os.tmpdir(), 'pty-unicode-rpc-' + process.pid + '.sock');
  process.env.PTY_BRIDGE_SOCKET = endpoint;
  const payload = '中文🙂'.repeat(50000);
  const server = net.createServer(socket => {
    let request = '';
    socket.on('data', chunk => {
      request += chunk.toString();
      if (!request.includes('\n')) return;
      const message = JSON.parse(request);
      if (message.method === 'ping') { socket.end(JSON.stringify({ id: message.id, result: { ok: true } }) + '\n'); return; }
      const data = Buffer.from(JSON.stringify({ id: message.id, result: { text: payload } }) + '\n');
      const cut = data.indexOf(Buffer.from('中')) + 1;
      socket.write(data.subarray(0, cut));
      setTimeout(() => socket.end(data.subarray(cut)), 10);
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    const result = await require('../dist/client').request('unicode-test');
    assert.equal(result.text, payload);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.PTY_BRIDGE_SOCKET;
    else process.env.PTY_BRIDGE_SOCKET = previous;
    if (process.platform !== 'win32') try { fs.unlinkSync(endpoint); } catch {}
  }
});
