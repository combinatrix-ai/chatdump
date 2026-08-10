const assert = require('node:assert/strict');
const test = require('node:test');
const { conversationFilename, conversationMarkdown } = require('../src/providers/markdown');

test('conversationMarkdown writes every optional field when present', () => {
  assert.equal(
    conversationMarkdown(
      {
        title: 'Trip: plan/notes',
        created: '2026-01-02T03:04:05.000Z',
        updated: '2026-01-03T06:07:08.000Z',
        model: 'gpt-5',
        source: 'chatgpt',
        id: 'abc',
        parserVersion: 4,
      },
      '## User\n\nhi',
    ),
    [
      '---',
      'title: "Trip: plan/notes"',
      'created: 2026-01-02T03:04:05.000Z',
      'updated: 2026-01-03T06:07:08.000Z',
      'model: gpt-5',
      'source: chatgpt',
      'id: "abc"',
      'parser_version: 4',
      '---',
      '',
      '## User',
      '',
      'hi',
      '',
    ].join('\n'),
  );
});

test('conversationMarkdown keeps a blank updated line but omits an empty model', () => {
  assert.equal(
    conversationMarkdown({ source: 'claude', updated: '', parserVersion: 1 }, ''),
    [
      '---',
      'title: "Untitled"',
      'created: ',
      'updated: ',
      'source: claude',
      'id: ""',
      'parser_version: 1',
      '---',
      '',
      '',
      '',
    ].join('\n'),
  );
});

test('conversationMarkdown drops the updated line for providers that have no update time', () => {
  const markdown = conversationMarkdown(
    {
      title: 'Chat',
      created: '2026-01-02T00:00:00.000Z',
      source: 'gemini',
      id: 'c_1',
      parserVersion: 1,
    },
    'body',
  );
  assert.equal(markdown.includes('updated:'), false);
  assert.equal(markdown.includes('model:'), false);
});

test('conversationFilename joins date, sanitized title and id suffix', () => {
  assert.equal(
    conversationFilename({
      date: '2026-01-02T03:04:05.000Z',
      title: 'Trip: plan/notes',
      id: '11112222-3333',
    }),
    '2026-01-02_Trip__plan_notes_11112222.md',
  );
});

test('conversationFilename falls back to today and an untitled placeholder', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(conversationFilename({}), `${today}_untitled_.md`);
  assert.equal(conversationFilename({ date: '', title: '', id: '' }), `${today}_untitled_.md`);
});
