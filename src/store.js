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
