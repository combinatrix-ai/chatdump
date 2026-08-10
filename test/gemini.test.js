const assert = require('node:assert/strict');
const test = require('node:test');
const gemini = require('../src/providers/gemini');

const { _test } = gemini;

const { parseConversationListResult, parseConversationMessages, parseFrames } = _test;

function frameBlock(frames) {
  const json = JSON.stringify(frames);
  return `${Buffer.byteLength(json)}\n${json}`;
}

function batchexecuteResponse(frameGroups) {
  return `)]}'\n\n${frameGroups.map(frameBlock).join('\n')}\n`;
}

test('parseFrames parses length-prefixed batchexecute frames', () => {
  const inner = JSON.stringify([
    null,
    'next-token',
    [['c_1', 'First chat', null, null, null, [1710000000]]],
  ]);
  const response = batchexecuteResponse([
    [
      ['wrb.fr', 'MaZiqc', inner, null, null, null, 'generic'],
      ['di', 141],
    ],
    [['e', 4, null, null, 277]],
  ]);

  assert.deepEqual(parseFrames(response), [
    ['wrb.fr', 'MaZiqc', inner, null, null, null, 'generic'],
    ['di', 141],
    ['e', 4, null, null, 277],
  ]);
});

test('parseConversationListResult extracts conversations, next token, and frameSeen', () => {
  const listData = JSON.stringify([
    null,
    'page-token-2',
    [
      ['c_first', 'First title', null, null, null, [1710000000]],
      ['c_second', 'Second title', null, null, null, [1710000123]],
    ],
  ]);
  const response = batchexecuteResponse([
    [
      ['wrb.fr', 'MaZiqc', listData, null, null, null, 'generic'],
      ['di', 141],
    ],
  ]);

  assert.deepEqual(parseConversationListResult(response), {
    conversations: [
      { id: 'c_first', title: 'First title', timestamp: 1710000000000 },
      { id: 'c_second', title: 'Second title', timestamp: 1710000123000 },
    ],
    frameSeen: true,
    nextToken: 'page-token-2',
  });
});

test('parseConversationListResult reports frameSeen=false when no MaZiqc frame exists', () => {
  assert.deepEqual(parseConversationListResult(batchexecuteResponse([[['e', 4, null]]])), {
    conversations: [],
    frameSeen: false,
    nextToken: null,
  });
});

test('parseConversationMessages extracts user and model text from turns', () => {
  const messageData = JSON.stringify([
    [[null, null, [['User prompt']], [[['rc_1', ['Model answer']]]]]],
  ]);
  const response = batchexecuteResponse([[['wrb.fr', 'hNvQHb', messageData, null, null, null]]]);

  assert.deepEqual(parseConversationMessages(response), [
    { role: 'user', text: 'User prompt' },
    { role: 'model', text: 'Model answer' },
  ]);
});

test('convertToMarkdown and makeFilename keep the Gemini archive format', () => {
  const conversation = {
    id: 'c_abcdef0123456789',
    title: 'Gemini: chat',
    timestamp: 1767322445000,
    messages: [
      { role: 'user', text: 'hi' },
      { role: 'model', text: 'hello' },
    ],
  };

  assert.equal(
    gemini.convertToMarkdown(conversation),
    [
      '---',
      'title: "Gemini: chat"',
      'created: 2026-01-02T02:54:05.000Z',
      'source: gemini',
      'id: "c_abcdef0123456789"',
      'parser_version: 1',
      '---',
      '',
      '## User',
      '',
      'hi',
      '',
      '## Assistant',
      '',
      'hello',
      '',
    ].join('\n'),
  );
  // The frontmatter keeps the c_ prefix; the filename drops it.
  assert.equal(gemini.makeFilename(conversation), '2026-01-02_Gemini__chat_abcdef01.md');
});

test('a bare Gemini conversation writes no updated line', () => {
  assert.equal(
    gemini.convertToMarkdown({ messages: [] }),
    '---\ntitle: "Untitled"\ncreated: \nsource: gemini\nid: ""\nparser_version: 1\n---\n\n\n',
  );
  assert.equal(gemini.makeFilename({}).slice(10), '_untitled_.md');
});
