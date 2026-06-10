const fs = require('node:fs');
const path = require('node:path');

function sanitizeSegment(s) {
  return String(s).replace(/[/\\:*?"<>|]/g, '_');
}

function cacheDir(vaultPath, providerSubdir, accountKey) {
  return path.join(vaultPath, '.chativist', 'cache', providerSubdir, sanitizeSegment(accountKey));
}

function cachePath(vaultPath, providerSubdir, accountKey, id) {
  return path.join(cacheDir(vaultPath, providerSubdir, accountKey), `${sanitizeSegment(id)}.json`);
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

  const tempPath = path.join(dir, `.${sanitizeSegment(id)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw e;
  }
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
