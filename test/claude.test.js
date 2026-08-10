const assert = require('node:assert/strict');
const test = require('node:test');
const claude = require('../src/providers/claude');

const { _test } = claude;

const { extractText } = _test;

test('extractText returns strings unchanged', () => {
  assert.equal(extractText('plain text'), 'plain text');
});

test('extractText formats supported array block types', () => {
  assert.equal(
    extractText([
      { type: 'text', text: 'hello' },
      { type: 'code', language: 'js', content: 'console.log("hi");' },
      { type: 'tool_use', name: 'search' },
      {
        type: 'tool_result',
        content: [
          { type: 'text', text: 'nested result' },
          { type: 'unknown', text: 'ignored' },
        ],
      },
    ]),
    ['hello', '```js\nconsole.log("hi");\n```', '*[Tool: search]*', 'nested result'].join('\n\n'),
  );
});

test('extractText stringifies non-array objects but skips unknown array block types', () => {
  assert.equal(extractText({ unknown: true }), '{"unknown":true}');
  assert.equal(extractText([{ type: 'unknown', text: 'ignored' }]), '');
});

test('convertToMarkdown and makeFilename keep the Claude archive format', () => {
  const conversation = {
    uuid: '11112222-3333-4444-5555-666677778888',
    name: 'Trip: plan/notes',
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-01-03T06:07:08.000Z',
    model: 'claude-opus-4',
    chat_messages: [
      { sender: 'human', text: 'hi' },
      { sender: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ],
  };

  assert.equal(
    claude.convertToMarkdown(conversation),
    [
      '---',
      'title: "Trip: plan/notes"',
      'created: 2026-01-02T03:04:05.000Z',
      'updated: 2026-01-03T06:07:08.000Z',
      'model: claude-opus-4',
      'source: claude',
      'id: "11112222-3333-4444-5555-666677778888"',
      'parser_version: 1',
      '---',
      '',
      '## Human',
      '',
      'hi',
      '',
      '## Assistant',
      '',
      'hello',
      '',
    ].join('\n'),
  );
  assert.equal(claude.makeFilename(conversation), '2026-01-02_Trip__plan_notes_11112222.md');
});

test('a bare Claude conversation still writes created, updated and no model', () => {
  assert.equal(
    claude.convertToMarkdown({ chat_messages: [] }),
    '---\ntitle: "Untitled"\ncreated: \nupdated: \nsource: claude\nid: ""\nparser_version: 1\n---\n\n\n',
  );
  assert.equal(claude.makeFilename({}).slice(10), '_untitled_.md');
});
