const assert = require('node:assert/strict');
const test = require('node:test');

const {
  _test: { selectAccounts, validateSyncInput },
} = require('../src/mcp');

function makeStore(accounts) {
  return {
    getAccounts: () => accounts,
    getAccount: (id) => accounts.find((account) => account.id === id) || null,
  };
}

const providers = {
  getProvider: (name) => (name === 'openai' || name === 'claude' ? { name } : null),
  allProviders: () => [{ name: 'openai' }, { name: 'claude' }],
};

test('selectAccounts filters disabled accounts by default', () => {
  const accounts = [
    { id: 'openai:a@example.com', provider: 'openai', autoSync: true },
    { id: 'claude:b@example.com', provider: 'claude', autoSync: false },
  ];

  const selected = selectAccounts({}, makeStore(accounts), providers);

  assert.deepEqual(
    selected.map((account) => account.id),
    ['openai:a@example.com'],
  );
});

test('selectAccounts can include disabled accounts', () => {
  const accounts = [
    { id: 'openai:a@example.com', provider: 'openai', autoSync: true },
    { id: 'claude:b@example.com', provider: 'claude', autoSync: false },
  ];

  const selected = selectAccounts({ includeDisabled: true }, makeStore(accounts), providers);

  assert.deepEqual(
    selected.map((account) => account.id),
    ['openai:a@example.com', 'claude:b@example.com'],
  );
});

test('selectAccounts rejects unknown providers', () => {
  assert.throws(
    () => selectAccounts({ provider: 'missing' }, makeStore([]), providers),
    /Unknown provider: missing/,
  );
});

test('validateSyncInput rejects conflicting sync modes', () => {
  assert.throws(
    () => validateSyncInput({ sinceDays: 7, fullSync: 'created_at' }),
    /cannot be used together/,
  );
});
