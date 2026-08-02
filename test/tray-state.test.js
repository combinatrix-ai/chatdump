const assert = require('node:assert/strict');
const test = require('node:test');
const { getTrayIconState } = require('../src/tray-state');

test('re-login and sync errors take priority over syncing in the tray icon', () => {
  assert.equal(getTrayIconState([{ status: 'expired' }], 0), 'attention');
  assert.equal(getTrayIconState([{ status: 'expired' }], 1), 'attention');
  assert.equal(getTrayIconState([{ status: 'ok', lastError: 'Sync failed' }], 1), 'attention');
});

test('tray icon shows syncing or idle when no account needs attention', () => {
  assert.equal(getTrayIconState([{ status: 'ok', lastError: null }], 1), 'syncing');
  assert.equal(getTrayIconState([{ status: 'ok', lastError: null }], 0), 'idle');
  assert.equal(getTrayIconState([], 0), 'idle');
});
