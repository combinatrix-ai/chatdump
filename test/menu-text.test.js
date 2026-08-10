const assert = require('node:assert/strict');
const test = require('node:test');
const { shortenError, truncateMenuText } = require('../src/menu-text');

test('truncateMenuText keeps short text and never exceeds the limit', () => {
  assert.equal(truncateMenuText('short'), 'short');
  assert.equal(truncateMenuText('', 10), '');
  assert.equal(truncateMenuText(null, 10), '');

  const exact = 'x'.repeat(120);
  assert.equal(truncateMenuText(exact), exact);

  const long = truncateMenuText('x'.repeat(200));
  assert.equal(long.length, 120);
  assert.equal(long, `${'x'.repeat(119)}…`);
});

test('truncateMenuText honours per-call-site limits and suffixes', () => {
  // Update-check errors: 120 -> 70, same ellipsis.
  assert.equal(truncateMenuText('e'.repeat(80), 70), `${'e'.repeat(69)}…`);
  // Activity log entries: 50 with the three-dot form.
  assert.equal(truncateMenuText('m'.repeat(50), 50, { suffix: '...' }), 'm'.repeat(50));
  assert.equal(truncateMenuText('m'.repeat(51), 50, { suffix: '...' }), `${'m'.repeat(47)}...`);
  // An explicit `keep` cuts earlier than the limit would.
  assert.equal(truncateMenuText('k'.repeat(60), 40, { keep: 37 }), `${'k'.repeat(37)}…`);
});

test('shortenError strips the sync prefix and collapses API errors', () => {
  assert.equal(shortenError(''), '');
  assert.equal(shortenError(null), '');
  assert.equal(shortenError('Sync failed: boom'), 'boom');
  assert.equal(shortenError('Sync failed: API error: 500 https://example.com body=…'), 'API 500');
  assert.equal(shortenError('API error: 429 rate limited'), 'API 429');
});

// Trimming starts above 40 characters but keeps only 37 of them, so a trimmed
// account error is 38 characters wide in the menu.
test('shortenError trims past 40 characters down to 37 plus an ellipsis', () => {
  assert.equal(shortenError('e'.repeat(39)), 'e'.repeat(39));
  assert.equal(shortenError('e'.repeat(40)), 'e'.repeat(40));
  assert.equal(shortenError('e'.repeat(41)), `${'e'.repeat(37)}…`);

  const capped = shortenError('e'.repeat(200));
  assert.equal(capped.length, 38);
  assert.equal(capped, `${'e'.repeat(37)}…`);
});
