const assert = require('node:assert/strict');
const test = require('node:test');
const { selectCapableAccount } = require('../src/account-selection');

test('selectCapableAccount does not treat auto-sync as account enablement', () => {
  const accounts = [{ id: 'openai:off@example.com', provider: 'openai', autoSync: false }];
  const store = {
    getAccounts: () => accounts,
    getAccount: (id) => accounts.find((account) => account.id === id),
  };
  const providers = {
    getProvider: () => ({ displayName: 'ChatGPT', askWithBrowser: async () => ({}) }),
  };
  assert.equal(
    selectCapableAccount({}, store, providers, 'askWithBrowser', 'browser ask'),
    accounts[0],
  );
});

test('selectCapableAccount validates provider when an account is explicit', () => {
  const accounts = [{ id: 'openai:user@example.com', provider: 'openai' }];
  const store = {
    getAccounts: () => accounts,
    getAccount: (id) => accounts.find((account) => account.id === id),
  };
  const providers = {
    getProvider: (name) =>
      name === 'openai' ? { displayName: 'ChatGPT', askWithBrowser: async () => ({}) } : null,
  };
  assert.throws(
    () =>
      selectCapableAccount(
        { accountId: 'openai:user@example.com', provider: 'claude' },
        store,
        providers,
        'askWithBrowser',
        'browser ask',
      ),
    /belongs to openai, not the requested provider claude/,
  );
});
