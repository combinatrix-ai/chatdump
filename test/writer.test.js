const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeConversation } = require('../src/writer');

test('writeConversation deletes stale duplicates by id suffix and preserves other files', () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'chativist-writer-'));
  const dir = path.join(vaultPath, 'chatgpt', 'account');
  const oldFilename = '2025-01-01_old_title_abcdef01.md';
  const newFilename = '2025-01-01_new_title_abcdef01.md';
  const otherFilename = '2025-01-01_other_title_12345678.md';
  const content = 'new content';

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, oldFilename), 'old content', 'utf-8');
    fs.writeFileSync(path.join(dir, otherFilename), 'other content', 'utf-8');

    assert.equal(writeConversation(vaultPath, 'chatgpt', 'account', newFilename, content), true);
    assert.equal(fs.existsSync(path.join(dir, oldFilename)), false);
    assert.equal(fs.readFileSync(path.join(dir, newFilename), 'utf-8'), content);
    assert.equal(fs.readFileSync(path.join(dir, otherFilename), 'utf-8'), 'other content');
    assert.equal(writeConversation(vaultPath, 'chatgpt', 'account', newFilename, content), false);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
