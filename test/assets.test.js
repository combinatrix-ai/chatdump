const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { materializeConversationAssets, _test } = require('../src/assets');

const { assetLocation, detectImageMime, findExistingAsset, writeAsset } = _test;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

test('detectImageMime recognizes supported image signatures', () => {
  assert.equal(detectImageMime(PNG), 'image/png');
  assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(detectImageMime(Buffer.from('RIFF1234WEBP', 'ascii')), 'image/webp');
  assert.equal(detectImageMime(Buffer.from('GIF89a', 'ascii')), 'image/gif');
  assert.equal(detectImageMime(Buffer.from('not an image')), '');
});

test('assetLocation uses stable assets/conversation/asset paths', () => {
  const location = assetLocation(
    '/vault',
    'chatgpt',
    'user@example.com',
    'conversation/id',
    'file:123',
    'image/png',
  );
  assert.equal(
    location.absolutePath,
    path.join('/vault', 'chatgpt', 'user@example.com', 'assets', 'conversation_id', 'file_123.png'),
  );
  assert.equal(location.relativePath, 'assets/conversation_id/file_123.png');
});

test('writeAsset validates and atomically stores image bytes', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'chatdump-assets-'));
  const asset = { id: 'file_123', mimeType: 'image/png', sizeBytes: PNG.length };
  try {
    const relativePath = writeAsset(vault, 'chatgpt', 'account', 'conversation', asset, {
      data: PNG,
      contentType: 'image/png; charset=binary',
    });
    assert.equal(relativePath, 'assets/conversation/file_123.png');
    assert.deepEqual(fs.readFileSync(path.join(vault, 'chatgpt', 'account', relativePath)), PNG);
    assert.equal(
      findExistingAsset(vault, 'chatgpt', 'account', 'conversation', asset),
      relativePath,
    );
    fs.writeFileSync(
      path.join(vault, 'chatgpt', 'account', relativePath),
      Buffer.alloc(PNG.length),
    );
    assert.equal(findExistingAsset(vault, 'chatgpt', 'account', 'conversation', asset), null);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('writeAsset rejects mismatched MIME and size', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'chatdump-assets-'));
  try {
    assert.throws(
      () =>
        writeAsset(
          vault,
          'chatgpt',
          'account',
          'conversation',
          { id: 'file_123', mimeType: 'image/jpeg', sizeBytes: PNG.length },
          { data: PNG, contentType: 'image/png' },
        ),
      /MIME mismatch/,
    );
    assert.throws(
      () =>
        writeAsset(
          vault,
          'chatgpt',
          'account',
          'conversation',
          { id: 'file_123', mimeType: 'image/png', sizeBytes: PNG.length + 1 },
          { data: PNG, contentType: 'image/png' },
        ),
      /size mismatch/,
    );
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('materializeConversationAssets downloads once and then reuses the local asset', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'chatdump-assets-'));
  const asset = { id: 'file_123', mimeType: 'image/png', sizeBytes: PNG.length };
  let downloads = 0;
  const provider = {
    subdir: 'chatgpt',
    getId: () => 'conversation',
    extractDocument: () => ({ assets: [asset] }),
    downloadAsset: async () => {
      downloads++;
      return { data: PNG, contentType: 'image/png' };
    },
  };
  const options = {
    vaultPath: vault,
    provider,
    accountKey: 'account',
    conversation: {},
  };
  try {
    assert.deepEqual(await materializeConversationAssets(options), {
      file_123: 'assets/conversation/file_123.png',
    });
    assert.deepEqual(await materializeConversationAssets(options), {
      file_123: 'assets/conversation/file_123.png',
    });
    assert.equal(downloads, 1);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
