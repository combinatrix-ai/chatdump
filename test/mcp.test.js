const assert = require('node:assert/strict');
const test = require('node:test');

const {
  _test: { validateSyncInput },
} = require('../src/mcp');

test('validateSyncInput rejects conflicting sync modes', () => {
  assert.throws(
    () => validateSyncInput({ sinceDays: 7, fullSync: 'created_at' }),
    /cannot be used together/,
  );
});

test('validateSyncInput accepts sinceDays alone', () => {
  assert.doesNotThrow(() => validateSyncInput({ sinceDays: 7 }));
});

test('validateSyncInput accepts fullSync alone', () => {
  assert.doesNotThrow(() => validateSyncInput({ fullSync: 'created_at' }));
});
