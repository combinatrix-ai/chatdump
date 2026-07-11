const fs = require('node:fs');
const path = require('node:path');

const MIME_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

function sanitizeSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_');
}

function sanitizeAccountKey(value) {
  return String(value || '').replace(/[/\\:*?"<>|]/g, '_');
}

function normalizeMimeType(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

function detectImageMime(data) {
  if (!Buffer.isBuffer(data)) return '';
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      data.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif';
  }
  return '';
}

function assetLocation(vaultPath, providerSubdir, accountKey, conversationId, assetId, mimeType) {
  const extension = MIME_EXTENSIONS.get(normalizeMimeType(mimeType));
  if (!extension) throw new Error(`Unsupported image MIME type: ${mimeType || 'unknown'}`);

  const account = sanitizeAccountKey(accountKey);
  const conversation = sanitizeSegment(conversationId);
  const asset = sanitizeSegment(assetId);
  if (!account || !conversation || !asset) throw new Error('Invalid image asset path');

  const relativePath = path.posix.join('assets', conversation, `${asset}${extension}`);
  const absolutePath = path.join(vaultPath, providerSubdir, account, ...relativePath.split('/'));
  return { absolutePath, relativePath };
}

function findExistingAsset(vaultPath, providerSubdir, accountKey, conversationId, asset) {
  const location = assetLocation(
    vaultPath,
    providerSubdir,
    accountKey,
    conversationId,
    asset.id,
    asset.mimeType,
  );
  if (!fs.existsSync(location.absolutePath)) return null;
  const stat = fs.statSync(location.absolutePath);
  if (!stat.isFile()) return null;
  if (asset.sizeBytes > 0 && stat.size !== asset.sizeBytes) return null;
  const header = Buffer.alloc(Math.min(12, stat.size));
  const fd = fs.openSync(location.absolutePath, 'r');
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (detectImageMime(header) !== normalizeMimeType(asset.mimeType)) return null;
  return location.relativePath;
}

function writeAsset(vaultPath, providerSubdir, accountKey, conversationId, asset, download) {
  if (!Buffer.isBuffer(download?.data)) throw new Error('Image download did not return bytes');
  const detectedMime = detectImageMime(download.data);
  if (!detectedMime) throw new Error(`Invalid image data for asset ${asset.id}`);

  const expectedMime = normalizeMimeType(asset.mimeType);
  const responseMime = normalizeMimeType(download.contentType);
  if (expectedMime && expectedMime !== detectedMime) {
    throw new Error(
      `Image MIME mismatch for ${asset.id}: expected ${expectedMime}, got ${detectedMime}`,
    );
  }
  if (
    responseMime &&
    responseMime !== 'application/octet-stream' &&
    responseMime !== detectedMime
  ) {
    throw new Error(
      `Image response MIME mismatch for ${asset.id}: response ${responseMime}, got ${detectedMime}`,
    );
  }
  if (asset.sizeBytes > 0 && download.data.length !== asset.sizeBytes) {
    throw new Error(
      `Image size mismatch for ${asset.id}: expected ${asset.sizeBytes}, got ${download.data.length}`,
    );
  }

  const location = assetLocation(
    vaultPath,
    providerSubdir,
    accountKey,
    conversationId,
    asset.id,
    detectedMime,
  );
  fs.mkdirSync(path.dirname(location.absolutePath), { recursive: true });
  const tempPath = `${location.absolutePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, download.data);
    fs.renameSync(tempPath, location.absolutePath);
  } catch (e) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw e;
  }
  return location.relativePath;
}

async function materializeConversationAssets(options) {
  const { vaultPath, provider, accountKey, conversation, session, signal } = options;
  if (typeof provider.extractDocument !== 'function') return {};
  const document = provider.extractDocument(conversation);
  if (!document.assets?.length) return {};
  if (typeof provider.downloadAsset !== 'function') {
    throw new Error(`${provider.displayName || provider.name} cannot download image assets`);
  }

  const conversationId = provider.getId?.(conversation) || conversation.id || conversation.uuid;
  const assetPaths = {};
  for (const asset of document.assets) {
    if (signal?.aborted) throw new Error('Request aborted');
    const existing = findExistingAsset(
      vaultPath,
      provider.subdir,
      accountKey,
      conversationId,
      asset,
    );
    if (existing) {
      assetPaths[asset.id] = existing;
      continue;
    }
    const download = await provider.downloadAsset(session, asset, { signal });
    assetPaths[asset.id] = writeAsset(
      vaultPath,
      provider.subdir,
      accountKey,
      conversationId,
      asset,
      download,
    );
  }
  return assetPaths;
}

module.exports = {
  materializeConversationAssets,
  _test: {
    assetLocation,
    detectImageMime,
    findExistingAsset,
    normalizeMimeType,
    sanitizeSegment,
    writeAsset,
  },
};
