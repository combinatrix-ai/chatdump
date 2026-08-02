const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('./atomic-write');
const { sanitizeAccountKey } = require('./path-utils');

function cacheDir(vaultPath, providerSubdir, accountKey) {
  return path.join(vaultPath, '.chatdump', 'cache', providerSubdir, sanitizeAccountKey(accountKey));
}

function cachePath(vaultPath, providerSubdir, accountKey, id) {
  return path.join(
    cacheDir(vaultPath, providerSubdir, accountKey),
    `${sanitizeAccountKey(id)}.json`,
  );
}

function writeRawCache(vaultPath, providerSubdir, accountKey, id, data) {
  if (!id) return false;
  const dir = cacheDir(vaultPath, providerSubdir, accountKey);
  fs.mkdirSync(dir, { recursive: true });

  const content = typeof data === 'string' ? data : JSON.stringify(data);
  const filePath = cachePath(vaultPath, providerSubdir, accountKey, id);

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing === content) return false;
  }

  atomicWriteFileSync(filePath, content, 'utf-8');
  return true;
}

function readRawCache(vaultPath, providerSubdir, accountKey, id) {
  const filePath = cachePath(vaultPath, providerSubdir, accountKey, id);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

module.exports = { writeRawCache, readRawCache };
