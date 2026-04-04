const { store, getAccounts, getAccount, updateAccount, getVaultPath } = require('./store');
const { ensureAuthenticated, openLoginWindow, getSession } = require('./auth');
const { getProvider } = require('./providers');
const { writeConversation } = require('./writer');
const { appendLog } = require('./synclog');

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

    const conversations = await provider.fetchConversations(ses, timestamps, (current, total) => {
      totalConvs = total;
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
    const msg = written > 0
      ? `Synced ${written} new/updated files (${conversations.length} fetched)`
      : `Up to date (${totalConvs || 0} conversations checked)`;

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
