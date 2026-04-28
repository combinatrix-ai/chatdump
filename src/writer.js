const fs = require('node:fs');
const path = require('node:path');

function writeConversation(vaultPath, providerSubdir, accountEmail, filename, markdownContent) {
  // Output: {vault}/raw/{provider}/{email}/filename.md
  const sanitizedEmail = accountEmail.replace(/[/\\:*?"<>|]/g, '_');
  const dir = path.join(vaultPath, 'raw', providerSubdir, sanitizedEmail);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, filename);

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing === markdownContent) return false;
  }

  fs.writeFileSync(filePath, markdownContent, 'utf-8');
  return true;
}

module.exports = { writeConversation };
