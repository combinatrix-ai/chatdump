// Text shaping for tray menu labels. Kept out of tray.js so it can be tested
// without an Electron menu.

// Truncate to at most `maxLength` characters, including the suffix. Callers
// pick the suffix because the menu mixes the typographic ellipsis with the
// three-dot form used in the activity log.
function truncateMenuText(value, maxLength = 120, suffix = '…') {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - suffix.length)}${suffix}`;
}

const ERROR_MAX_LENGTH = 40;

// Turn a stored lastError into a one-line menu suffix.
function shortenError(msg) {
  if (!msg) return '';
  // Strip common prefix and trim down for the menu
  const s = String(msg).replace(/^Sync failed:\s*/i, '');
  // For "API error: 500 https://… body=…" keep just status
  const apiMatch = s.match(/^API error:\s*(\d+)/i);
  if (apiMatch) return `API ${apiMatch[1]}`;
  return truncateMenuText(s, ERROR_MAX_LENGTH);
}

module.exports = { shortenError, truncateMenuText };
