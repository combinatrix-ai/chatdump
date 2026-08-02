function sanitizeAccountKey(value) {
  return String(value || '').replace(/[/\\:*?"<>|]/g, '_');
}

function sanitizeFilenameTitle(value) {
  return String(value || 'untitled')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

module.exports = { sanitizeAccountKey, sanitizeFilenameTitle };
