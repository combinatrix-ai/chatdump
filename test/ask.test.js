const assert = require('node:assert/strict');
const test = require('node:test');

const {
  _test: { selectAskAccount },
} = require('../src/ask');
const {
  _test: { clampTimeout, extractConversationId },
} = require('../src/providers/openai-ask');

function makeStore(accounts) {
  return {
    getAccounts: () => accounts,
    getAccount: (id) => accounts.find((account) => account.id === id) || null,
  };
}

const providers = {
  getProvider: (name) => {
    if (name === 'openai')
      return { name, displayName: 'ChatGPT', askWithBrowser: async () => ({}) };
    if (name === 'claude') return { name, displayName: 'Claude' };
    return null;
  },
};

test('selectAskAccount defaults to enabled ChatGPT account', () => {
  const accounts = [
    { id: 'openai:disabled@example.com', provider: 'openai', autoSync: false },
    { id: 'openai:user@example.com', provider: 'openai', autoSync: true },
  ];

  const account = selectAskAccount({}, makeStore(accounts), providers);

  assert.equal(account.id, 'openai:user@example.com');
});

test('selectAskAccount rejects providers without browser ask support', () => {
  const accounts = [{ id: 'claude:user@example.com', provider: 'claude', autoSync: true }];

  assert.throws(
    () => selectAskAccount({ provider: 'claude' }, makeStore(accounts), providers),
    /does not support browser ask yet/,
  );
});

test('clampTimeout uses defaults and caps long timeouts', () => {
  assert.equal(clampTimeout(undefined), 180000);
  assert.equal(clampTimeout(1000), 1000);
  assert.equal(clampTimeout(999999999), 15 * 60 * 1000);
});

test('extractConversationId parses ChatGPT conversation urls', () => {
  assert.equal(extractConversationId('https://chatgpt.com/c/abc-123'), 'abc-123');
  assert.equal(extractConversationId('/c/abc-123?model=gpt'), 'abc-123');
  assert.equal(extractConversationId('https://chatgpt.com/'), '');
});
