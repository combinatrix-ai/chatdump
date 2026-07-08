const assert = require('node:assert/strict');
const test = require('node:test');

const { encode, createLineDecoder } = require('../src/ipc-protocol');

test('encode produces a single NDJSON line', () => {
  assert.equal(
    encode({ type: 'result', id: '1', exitCode: 0 }),
    '{"type":"result","id":"1","exitCode":0}\n',
  );
});

test('createLineDecoder decodes a single complete message in one chunk', () => {
  const messages = [];
  const decoder = createLineDecoder((msg) => messages.push(msg));

  decoder.push(encode({ type: 'stdout', id: '1', text: 'hello' }));

  assert.deepEqual(messages, [{ type: 'stdout', id: '1', text: 'hello' }]);
});

test('createLineDecoder handles a line split across two chunks', () => {
  const messages = [];
  const decoder = createLineDecoder((msg) => messages.push(msg));
  const line = encode({ type: 'stdout', id: '1', text: 'hello world' });
  const splitAt = Math.floor(line.length / 2);

  decoder.push(line.slice(0, splitAt));
  assert.deepEqual(messages, []); // nothing yet -- no newline seen
  decoder.push(line.slice(splitAt));

  assert.deepEqual(messages, [{ type: 'stdout', id: '1', text: 'hello world' }]);
});

test('encode/decode round-trips a data message with a structured payload', () => {
  const messages = [];
  const decoder = createLineDecoder((msg) => messages.push(msg));

  decoder.push(
    encode({ type: 'data', id: '1', payload: { accounts: [{ id: 'openai:a@example.com' }] } }),
  );

  assert.deepEqual(messages, [
    { type: 'data', id: '1', payload: { accounts: [{ id: 'openai:a@example.com' }] } },
  ]);
});

test('createLineDecoder decodes multiple messages delivered in one chunk, including a trailing partial line', () => {
  const messages = [];
  const decoder = createLineDecoder((msg) => messages.push(msg));
  const first = encode({ type: 'progress', id: '1', state: 'syncing', message: 'a' });
  const second = encode({ type: 'progress', id: '1', state: 'syncing', message: 'b' });
  const partialThird = '{"type":"result","id":"1"'; // no trailing newline yet

  decoder.push(first + second + partialThird);

  assert.deepEqual(messages, [
    { type: 'progress', id: '1', state: 'syncing', message: 'a' },
    { type: 'progress', id: '1', state: 'syncing', message: 'b' },
  ]);

  decoder.push(',"exitCode":0}\n');

  assert.deepEqual(messages, [
    { type: 'progress', id: '1', state: 'syncing', message: 'a' },
    { type: 'progress', id: '1', state: 'syncing', message: 'b' },
    { type: 'result', id: '1', exitCode: 0 },
  ]);
});
