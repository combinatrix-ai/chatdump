const { store, getAccounts, getAccount, updateAccount, getVaultPath } = require('./store');
const { ensureAuthenticated, openLoginWindow, getSession } = require('./auth');
const { getProvider } = require('./providers');
const { writeConversation } = require('./writer');
const { appendLog } = require('./synclog');

let intervalId = null;
let onMenuRefresh = null;
const syncingAccounts = new Set();

function setMenuRefreshCallback(cb) {
  onMenuRefresh = cb;
}

function isSyncing(accountId) {
  return syncingAccounts.has(accountId);
}

async function syncAccount(accountId, onStatus) {
  if (syncingAccounts.has(accountId)) {
    console.log(`[sync] ${accountId} already syncing, skipping`);
    return;
  }

  const account = getAccount(accountId);
  if (!account) return;

  const provider = getProvider(account.provider);
  if (!provider) return;

  syncingAccounts.add(accountId);

  const vaultPath = getVaultPath(accountId);
  if (!vaultPath) {
    const msg = 'No vault path configured';
    appendLog(accountId, { level: 'error', message: msg });
    updateAccount(accountId, { lastError: msg });
    onStatus?.('error', `${provider.displayName}: ${msg}`, accountId);
    onMenuRefresh?.();
    return;
  }

  appendLog(accountId, { level: 'info', message: 'Sync started' });
  onStatus?.('syncing', `${provider.displayName}: Authenticating...`, accountId);

  try {
    await ensureAuthenticated(account.provider, accountId);
  } catch (e) {
    const msg = 'Login required — session missing or expired';
    appendLog(accountId, { level: 'error', message: msg });
    updateAccount(accountId, { status: 'expired', lastError: msg });
    onStatus?.('error', `${provider.displayName}: ${msg}`, accountId);
    onMenuRefresh?.();
    return;
  }

  onStatus?.('syncing', `${provider.displayName}: Fetching...`, accountId);

  try {
    const ses = getSession(accountId);
    const timestamps = account.timestamps || {};
    let totalConvs = 0;

    let written = 0;
    let fetched = 0;
    let saveCounter = 0;

    // onConversation callback: write each conversation immediately as it's fetched
    const onConversation = (conv) => {
      fetched++;
      try {
        const md = provider.convertToMarkdown(conv);
        const filename = provider.makeFilename(conv);
        const changed = writeConversation(vaultPath, provider.subdir, account.email, filename, md);
        if (changed) written++;
      } catch (e) {
        console.error(`[${account.provider}] Write error:`, e.message);
      }
    };

    const conversations = await provider.fetchConversations(ses, timestamps, (current, total) => {
      totalConvs = total;
      onStatus?.('syncing', `${provider.displayName}: ${current}/${total} (${written} written)`, accountId);
      saveCounter++;
      if (saveCounter % 25 === 0) {
        updateAccount(accountId, { timestamps, lastSyncedAt: new Date().toISOString() });
        onMenuRefresh?.();
      }
    }, onConversation);

    // Write any remaining conversations returned as array (for providers that don't use onConversation)
    for (const conv of conversations) {
      onConversation(conv);
    }

    const now = new Date().toISOString();
    const msg = written > 0
      ? `Synced ${written} files (${fetched} fetched)`
      : `Up to date (${totalConvs || 0} checked)`;

    appendLog(accountId, { level: 'info', message: msg, written, fetched: conversations.length });
    updateAccount(accountId, {
      timestamps,
      lastSyncedAt: now,
      status: 'ok',
      lastError: null,
    });

    onStatus?.('idle', `${provider.displayName}: ${msg}`, accountId);
  } catch (e) {
    let msg;
    if (e.message === 'AUTH_EXPIRED') {
      msg = 'Session expired — re-login needed';
      updateAccount(accountId, { status: 'expired', lastError: msg });
    } else {
      msg = `Sync failed: ${e.message}`;
      updateAccount(accountId, { lastError: msg });
      console.error(`[${account.provider}] Sync error:`, e);
    }
    appendLog(accountId, { level: 'error', message: msg, detail: e.stack || e.message });
    onStatus?.('error', `${provider.displayName}: ${msg}`, accountId);
  } finally {
    syncingAccounts.delete(accountId);
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

module.exports = { syncAccount, syncAll, startScheduler, stopScheduler, setMenuRefreshCallback, isSyncing };
