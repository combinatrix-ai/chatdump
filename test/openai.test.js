const assert = require('node:assert/strict');
const test = require('node:test');
const { _test } = require('../src/providers/openai');

const {
  flattenMessages,
  getCurrentPathMessages,
  getLatestMessageCreateTime,
  sanitize,
  timestampToEpochMs,
  timestampToIso,
} = _test;

function message(id, role, text, createTime) {
  return {
    id,
    author: { role },
    content: { parts: [text] },
    create_time: createTime,
  };
}

test('getCurrentPathMessages walks current node parent chain in order', () => {
  const mapping = {
    root: {
      id: 'root',
      parent: null,
      children: ['a'],
      message: message('root-message', 'system', 'root'),
    },
    a: {
      id: 'a',
      parent: 'root',
      children: ['b'],
      message: message('a-message', 'user', 'hello'),
    },
    b: {
      id: 'b',
      parent: 'a',
      children: [],
      message: message('b-message', 'assistant', 'hi'),
    },
  };

  assert.deepEqual(
    getCurrentPathMessages(mapping, 'b').map((item) => item.id),
    ['root-message', 'a-message', 'b-message'],
  );
});

test('getCurrentPathMessages falls back to BFS over roots when current node is missing', () => {
  const mapping = {
    root: {
      id: 'root',
      parent: null,
      children: ['a'],
      message: message('root-message', 'system', 'root'),
    },
    a: {
      id: 'a',
      parent: 'root',
      children: ['b'],
      message: message('a-message', 'user', 'hello'),
    },
    b: {
      id: 'b',
      parent: 'a',
      children: [],
      message: message('b-message', 'assistant', 'hi'),
    },
  };

  assert.deepEqual(
    getCurrentPathMessages(mapping, 'missing').map((item) => item.id),
    ['root-message', 'a-message', 'b-message'],
  );
});

test('getCurrentPathMessages stops on cycles in parent links', () => {
  const mapping = {
    a: {
      id: 'a',
      parent: 'b',
      children: ['b'],
      message: message('a-message', 'user', 'a'),
    },
    b: {
      id: 'b',
      parent: 'a',
      children: ['a'],
      message: message('b-message', 'assistant', 'b'),
    },
  };

  assert.deepEqual(
    getCurrentPathMessages(mapping, 'b').map((item) => item.id),
    ['a-message', 'b-message'],
  );
});

test('timestamp helpers normalize supported values', () => {
  assert.equal(timestampToEpochMs(1710000000.9), 1710000000900);
  assert.equal(timestampToIso(1710000000), '2024-03-09T16:00:00.000Z');
  assert.equal(timestampToEpochMs('2025-01-02T03:04:05.000Z'), 1735787045000);
  assert.equal(timestampToIso('2025-01-02T03:04:05.000Z'), '2025-01-02T03:04:05.000Z');
  assert.equal(timestampToEpochMs('not a date'), null);
  assert.equal(timestampToIso('not a date'), '');
});

test('getLatestMessageCreateTime picks the latest valid create_time', () => {
  assert.equal(
    getLatestMessageCreateTime([
      { create_time: 1700000000 },
      { create_time: '2025-01-02T03:04:05.000Z' },
      { create_time: 'invalid' },
    ]),
    '2025-01-02T03:04:05.000Z',
  );
  assert.equal(getLatestMessageCreateTime([{ create_time: null }]), '');
});

test('flattenMessages joins string parts and skips non-string or empty content', () => {
  assert.deepEqual(
    flattenMessages([
      {
        author: { role: 'user' },
        content: { parts: ['first', { ignored: true }, 'second'] },
      },
      {
        author: { role: 'assistant' },
        content: { parts: ['   '] },
      },
      {
        author: { role: 'assistant' },
        content: { parts: ['answer'] },
      },
    ]),
    [
      { role: 'user', text: 'first\n\nsecond' },
      { role: 'assistant', text: 'answer' },
    ],
  );
});

test('sanitize replaces unsafe characters and whitespace, then truncates to 80 chars', () => {
  assert.equal(sanitize('a/b\\c:d*e?f"g<h>i|j two\tspaces'), 'a_b_c_d_e_f_g_h_i_j_two_spaces');
  assert.equal(sanitize('x'.repeat(100)), 'x'.repeat(80));
});
