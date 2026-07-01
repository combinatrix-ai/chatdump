const assert = require('node:assert/strict');
const test = require('node:test');

const {
  _test: { selectConversationAccount },
} = require('../src/conversation');

function makeStore(accounts) {
  return {
    getAccounts: () => accounts,
    getAccount: (id) => accounts.find((account) => account.id === id) || null,
  };
}

const providers = {
  getProvider: (name) => {
    if (name === 'openai')
      return { name, displayName: 'ChatGPT', fetchConversationById: async () => ({}) };
    if (name === 'claude') return { name, displayName: 'Claude' };
    return null;
  },
};

test('selectConversationAccount defaults to enabled ChatGPT account', () => {
  const accounts = [
    { id: 'openai:disabled@example.com', provider: 'openai', autoSync: false },
    { id: 'openai:user@example.com', provider: 'openai', autoSync: true },
  ];

  const account = selectConversationAccount({}, makeStore(accounts), providers);

  assert.equal(account.id, 'openai:user@example.com');
});

test('selectConversationAccount rejects unsupported providers', () => {
  const accounts = [{ id: 'claude:user@example.com', provider: 'claude', autoSync: true }];

  assert.throws(
    () => selectConversationAccount({ provider: 'claude' }, makeStore(accounts), providers),
    /does not support conversation fetch by id yet/,
  );
});
