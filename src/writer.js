const fs = require('fs');
const path = require('path');

function writeConversation(vaultPath, filename, markdownContent) {
  const dir = path.join(vaultPath, 'raw', 'claude-ai');
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, filename);

  // Only write if content changed
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing === markdownContent) return false;
  }

  fs.writeFileSync(filePath, markdownContent, 'utf-8');
  return true;
}

module.exports = { writeConversation };
