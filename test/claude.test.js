const assert = require('node:assert/strict');
const test = require('node:test');
const { _test } = require('../src/providers/claude');

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
