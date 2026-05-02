const { store, getAccounts, getAccount, updateAccount, getVaultPath } = require('./store');
const { ensureAuthenticated, getSession } = require('./auth');
const { getProvider } = require('./providers');
const { writeConversation } = require('./writer');
const { writeRawCache } = require('./cache');
const { reparseOutdated } = require('./reparse');
const { appendLog } = require('./synclog');

let timeoutId = null;
let schedulerRunning = false;
let onMenuRefresh = null;
const syncingAccounts = new Set();
const accountProgress = new Map(); // id -> short progress string

function setMenuRefreshCallback(cb) {
  onMenuRefresh = cb;
}

function isSyncing(accountId) {
  return syncingAccounts.has(accountId);
}

function getAccountProgress(accountId) {
  return accountProgress.get(accountId) || '';
}

function getSyncingCount() {
  return syncingAccounts.size;
}

function setProgress(accountId, text) {
  if (text) accountProgress.set(accountId, text);
  else accountProgress.delete(accountId);
}

function getConversationId(conv, provider) {
  if (provider?.getId) {
    const id = provider.getId(conv);
    if (id) return id;
  }
  return conv?.uuid || conv?.conversation_id || conv?.id || 'unknown';
}

async function syncAccount(accountId, onStatus, options = {}) {
  if (syncingAccounts.has(accountId)) {
    console.log(`[sync] ${accountId} already syncing, skipping`);
    return;
  }

  const account = getAccount(accountId);
  if (!account) return;

  const provider = getProvider(account.provider);
  if (!provider) return;

  syncingAccounts.add(accountId);

  try {
    const vaultPath = getVaultPath(accountId);
    if (!vaultPath) {
      const msg = 'No vault path configured';
      appendLog(accountId, { level: 'error', message: msg });
      updateAccount(accountId, { lastError: msg });
      onStatus?.('error', `${provider.displayName}: ${msg}`, accountId);
      onMenuRefresh?.();
      return;
    }

    const startLabel = options.mode?.startsWith('fix-order:')
      ? `Fix-order sync started (${options.mode.slice('fix-order:'.length)})`
      : 'Sync started';
    appendLog(accountId, { level: 'info', message: startLabel });
    updateAccount(accountId, { lastError: null });
    setProgress(accountId, 'Authenticating…');
    onMenuRefresh?.();
    onStatus?.('syncing', `${provider.displayName}: Authenticating...`, accountId);

    try {
      await ensureAuthenticated(account.provider, accountId);
    } catch (_e) {
      const msg = 'Login required — session missing or expired';
      appendLog(accountId, { level: 'error', message: msg });
      updateAccount(accountId, { status: 'expired', lastError: msg });
      onStatus?.('error', `${provider.displayName}: ${msg}`, accountId);
      onMenuRefresh?.();
      return;
    }

    try {
      const reparsed = reparseOutdated(vaultPath, provider, account.email || account.id);
      if (reparsed > 0) {
        appendLog(accountId, {
          level: 'info',
          message: `Reparsed ${reparsed} file(s) to parser_version ${provider.parserVersion}`,
        });
      }
    } catch (e) {
      console.error(`[${account.provider}] Reparse failed: ${e.message}`);
      appendLog(accountId, {
        level: 'error',
        message: `Reparse failed: ${e.message}`,
        detail: e.stack || e.message,
      });
    }

    setProgress(accountId, 'Fetching…');
    onStatus?.('syncing', `${provider.displayName}: Fetching...`, accountId);

    const ses = getSession(accountId);
    const timestamps = account.timestamps || {};

    try {
      let totalConvs = 0;

      let written = 0;
      let fetched = 0;
      let failedWrites = 0;
      let saveCounter = 0;

      const accountKey = account.email || account.id;

      // onConversation callback: write each conversation immediately as it's fetched
      const onConversation = (conv) => {
        fetched++;
        try {
          const id = getConversationId(conv, provider);
          if (id && id !== 'unknown') {
            const rawPayload = provider.getRawCache ? provider.getRawCache(conv) : conv;
            try {
              writeRawCache(vaultPath, provider.subdir, accountKey, id, rawPayload);
            } catch (e) {
              console.error(`[${account.provider}] Cache write failed for ${id}: ${e.message}`);
            }
          }
          const md = provider.convertToMarkdown(conv);
          const filename = provider.makeFilename(conv);
          const changed = writeConversation(vaultPath, provider.subdir, accountKey, filename, md);
          if (changed) written++;
        } catch (e) {
          failedWrites++;
          const convId = getConversationId(conv, provider);
          const msg = `Write failed for ${convId}: ${e.message}`;
          appendLog(accountId, { level: 'error', message: msg, detail: e.stack || e.message });
          console.error(`[${account.provider}] ${msg}`);
          throw e;
        }
      };

      await provider.fetchConversations(
        ses,
        timestamps,
        (current, total, customMsg) => {
          totalConvs = total;
          const shortMsg = customMsg
            ? customMsg
            : total != null
              ? `${current}/${total} (${written} updated)`
              : `${current} processed`;
          setProgress(accountId, shortMsg);
          onStatus?.('syncing', `${provider.displayName}: ${shortMsg}`, accountId);
          saveCounter++;
          if (saveCounter % 25 === 0) {
            updateAccount(accountId, { timestamps });
            appendLog(accountId, {
              level: 'info',
              message: `In progress: ${written} written, ${shortMsg}`,
              written,
              fetched,
            });
            onMenuRefresh?.();
          }
        },
        onConversation,
        options,
      );

      const now = new Date().toISOString();
      const msg = failedWrites
        ? `Partial sync: ${written} files (${failedWrites} failed, ${fetched} fetched)`
        : written > 0
          ? `Synced ${written} files (${fetched} fetched)`
          : `Up to date (${totalConvs || 0} checked)`;

      appendLog(accountId, {
        level: failedWrites ? 'error' : 'info',
        message: msg,
        written,
        fetched,
        failedWrites,
      });
      updateAccount(accountId, {
        timestamps,
        lastSyncedAt: now,
        status: 'ok',
        lastError: failedWrites ? `${failedWrites} conversation(s) failed to save` : null,
      });

      onStatus?.(failedWrites ? 'error' : 'idle', `${provider.displayName}: ${msg}`, accountId);
    } catch (e) {
      let msg;
      if (e.message === 'AUTH_EXPIRED') {
        msg = 'Session expired — re-login needed';
        updateAccount(accountId, { timestamps, status: 'expired', lastError: msg });
      } else {
        msg = `Sync failed: ${e.message}`;
        updateAccount(accountId, { timestamps, lastError: msg });
        console.error(`[${account.provider}] Sync error:`, e);
      }
      appendLog(accountId, { level: 'error', message: msg, detail: e.stack || e.message });
      onStatus?.('error', `${provider.displayName}: ${msg}`, accountId);
    }
  } finally {
    syncingAccounts.delete(accountId);
    setProgress(accountId, '');
  }

  onMenuRefresh?.();
}

async function syncAll(onStatus, options = {}) {
  const accounts = options.includeDisabled
    ? getAccounts()
    : getAccounts().filter((a) => a.autoSync);
  for (const account of accounts) {
    await syncAccount(account.id, onStatus);
  }
}

function startScheduler(onStatus) {
  const minutes = store.get('syncIntervalMinutes') || 30;
  const delayMs = minutes * 60 * 1000;
  stopScheduler();
  schedulerRunning = true;

  async function runAndScheduleNext() {
    try {
      await syncAll(onStatus);
    } finally {
      if (schedulerRunning) {
        timeoutId = setTimeout(runAndScheduleNext, delayMs);
      }
    }
  }

  runAndScheduleNext();
}

function stopScheduler() {
  schedulerRunning = false;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

module.exports = {
  syncAccount,
  syncAll,
  startScheduler,
  stopScheduler,
  setMenuRefreshCallback,
  isSyncing,
  getAccountProgress,
  getSyncingCount,
};
