const assert = require('node:assert/strict');
const test = require('node:test');
const { addProviderFailures, partialFailureMessage } = require('../src/sync-result');

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
