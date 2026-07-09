const assert = require('node:assert/strict');
const test = require('node:test');

const {
  _test: { selectConversationAccount, parseConversationRef },
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
      return {
        name,
        displayName: 'ChatGPT',
        fetchConversationById: async () => ({}),
        fetchSharedConversationById: async () => ({}),
      };
    if (name === 'claude') return { name, displayName: 'Claude' };
    return null;
  },
};

test('selectConversationAccount defaults to enabled ChatGPT account', () => {
  const accounts = [
    { id: 'openai:disabled@example.com', provider: 'openai', autoSync: false },
    { id: 'openai:user@example.com', provider: 'openai', autoSync: true },
  ];

  const account = selectConversationAccount({}, 'conversation', makeStore(accounts), providers);

  assert.equal(account.id, 'openai:user@example.com');
});

test('selectConversationAccount rejects unsupported providers', () => {
  const accounts = [{ id: 'claude:user@example.com', provider: 'claude', autoSync: true }];

  assert.throws(
    () =>
      selectConversationAccount(
        { provider: 'claude' },
        'conversation',
        makeStore(accounts),
        providers,
      ),
    /does not support conversation fetch by id yet/,
  );
});

test('selectConversationAccount rejects share fetch when provider lacks it', () => {
  const accounts = [{ id: 'claude:user@example.com', provider: 'claude', autoSync: true }];

  assert.throws(
    () =>
      selectConversationAccount({ provider: 'claude' }, 'share', makeStore(accounts), providers),
    /does not support fetching shared conversations yet/,
  );
});

test('parseConversationRef reads a bare id', () => {
  assert.deepEqual(parseConversationRef('abc-123'), { kind: 'conversation', id: 'abc-123' });
});

test('parseConversationRef reads a /c/ conversation URL', () => {
  assert.deepEqual(
    parseConversationRef('https://chatgpt.com/c/11111111-2222-4333-8444-555555555555'),
    { kind: 'conversation', id: '11111111-2222-4333-8444-555555555555' },
  );
});

test('parseConversationRef reads a share URL', () => {
  assert.deepEqual(
    parseConversationRef('https://chatgpt.com/share/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    { kind: 'share', id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  );
});

test('parseConversationRef rejects an empty ref', () => {
  assert.throws(() => parseConversationRef('  '), /conversationId is required/);
});

test('parseConversationRef rejects an unrelated URL', () => {
  assert.throws(() => parseConversationRef('https://example.com/foo'), /Unrecognized ChatGPT URL/);
});
