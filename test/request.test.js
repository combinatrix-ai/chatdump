const assert = require('node:assert/strict');
const test = require('node:test');
const { _test } = require('../src/providers/request');

const { createUtf8Accumulator, isAllowedHost, redactedHeaders } = _test;

function decodeInTwoChunks(input, offset) {
  const bytes = Buffer.from(input);
  const acc = createUtf8Accumulator();
  acc.write(bytes.subarray(0, offset));
  acc.write(bytes.subarray(offset));
  return acc.end();
}

test('createUtf8Accumulator preserves Japanese text across every byte split', () => {
  const input = '結果的に';
  const bytes = Buffer.from(input);

  for (let offset = 0; offset <= bytes.length; offset++) {
    assert.equal(decodeInTwoChunks(input, offset), input, `split at byte ${offset}`);
  }
});

test('createUtf8Accumulator preserves a 4-byte emoji split across chunks', () => {
  const input = '🙂';
  const bytes = Buffer.from(input);

  for (let offset = 0; offset <= bytes.length; offset++) {
    assert.equal(decodeInTwoChunks(input, offset), input, `split at byte ${offset}`);
  }
});

test('createUtf8Accumulator passes ASCII through', () => {
  const acc = createUtf8Accumulator();

  acc.write(Buffer.from('hello, '));
  acc.write(Buffer.from('world'));

  assert.equal(acc.end(), 'hello, world');
});

test('binary request helpers redact auth and enforce hostname boundaries', () => {
  assert.deepEqual(
    redactedHeaders({ Authorization: 'Bearer secret', Cookie: 'secret', Accept: 'image/png' }),
    { Authorization: '[redacted]', Cookie: '[redacted]', Accept: 'image/png' },
  );
  assert.equal(isAllowedHost('chatgpt.com', ['chatgpt.com'], ['oaiusercontent.com']), true);
  assert.equal(
    isAllowedHost('files.oaiusercontent.com', ['chatgpt.com'], ['oaiusercontent.com']),
    true,
  );
  assert.equal(
    isAllowedHost('oaiusercontent.com.evil.example', ['chatgpt.com'], ['oaiusercontent.com']),
    false,
  );
});
