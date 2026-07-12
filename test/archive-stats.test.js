const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { countSavedChats } = require('../src/archive-stats');

test('counts only Markdown files in the account archive directory', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'chatdump-stats-'));
  try {
    const accountDir = path.join(vault, 'chatgpt', 'user@example.com');
    fs.mkdirSync(path.join(accountDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(accountDir, 'one.md'), 'one');
    fs.writeFileSync(path.join(accountDir, 'two.md'), 'two');
    fs.writeFileSync(path.join(accountDir, 'raw.json'), '{}');
    fs.writeFileSync(path.join(accountDir, 'assets', 'nested.md'), 'not a chat');

    assert.equal(countSavedChats(vault, 'chatgpt', 'user@example.com'), 2);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('returns zero when the vault or account directory is unavailable', () => {
  assert.equal(countSavedChats('', 'chatgpt', 'user@example.com'), 0);
  assert.equal(countSavedChats('/missing', 'chatgpt', 'user@example.com'), 0);
});
