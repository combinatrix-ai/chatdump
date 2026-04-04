const store = require('./store');
const { ensureAuthenticated, openLoginWindow } = require('./auth');
const { fetchUpdatedConversations } = require('./api');
const { conversationToMarkdown, makeFilename } = require('./converter');
const { writeConversation } = require('./writer');
const { gitSync } = require('./sync');

let intervalId = null;

let onAccountRefresh = null;

function setAccountRefreshCallback(cb) {
  onAccountRefresh = cb;
}

async function runSync(onStatus) {
  console.log('[webui-sync] runSync started');
  const vaultPath = store.get('vaultPath');
  if (!vaultPath) {
    console.log('[webui-sync] no vault path');
    onStatus?.('error', 'Vault path not configured');
    return;
  }

  onStatus?.('syncing', 'Authenticating...');

  try {
    await ensureAuthenticated();
    console.log('[webui-sync] authenticated');
  } catch (e) {
    console.log('[webui-sync] auth failed:', e.message);
    onStatus?.('error', 'Authentication required');
    try { await openLoginWindow(); } catch { return; }
  }

  onStatus?.('syncing', 'Fetching conversations...');

  try {
    console.log('[webui-sync] fetching conversations...');
    const conversations = await fetchUpdatedConversations((current, total) => {
      onStatus?.('syncing', `Fetching ${current}/${total} conversations...`);
    });
    console.log(`[webui-sync] fetched ${conversations.length} updated conversations`);

    let written = 0;
    for (const conv of conversations) {
      const md = conversationToMarkdown(conv);
      const filename = makeFilename(conv);
      const changed = writeConversation(vaultPath, filename, md);
      if (changed) written++;
    }

    const now = new Date().toISOString();
    store.set('lastSyncedAt', now);

    const msg = written > 0
      ? `Synced ${written} files`
      : 'All up to date';

    onStatus?.('idle', msg);
    onAccountRefresh?.();
  } catch (e) {
    if (e.message === 'AUTH_EXPIRED') {
      onStatus?.('error', 'Session expired, re-login needed');
      try { await openLoginWindow(); } catch { /* user closed */ }
    } else {
      onStatus?.('error', `Sync failed: ${e.message}`);
      console.error('Sync error:', e);
    }
  }
}

function startScheduler(onStatus) {
  const minutes = store.get('syncIntervalMinutes') || 30;
  stopScheduler();
  intervalId = setInterval(() => runSync(onStatus), minutes * 60 * 1000);
  // Run immediately on start
  runSync(onStatus);
}

function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { runSync, startScheduler, stopScheduler, setAccountRefreshCallback };
