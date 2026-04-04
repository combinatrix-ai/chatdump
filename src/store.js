const Store = require('electron-store');

const store = new Store({
  defaults: {
    vaultPath: '',
    orgId: '',
    syncIntervalMinutes: 30,
    lastSyncedAt: null,
    lastConversationTimestamps: {},
    cachedAccountInfo: null,
  },
});

module.exports = store;
