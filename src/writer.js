const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('./atomic-write');
const { sanitizeAccountKey } = require('./path-utils');

function writeConversation(vaultPath, providerSubdir, accountKey, filename, markdownContent) {
  // Output: {vault}/{provider}/{account}/filename.md
  const sanitizedAccount = sanitizeAccountKey(accountKey);
  const dir = path.join(vaultPath, providerSubdir, sanitizedAccount);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, filename);
  const idSuffixMatch = filename.match(/_([0-9a-f]{8})\.md$/);

  if (idSuffixMatch) {
    try {
      const suffix = idSuffixMatch[0];
      for (const entry of fs.readdirSync(dir)) {
        if (entry !== filename && entry.endsWith(suffix)) {
          const stalePath = path.join(dir, entry);
          fs.unlinkSync(stalePath);
          console.log(`Deleted stale conversation file: ${stalePath}`);
        }
      }
    } catch {
      /* ignore stale duplicate cleanup failure */
    }
  }

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing === markdownContent) return false;
  }

  atomicWriteFileSync(filePath, markdownContent, 'utf-8');
  return true;
}

module.exports = { writeConversation };
