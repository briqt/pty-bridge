'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractExecOutput, findSentinel, locateEchoEnd, echoSearchRows } = require('../dist/exec-output');

const M = 'PTYBRIDGE_DONE_ab12cd34:';
const row = (text, wrapped = false) => ({ text, wrapped });

test('a command echo wrapped over several rows is removed with the sentinel and next prompt', () => {
  const rows = [
    row('$ echo aaaaaaaaaaaa bbbbbbbbbbbb'),
    row('cccc RESULT; echo PTYBRIDGE_DONE', true),
    row('_ab12cd34:$?', true),
    row('aaaaaaaaaaaa bbbbbbbbbbbb cccc RE'),
    row('SULT', true),
    row(`${M}0`),
    row('$'),
  ];
  const out = extractExecOutput(rows, 1, { tail: `${M}$?`, marker: M });
  assert.deepEqual(out, { output: 'aaaaaaaaaaaa bbbbbbbbbbbb cccc RE\nSULT', bodyRow: 3, matched: true, exitCode: 0 });
});

test('the echo is found even when a line editor breaks rows without soft-wrap flags', () => {
  const rows = [row('% ls; echo PTYB'), row('RIDGE_DONE_ab12cd34:$?'), row('file'), row(`${M}2`), row('%')];
  const out = extractExecOutput(rows, 1, { tail: `${M}$?`, marker: M });
  assert.equal(out.output, 'file');
  assert.equal(out.exitCode, 2);
});

test('output without a trailing newline is kept in front of the sentinel', () => {
  const rows = [row(`$ printf abc; echo ${M}$?`), row(`abc${M}0`), row('$')];
  assert.equal(extractExecOutput(rows, 1, { tail: `${M}$?`, marker: M }).output, 'abc');
});

test('a sentinel split by a narrow terminal still matches, but not across hard line breaks', () => {
  const rows = [row('hi'), row('PTYBRIDGE_DO'), row('NE_ab12cd34:', true), row('17', true), row('9 prompt')];
  assert.deepEqual(findSentinel(rows, 0, M), { row: 1, col: 0, exitCode: 17, atEnd: false });
  assert.equal(findSentinel([row('PTYBRIDGE_DONE_ab12cd34:'), row('0')], 0, M), null);
});

test('a trailing exit code is reported as possibly incomplete', () => {
  assert.equal(findSentinel([row(`${M}1`)], 0, M).atEnd, true);
});

test('the echoed sentinel itself never counts as completion', () => {
  assert.equal(findSentinel([row(`$ true; echo ${M}$?`)], 0, M), null);
});

test('without a visible echo the default body row is used and nothing is lost', () => {
  const rows = [row('$'), row(''), row('err'), row(`${M}1`), row('$')];
  assert.equal(extractExecOutput(rows, 1, { tail: `${M}$?`, marker: M }).output, '\nerr');
});

test('a still-running command returns everything after its echo', () => {
  const rows = [row(`$ sleep 5; echo ${M}$?`), row('partial')];
  const out = extractExecOutput(rows, 1, { tail: `${M}$?`, marker: M });
  assert.deepEqual([out.output, out.matched], ['partial', false]);
});

test('plain exec strips a wrapped echo but keeps the program prompt', () => {
  const cmd = "print('xxxxxxxxxxxxxxxxxxxx yyyy')";
  const rows = [row(">>> print('xxxxxxxxxxxxxxxxxxxx"), row(" yyyy')", true), row('xxxxxxxxxxxxxxxxxxxx yyyy'), row('>>>')];
  const out = extractExecOutput(rows, 1, { tail: cmd, rows: echoSearchRows(cmd, 30) });
  assert.equal(out.output, 'xxxxxxxxxxxxxxxxxxxx yyyy\n>>>');
});

test('plain exec only looks for its echo near the prompt', () => {
  const rows = [row('$'), row('a'), row('b'), row('c'), row('echo far')];
  assert.equal(locateEchoEnd(rows, 'echo far', 3), -1);
  assert.equal(locateEchoEnd(rows, 'echo far'), 5);
});
