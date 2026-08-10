const assert = require('node:assert/strict');
const test = require('node:test');
const {
  addAccount,
  _test: { resolveAccountInfo },
} = require('../src/account-add');

const PROVIDER = {
  name: 'openai',
  displayName: 'ChatGPT',
  baseUrl: 'https://chatgpt.com',
};

function makeSession(state, label) {
  return {
    cookies: {
      get: async () => state.loginCookies,
      set: async (details) => state.cookieWrites.push({ target: label, name: details.name }),
    },
    clearStorageData: async () => state.cleared.push(label),
  };
}

function makeDeps(state, overrides = {}) {
  const sessions = new Map();
  return {
    openLoginWindow: async () => ({
      session: makeSession(state, 'temp-login'),
      accountInfo: state.accountInfo,
      cookies: state.rawCookies,
    }),
    getSession: (id) => {
      if (!sessions.has(id)) sessions.set(id, makeSession(state, id));
      return sessions.get(id);
    },
    upsertAccount: (account) => {
      state.accounts = state.accounts.filter((a) => a.id !== account.id).concat(account);
      state.upserts.push(account);
    },
    updateAccount: (id, update) => state.updates.push({ id, update }),
    removeAccount: (id) => {
      state.accounts = state.accounts.filter((a) => a.id !== id);
      state.removed.push(id);
    },
    getAccounts: () => state.accounts,
    onAccountsChanged: () => state.menuBuilds++,
    startInitialSync: (id) => state.synced.push(id),
    now: () => 1700000000000,
    logger: () => {},
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    accounts: [],
    upserts: [],
    updates: [],
    removed: [],
    cleared: [],
    synced: [],
    cookieWrites: [],
    menuBuilds: 0,
    loginCookies: [
      { domain: '.chatgpt.com', path: '/', name: 'session', value: 'v', secure: true },
    ],
    accountInfo: null,
    rawCookies: null,
    ...overrides,
  };
}

test('addAccount re-keys the account under the resolved email', async () => {
  const state = makeState();
  const provider = {
    ...PROVIDER,
    getAccountInfo: async () => ({ email: 'me@example.com', name: 'Me' }),
  };

  const result = await addAccount(provider, makeDeps(state));

  assert.deepEqual(result, { ok: true, accountId: 'openai:me@example.com' });
  // Temporary entry first, real entry second.
  assert.deepEqual(
    state.upserts.map((a) => a.id),
    ['openai:account-1700000000000', 'openai:me@example.com'],
  );
  assert.deepEqual(state.removed, ['openai:account-1700000000000']);
  assert.equal(state.upserts[1].email, 'me@example.com');
  // Cookies land in both the temporary and the real partition.
  assert.deepEqual(
    state.cookieWrites.map((c) => c.target),
    ['openai:account-1700000000000', 'openai:me@example.com'],
  );
  assert.deepEqual(state.synced, ['openai:me@example.com']);
});

test('addAccount clears the temporary partition once the account is re-keyed', async () => {
  const state = makeState();
  const provider = { ...PROVIDER, getAccountInfo: async () => ({ email: 'me@example.com' }) };

  await addAccount(provider, makeDeps(state));

  assert.deepEqual(state.cleared, ['openai:account-1700000000000']);
});

test('addAccount keeps the temporary id when only a name is known', async () => {
  const state = makeState();
  const provider = { ...PROVIDER, getAccountInfo: async () => ({ name: 'Nameless' }) };

  const result = await addAccount(provider, makeDeps(state));

  assert.deepEqual(result, { ok: true, accountId: 'openai:account-1700000000000' });
  assert.deepEqual(state.removed, []);
  assert.deepEqual(state.updates, [
    { id: 'openai:account-1700000000000', update: { name: 'Nameless' } },
  ]);
  // The entry is still a real account, so its live cookies must be kept.
  assert.deepEqual(state.cleared, []);
  assert.deepEqual(state.synced, ['openai:account-1700000000000']);
});

test('addAccount keeps an unidentified account rather than dropping the login', async () => {
  const state = makeState();
  const provider = { ...PROVIDER, getAccountInfo: async () => null };

  const result = await addAccount(provider, makeDeps(state));

  assert.deepEqual(result, { ok: true, accountId: 'openai:account-1700000000000' });
  assert.deepEqual(state.cleared, []);
  assert.deepEqual(state.synced, ['openai:account-1700000000000']);
});

test('addAccount reports a failed login without touching the store', async () => {
  const state = makeState();
  const deps = makeDeps(state, {
    openLoginWindow: async () => {
      throw new Error('Login window closed without authentication');
    },
  });

  const result = await addAccount(PROVIDER, deps);

  assert.deepEqual(result, { ok: false, error: 'Login window closed without authentication' });
  assert.deepEqual(state.upserts, []);
  assert.deepEqual(state.synced, []);
});

test('addAccount clears the partition when the flow fails after login', async () => {
  const state = makeState();
  const provider = {
    ...PROVIDER,
    getAccountInfo: async () => ({ email: 'me@example.com' }),
  };
  const deps = makeDeps(state, {
    upsertAccount: (account) => {
      state.upserts.push(account);
      throw new Error('store is full');
    },
  });

  const result = await addAccount(provider, deps);

  assert.deepEqual(result, { ok: false, error: 'store is full' });
  // The account never made it into the store, so its cookies must not linger.
  assert.deepEqual(state.cleared, ['openai:account-1700000000000']);
  assert.deepEqual(state.synced, []);
});

test('resolveAccountInfo prefers the login payload over cookies and the API', async () => {
  const provider = {
    parseAccountInfo: () => ({ email: 'payload@example.com' }),
    parseAccountFromCookies: () => ({ email: 'cookie@example.com' }),
    getAccountInfo: async () => ({ email: 'api@example.com' }),
  };

  const info = await resolveAccountInfo(provider, { accountInfo: {}, cookies: {} }, {});

  assert.equal(info.email, 'payload@example.com');
});

test('resolveAccountInfo falls back to cookies, then to the API', async () => {
  const provider = {
    parseAccountInfo: () => ({ email: '' }),
    parseAccountFromCookies: () => ({ name: 'Cookie Name' }),
    getAccountInfo: async () => ({ email: 'api@example.com' }),
  };

  const info = await resolveAccountInfo(provider, { accountInfo: {}, cookies: {} }, {});

  assert.equal(info.email, 'api@example.com');
  assert.equal(info.name, 'Cookie Name');
});

test('resolveAccountInfo swallows provider errors', async () => {
  const provider = {
    getAccountInfo: async () => {
      throw new Error('network down');
    },
  };

  assert.equal(await resolveAccountInfo(provider, {}, {}), null);
});
