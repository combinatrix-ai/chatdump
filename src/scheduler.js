const { store, getAccounts, getAccount, updateAccount, getVaultPath } = require('./store');
const { ensureAuthenticated, openLoginWindow } = require('./auth');
const { getProvider } = require('./providers');
const { writeConversation } = require('./writer');

let intervalId = null;
let onMenuRefresh = null;

function setMenuRefreshCallback(cb) {
  onMenuRefresh = cb;
}

async function syncAccount(accountId, onStatus) {
  const account = getAccount(accountId);
  if (!account) return;

  const provider = getProvider(account.provider);
  if (!provider) return;

  const vaultPath = getVaultPath(accountId);
  if (!vaultPath) {
    onStatus?.('error', `${provider.displayName}: No vault path`, accountId);
    return;
  }

  onStatus?.('syncing', `${provider.displayName}: Authenticating...`, accountId);

  try {
    await ensureAuthenticated(account.provider);
  } catch (e) {
    onStatus?.('error', `${provider.displayName}: Login required`, accountId);
    updateAccount(accountId, { status: 'expired' });
    onMenuRefresh?.();
    return;
  }

  onStatus?.('syncing', `${provider.displayName}: Fetching...`, accountId);

  try {
    const timestamps = account.timestamps || {};
    const conversations = await provider.fetchConversations(timestamps, (current, total) => {
      onStatus?.('syncing', `${provider.displayName}: ${current}/${total}`, accountId);
    });

    let written = 0;
    for (const conv of conversations) {
      const md = provider.convertToMarkdown(conv);
      const filename = provider.makeFilename(conv);
      const changed = writeConversation(vaultPath, provider.subdir, account.email, filename, md);
      if (changed) written++;
    }

    const now = new Date().toISOString();
    updateAccount(accountId, {
      timestamps,
      lastSyncedAt: now,
      status: 'ok',
    });

    const msg = written > 0 ? `Synced ${written} files` : 'Up to date';
    onStatus?.('idle', `${provider.displayName}: ${msg}`, accountId);
  } catch (e) {
    if (e.message === 'AUTH_EXPIRED') {
      onStatus?.('error', `${provider.displayName}: Session expired`, accountId);
      updateAccount(accountId, { status: 'expired' });
    } else {
      onStatus?.('error', `${provider.displayName}: ${e.message}`, accountId);
      console.error(`[${account.provider}] Sync error:`, e);
    }
  }

  onMenuRefresh?.();
}

async function syncAll(onStatus) {
  const accounts = getAccounts().filter((a) => a.autoSync);
  for (const account of accounts) {
    await syncAccount(account.id, onStatus);
  }
}

function startScheduler(onStatus) {
  const minutes = store.get('syncIntervalMinutes') || 30;
  stopScheduler();
  intervalId = setInterval(() => syncAll(onStatus), minutes * 60 * 1000);
  syncAll(onStatus);
}

function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { syncAccount, syncAll, startScheduler, stopScheduler, setMenuRefreshCallback };
