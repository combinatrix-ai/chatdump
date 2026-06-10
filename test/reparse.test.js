const assert = require('node:assert/strict');
const test = require('node:test');
const { _test } = require('../src/reparse');

const { parseFrontmatter } = _test;

test('parseFrontmatter parses simple key-value lines and strips quotes', () => {
  assert.deepEqual(
    parseFrontmatter(`---
title: "Quoted title"
source: chatgpt
id: 'abc123'
parser_version: 2
---

Body`),
    {
      title: 'Quoted title',
      source: 'chatgpt',
      id: 'abc123',
      parser_version: '2',
    },
  );
});

test('parseFrontmatter returns null when frontmatter is absent', () => {
  assert.equal(parseFrontmatter('# No frontmatter'), null);
});
