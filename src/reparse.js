const fs = require('node:fs');
const path = require('node:path');
const { materializeConversationAssets } = require('./assets');
const { readRawCache } = require('./cache');

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

function parseFrontmatter(text) {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[m[1]] = value;
  }
  return fields;
}

function sanitizeAccountKey(accountKey) {
  return String(accountKey).replace(/[/\\:*?"<>|]/g, '_');
}

async function reparseOutdated(vaultPath, provider, accountKey, options = {}) {
  if (!vaultPath || !provider?.parserVersion) return 0;
  const dir = path.join(vaultPath, provider.subdir, sanitizeAccountKey(accountKey));
  if (!fs.existsSync(dir)) return 0;

  const target = provider.parserVersion;
  let reparsed = 0;

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(dir, entry);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const fm = parseFrontmatter(content);
    if (!fm?.id) continue;
    const current = Number(fm.parser_version || 0);
    if (current >= target) continue;

    const raw = readRawCache(vaultPath, provider.subdir, accountKey, fm.id);
    if (!raw) continue;

    let regenerated;
    try {
      const conv = provider.parseFromCache ? provider.parseFromCache(raw) : raw;
      const assetPaths = await materializeConversationAssets({
        vaultPath,
        provider,
        accountKey,
        conversation: conv,
        session: options.session,
        signal: options.signal,
      });
      regenerated = provider.convertToMarkdown(conv, { assetPaths });
    } catch (e) {
      if (options.signal?.aborted || e.message === 'Request aborted') throw e;
      console.error(`[reparse] materialization failed for ${fm.id}: ${e.message}`);
      continue;
    }

    if (regenerated === content) continue;

    const tempPath = path.join(dir, `.${entry}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tempPath, regenerated, 'utf-8');
      fs.renameSync(tempPath, filePath);
      reparsed++;
    } catch (e) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
      console.error(`[reparse] write failed for ${fm.id}: ${e.message}`);
    }
  }

  return reparsed;
}

module.exports = { reparseOutdated, _test: { parseFrontmatter } };
