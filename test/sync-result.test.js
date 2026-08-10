const assert = require('node:assert/strict');
const test = require('node:test');
const {
  addProviderFailures,
  partialFailureMessage,
  syncStartLabel,
  syncSummaryMessage,
} = require('../src/sync-result');

test('provider failures are deduplicated and surfaced as a partial sync error', () => {
  const details = new Map([['conversation-1', 'write failed']]);
  const count = addProviderFailures(details, [
    { id: 'conversation-1', error: 'fetch failed' },
    { id: 'conversation-2', error: 'parse failed' },
  ]);

  assert.equal(count, 2);
  assert.equal(partialFailureMessage(count), '2 conversation(s) failed during sync');
  assert.equal(partialFailureMessage(0), null);
});

test('syncStartLabel names the window a sync is about to cover', () => {
  assert.equal(syncStartLabel({}), 'Sync started');
  assert.equal(syncStartLabel({ mode: 'sync' }), 'Sync started');
  assert.equal(syncStartLabel({ sinceDays: 30 }), 'Sync started (last 30d)');
  assert.equal(syncStartLabel({ sinceDays: 0 }), 'Sync started (last 0d)');
  assert.equal(
    syncStartLabel({ mode: 'full-sync:created_at', sinceDays: 30 }),
    'Full sync started (created_at)',
  );
});

test('syncSummaryMessage reports stop, partial failure, progress and no-op runs', () => {
  assert.equal(
    syncSummaryMessage({ stopped: true, written: 2, fetched: 5, failedConversations: 1 }),
    'Stopped: 2 files written, 5 fetched',
  );
  assert.equal(
    syncSummaryMessage({ written: 2, fetched: 5, failedConversations: 1 }),
    'Partial sync: 2 files (1 failed, 5 fetched)',
  );
  assert.equal(syncSummaryMessage({ written: 2, fetched: 5 }), 'Synced 2 files (5 fetched)');
  assert.equal(syncSummaryMessage({ totalConvs: 7 }), 'Up to date (7 checked)');
  assert.equal(syncSummaryMessage(), 'Up to date (0 checked)');
});
