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
