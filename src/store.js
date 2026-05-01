const Store = require('electron-store');

const store = new Store({
  defaults: {
    // Global default vault path
    defaultVaultPath: '',
    syncIntervalMinutes: 30,

    // Accounts: array of { id, provider, email, name, plan, vaultPath?, autoSync, lastSyncedAt, timestamps }
    // id is `${provider}:${email}` e.g. "claude:user@example.com"
    accounts: [],
  },
});

// One-time migration: openai timestamps schema changed from `{ [id]: isoString }` to
// `{ [id]: { update_time, create_time, last_message_at } }`. Reset legacy entries so
// the next sync rebuilds them with the new shape. Account info is preserved.
(() => {
  const accounts = store.get('accounts') || [];
  let mutated = false;
  for (const account of accounts) {
    if (account.provider !== 'openai') continue;
    const ts = account.timestamps || {};
    const hasLegacy = Object.values(ts).some((v) => typeof v === 'string');
    if (hasLegacy) {
      account.timestamps = {};
      mutated = true;
    }
  }
  if (mutated) store.set('accounts', accounts);
})();

// --- Account helpers ---

function getAccounts() {
  return store.get('accounts') || [];
}

function getAccount(accountId) {
  return getAccounts().find((a) => a.id === accountId) || null;
}

function upsertAccount(accountData) {
  const accounts = getAccounts();
  const idx = accounts.findIndex((a) => a.id === accountData.id);
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], ...accountData };
  } else {
    accounts.push({
      autoSync: true,
      lastSyncedAt: null,
      timestamps: {},
      vaultPath: '',
      ...accountData,
    });
  }
  store.set('accounts', accounts);
}

function removeAccount(accountId) {
  const accounts = getAccounts().filter((a) => a.id !== accountId);
  store.set('accounts', accounts);
}

function updateAccount(accountId, updates) {
  const accounts = getAccounts();
  const idx = accounts.findIndex((a) => a.id === accountId);
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], ...updates };
    store.set('accounts', accounts);
  }
}

function getVaultPath(accountId) {
  const account = getAccount(accountId);
  return account?.vaultPath || store.get('defaultVaultPath') || '';
}

module.exports = {
  store,
  getAccounts,
  getAccount,
  upsertAccount,
  removeAccount,
  updateAccount,
  getVaultPath,
};
