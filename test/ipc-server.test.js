const assert = require('node:assert/strict');
const test = require('node:test');

const {
  _test: { accountSummary, selectAccounts, handleList, handleSync, dispatch },
} = require('../src/ipc-server');

function makeStore(accounts) {
  return {
    getAccounts: () => accounts,
    getAccount: (id) => accounts.find((account) => account.id === id) || null,
    getVaultPath: () => '/vault',
  };
}

const providers = {
  getProvider: (name) => (name === 'openai' || name === 'claude' ? { name } : null),
  allProviders: () => [{ name: 'openai' }, { name: 'claude' }],
};

function collector() {
  const sent = [];
  return { sent, send: (partial) => sent.push(partial) };
}

test('accountSummary shapes an account for CLI output', () => {
  const store = makeStore([]);
  const summary = accountSummary(
    { id: 'openai:a@example.com', provider: 'openai', autoSync: true },
    store,
  );
  assert.equal(summary.id, 'openai:a@example.com');
  assert.equal(summary.vaultPath, '/vault');
  assert.equal(summary.autoSync, true);
});

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

test('selectAccounts rejects unknown providers', () => {
  assert.throws(
    () => selectAccounts({ provider: 'missing' }, makeStore([]), providers),
    /Unknown provider: missing/,
  );
});

test('handleList sends one stdout block per account and returns exit code 0', () => {
  const accounts = [{ id: 'openai:a@example.com', provider: 'openai', autoSync: true }];
  const { sent, send } = collector();

  const exitCode = handleList({}, send, { store: makeStore(accounts) });

  assert.equal(exitCode, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'stdout');
  assert.match(sent[0].text, /openai:a@example\.com/);
});

test('handleList in json mode sends a single JSON stdout message', () => {
  const accounts = [{ id: 'openai:a@example.com', provider: 'openai', autoSync: true }];
  const { sent, send } = collector();

  handleList({ json: true }, send, { store: makeStore(accounts) });

  assert.equal(sent.length, 1);
  const parsed = JSON.parse(sent[0].text);
  assert.equal(parsed.accounts.length, 1);
});

test('handleSync returns exit code 2 when no accounts match', async () => {
  const { sent, send } = collector();

  const exitCode = await handleSync({ includeDisabled: true }, send, {
    store: makeStore([]),
    scheduler: {},
    providers,
  });

  assert.equal(exitCode, 2);
  assert.equal(
    sent.some((m) => m.type === 'progress' && /No matching accounts/.test(m.message)),
    true,
  );
});

test('handleSync returns 0 when all synced accounts succeed', async () => {
  const accounts = [{ id: 'openai:a@example.com', provider: 'openai', autoSync: true }];
  const store = makeStore(accounts);
  const scheduler = {
    syncAccount: async (accountId, onStatus) => {
      onStatus('syncing', 'Fetching...', accountId);
    },
  };
  const { sent, send } = collector();

  const exitCode = await handleSync({}, send, { store, scheduler, providers });

  assert.equal(exitCode, 0);
  const done = sent.find((m) => m.state === 'done');
  assert.equal(done.message, 'ok');
});

test('handleSync returns 3 when an account fails', async () => {
  const accounts = [{ id: 'openai:a@example.com', provider: 'openai', autoSync: true }];
  const store = {
    getAccounts: () => accounts,
    getAccount: () => ({ ...accounts[0], lastError: 'boom' }),
    getVaultPath: () => '/vault',
  };
  const scheduler = { syncAccount: async () => {} };
  const { send } = collector();

  const exitCode = await handleSync({}, send, { store, scheduler, providers });

  assert.equal(exitCode, 3);
});

test('dispatch routes list/accounts/sync and rejects unknown commands', async () => {
  const accounts = [{ id: 'openai:a@example.com', provider: 'openai', autoSync: true }];
  const store = makeStore(accounts);
  const scheduler = { syncAccount: async (id, onStatus) => onStatus('idle', 'done', id) };
  const deps = { store, scheduler, providers };
  const { send } = collector();

  assert.equal(await dispatch({ cmd: 'list', args: {} }, send, deps), 0);
  assert.equal(await dispatch({ cmd: 'accounts', args: {} }, send, deps), 0);
  assert.equal(await dispatch({ cmd: 'sync', args: {} }, send, deps), 0);
  await assert.rejects(
    () => dispatch({ cmd: 'bogus', args: {} }, send, deps),
    /Unsupported command/,
  );
});
