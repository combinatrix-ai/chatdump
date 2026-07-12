const fs = require('node:fs');
const path = require('node:path');

function sanitizeAccountKey(accountKey) {
  return String(accountKey).replace(/[/\\:*?"<>|]/g, '_');
}

function countSavedChats(vaultPath, providerSubdir, accountKey) {
  if (!vaultPath || !providerSubdir || !accountKey) return 0;

  const directory = path.join(vaultPath, providerSubdir, sanitizeAccountKey(accountKey));
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

module.exports = { countSavedChats };
