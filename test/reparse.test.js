const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeRawCache } = require('../src/cache');
const { reparseOutdated, _test } = require('../src/reparse');

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

test('reparseOutdated materializes assets before bumping parser version', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'chatdump-reparse-'));
  const account = 'user@example.com';
  const conversationId = 'conversation-123';
  const dir = path.join(vault, 'chatgpt', account);
  const markdownPath = path.join(dir, '2026-01-01_chat_conversa.md');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const raw = { id: conversationId, title: 'Chat' };
  const provider = {
    name: 'openai',
    displayName: 'ChatGPT',
    subdir: 'chatgpt',
    parserVersion: 3,
    getId: (conversation) => conversation.id,
    parseFromCache: (conversation) => conversation,
    extractDocument: () => ({
      turns: [],
      assets: [
        {
          id: 'file_123',
          pointer: 'sediment://file_123',
          mimeType: 'image/png',
          sizeBytes: png.length,
        },
      ],
    }),
    downloadAsset: async () => ({ data: png, contentType: 'image/png' }),
    convertToMarkdown: (_conversation, options) =>
      `---\nid: "${conversationId}"\nparser_version: 3\n---\n\n![Image](${options.assetPaths.file_123})\n`,
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(markdownPath, `---\nid: "${conversationId}"\nparser_version: 2\n---\n\nOld\n`);
    writeRawCache(vault, 'chatgpt', account, conversationId, raw);

    assert.equal(await reparseOutdated(vault, provider, account), 1);
    assert.match(fs.readFileSync(markdownPath, 'utf8'), /parser_version: 3/);
    assert.match(fs.readFileSync(markdownPath, 'utf8'), /assets\/conversation-123\/file_123\.png/);
    assert.equal(fs.existsSync(path.join(dir, 'assets', conversationId, 'file_123.png')), true);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
