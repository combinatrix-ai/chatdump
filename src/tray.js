const { app, shell, Tray, Menu, nativeImage, dialog, BrowserWindow } = require('electron');
const path = require('node:path');
const {
  store,
  getAccounts,
  upsertAccount,
  removeAccount,
  updateAccount,
  getVaultPath,
  getVaultBookmark,
} = require('./store');
const {
  syncAccount,
  syncAll,
  stopSync,
  waitForSyncStop,
  isSyncing,
  getAccountProgress,
  getSyncingCount,
} = require('./scheduler');
const { openLoginWindow, getSession } = require('./auth');
const { allProviders, getProvider } = require('./providers');
const { getRecentLogs, openLogFile } = require('./synclog');
const { isCliInstallAvailable, installCliTool, getCliInstallStatus } = require('./cli-install');
const { showCliInstallResult } = require('./cli-install-ui');
const { getUpdateState, checkForUpdates, quitAndInstall } = require('./updater');
const { countSavedChats } = require('./archive-stats');
const { getTrayIconState } = require('./tray-state');
const { readStartAtLogin, toggleStartAtLogin } = require('./login-item');
const { removeAccountSafely } = require('./account-removal');
const { addAccount } = require('./account-add');
const { shortenError, truncateMenuText } = require('./menu-text');

let tray = null;
const providerIconCache = new Map();
function providerIcon(provider) {
  if (!provider?.iconAsset) return undefined;
  if (providerIconCache.has(provider.name)) return providerIconCache.get(provider.name);
  const img = nativeImage
    .createFromPath(path.join(__dirname, '..', provider.iconAsset))
    .resize({ width: 16, height: 16 });
  img.setTemplateImage(true);
  providerIconCache.set(provider.name, img);
  return img;
}

function buildAccountStatus(account) {
  const syncing = isSyncing(account.id);
  if (syncing) {
    const progress = getAccountProgress(account.id);
    return { icon: '🔄', suffix: progress || 'Syncing…' };
  }
  if (account.status === 'expired') {
    return { icon: '🔒', suffix: 'Re-login needed' };
  }
  if (account.lastError) {
    return { icon: '⚠️', suffix: shortenError(account.lastError) };
  }
  return { icon: '✅', suffix: '' };
}

function buildGlobalHeader(accounts) {
  const syncingCount = getSyncingCount();
  if (syncingCount > 0) {
    return `Syncing ${syncingCount} of ${accounts.length} account${accounts.length === 1 ? '' : 's'}`;
  }
  if (accounts.length === 0) return 'Add an account to start';
  const erroring = accounts.filter((a) => a.lastError || a.status === 'expired').length;
  if (erroring > 0) return `${erroring} account${erroring === 1 ? '' : 's'} need attention`;
  return 'All up to date';
}

function buildMenu() {
  if (!tray) return;

  const accounts = getAccounts();
  const defaultVault = store.get('defaultVaultPath');
  const chatCounts = new Map(accounts.map((account) => [account.id, getSavedChatCount(account)]));
  const totalChatCount = [...chatCounts.values()].reduce((total, count) => total + count, 0);

  // --- Account items with submenu ---
  const accountItems = accounts.map((account) => {
    const provider = getProvider(account.provider);
    const displayName = provider?.displayName || account.provider;
    const label = account.email || account.name || 'Unknown';
    const lastSync = account.lastSyncedAt
      ? new Date(account.lastSyncedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'never';

    const { icon, suffix } = buildAccountStatus(account);
    // While syncing, show progress in place of last-sync time; otherwise show time.
    const trailing = isSyncing(account.id)
      ? `${icon} ${suffix}`
      : suffix
        ? `(${lastSync}) ${icon} ${suffix}`
        : `(${lastSync}) ${icon}`;
    const vaultPath = getVaultPath(account.id);

    // Build submenu items
    const sub = [];

    sub.push({
      label: `${formatChatCount(chatCounts.get(account.id) || 0)} chats saved`,
      enabled: false,
    });
    sub.push({ type: 'separator' });

    // Error banner at top if there's an error
    if (account.lastError) {
      sub.push({ label: `⚠️ ${truncateMenuText(account.lastError)}`, enabled: false });
      sub.push({ type: 'separator' });
    }

    if (account.provider === 'openai') {
      sub.push({
        label: "ⓘ Reading a chat moves it to the top of chatgpt.com's sidebar.",
        enabled: false,
      });
      sub.push({
        label: '  Sync Now reads only the chosen recent window. Full sync',
        enabled: false,
      });
      sub.push({
        label: '  goes through every chat — slow but refreshes everything',
        enabled: false,
      });
      sub.push({ label: '  and reorders the whole sidebar.', enabled: false });
      sub.push({ type: 'separator' });
    }

    const syncing = isSyncing(account.id);
    if (account.provider === 'openai') {
      const windowDays = account.syncWindowDays ?? 30;
      if (syncing) {
        sub.push({
          label: 'Stop Syncing',
          click: () => stopSync(account.id),
        });
      } else {
        sub.push({
          label: `Sync Now (${windowDays} days)`,
          click: () => syncAccount(account.id, onStatus, { interactive: true }),
        });
      }

      const SYNC_WINDOWS = [1, 7, 30, 90];
      sub.push({
        label: 'Sync window',
        submenu: SYNC_WINDOWS.map((d) => ({
          label: d === 30 ? `Last ${d} days  (Default)` : `Last ${d} day${d === 1 ? '' : 's'}`,
          type: 'radio',
          checked: windowDays === d,
          click: () => {
            updateAccount(account.id, { syncWindowDays: d });
            buildMenu();
          },
        })),
      });

      sub.push({
        label: 'Full sync',
        submenu: [
          {
            label: 'ⓘ Reads every chat in your chosen order. Your chatgpt.com sidebar',
            enabled: false,
          },
          { label: '  ends up sorted that way too. Slow — hours to days.', enabled: false },
          { type: 'separator' },
          {
            label: 'by Creation date',
            enabled: !syncing,
            click: () =>
              syncAccount(account.id, onStatus, {
                interactive: true,
                mode: 'full-sync:created_at',
              }),
          },
          {
            label: 'by Last message time',
            enabled: !syncing,
            click: () =>
              syncAccount(account.id, onStatus, {
                interactive: true,
                mode: 'full-sync:last_message_at',
              }),
          },
        ],
      });
    } else if (syncing) {
      sub.push({
        label: 'Stop Syncing',
        click: () => stopSync(account.id),
      });
    } else {
      sub.push({
        label: 'Sync Now',
        click: () => syncAccount(account.id, onStatus, { interactive: true }),
      });
    }

    sub.push({ type: 'separator' });

    // Vault section
    sub.push({
      label: vaultPath ? `Vault: ${shortenPath(vaultPath)}` : 'Vault: (default)',
      enabled: false,
    });
    sub.push({
      label: 'Set Vault Path...',
      click: async () => {
        const result = await pickDirectory(`Select vault for ${displayName}: ${label}`);
        if (!result.canceled && result.filePaths.length > 0) {
          updateAccount(account.id, buildVaultSelection(result));
          buildMenu();
        }
      },
    });
    sub.push({
      label: 'Use Default Vault',
      enabled: !!account.vaultPath,
      click: () => {
        updateAccount(account.id, { vaultPath: '', vaultBookmark: '' });
        buildMenu();
      },
    });
    sub.push({
      label: vaultPath ? 'Open Vault' : 'Open Vault (not set)',
      enabled: !!vaultPath,
      click: () => shell.openPath(vaultPath),
    });

    sub.push({ type: 'separator' });

    // Auto-sync toggle
    sub.push({
      label: `Auto-sync: ${account.autoSync ? '☑ ON' : '☐ OFF'}`,
      click: () => {
        updateAccount(account.id, { autoSync: !account.autoSync });
        buildMenu();
      },
    });

    sub.push({ type: 'separator' });

    // Recent sync log (last 5 entries)
    const recentLogs = getRecentLogs(account.id, 5);
    if (recentLogs.length > 0) {
      sub.push({ label: 'Recent Activity', enabled: false });
      for (const log of recentLogs.reverse()) {
        const time = new Date(log.time).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        const icon = log.level === 'error' ? '❌' : '✅';
        // Truncate long messages for menu display
        const msg = truncateMenuText(log.message, 50, { suffix: '...' });
        sub.push({ label: `  ${icon} ${time}: ${msg}`, enabled: false });
      }
      sub.push({
        label: 'Open Full Log...',
        click: () => openLogFile(account.id),
      });
      sub.push({ type: 'separator' });
    }

    // Account actions
    sub.push({
      label: 'Re-login',
      click: async () => {
        await openLoginWindow(account.provider, account.id).catch(() => {});
        const prov = getProvider(account.provider);
        if (prov) {
          try {
            const ses = getSession(account.id);
            const info = await prov.getAccountInfo(ses);
            if (info) {
              if (account.email && info.email && info.email !== account.email) {
                try {
                  await ses.clearStorageData();
                } catch (e) {
                  console.log(
                    `[tray] Could not clear mismatched session storage for ${account.id}: ${e.message}`,
                  );
                }
                updateAccount(account.id, {
                  status: 'expired',
                  lastError: `Logged in as ${info.email}; expected ${account.email} — logged out, please re-login`,
                });
                buildMenu();
                return;
              }
              upsertAccount({ ...account, ...info, status: 'ok', lastError: null });
              buildMenu();
            }
          } catch {
            /* ignore */
          }
        }
      },
    });
    sub.push({
      label: 'Remove Account',
      click: async () => {
        const result = await removeAccountSafely(account, {
          stopSync,
          waitForSyncStop,
          getSession,
          removeAccount,
          updateAccount,
          logger: (message) => console.log(message),
        });
        if (result.ok) {
          buildMenu();
          return;
        }
        await dialog.showMessageBox({
          type: 'error',
          title: 'Could not remove account',
          message: `Could not remove ${label}`,
          detail: result.error,
        });
      },
    });

    return {
      label: `${label} ${trailing}`,
      icon: providerIcon(provider),
      submenu: sub,
    };
  });

  // --- Add Account submenu ---
  const addAccountSubmenu = allProviders().map((prov) => ({
    label: prov.displayName,
    click: async () => {
      if (!(await confirmChatGptSideEffect(prov))) return;
      await addAccount(prov, {
        openLoginWindow,
        getSession,
        upsertAccount,
        updateAccount,
        removeAccount,
        getAccounts,
        onAccountsChanged: buildMenu,
        startInitialSync: (id) =>
          syncAccount(id, onStatus).catch((e) => {
            console.error(`Initial sync failed for ${id}: ${e.message}`);
          }),
        logger: (message) => console.log(message),
      });
    },
  }));

  // --- Build full menu ---
  const header = buildGlobalHeader(accounts);
  const template = [
    { label: header, enabled: false },
    { label: `${formatChatCount(totalChatCount)} chats saved`, enabled: false },
    { type: 'separator' },
  ];

  if (accountItems.length > 0) {
    template.push(...accountItems);
    template.push({ type: 'separator' });
  } else {
    template.push({ label: 'No accounts configured', enabled: false });
    template.push({ type: 'separator' });
  }

  template.push({
    label: 'Sync All Now',
    enabled: accountItems.length > 0,
    click: () => syncAll(onStatus),
  });

  const intervalMinutes = store.get('syncIntervalMinutes') || 180;
  const INTERVAL_OPTIONS = [
    { label: 'Every 30 minutes', minutes: 30 },
    { label: 'Every 1 hour', minutes: 60 },
    { label: 'Every 3 hours  (Default)', minutes: 180 },
    { label: 'Every 6 hours', minutes: 360 },
    { label: 'Every 12 hours', minutes: 720 },
    { label: 'Every 24 hours', minutes: 1440 },
  ];
  template.push({
    label: 'Auto-sync interval',
    submenu: INTERVAL_OPTIONS.map((opt) => ({
      label: opt.label,
      type: 'radio',
      checked: intervalMinutes === opt.minutes,
      click: () => {
        store.set('syncIntervalMinutes', opt.minutes);
        buildMenu();
      },
    })),
  });

  const startAtLogin = readStartAtLogin(app);
  template.push({
    label: startAtLogin.ok ? 'Start at Login' : 'Start at Login (Unavailable)',
    type: 'checkbox',
    checked: startAtLogin.enabled,
    enabled: startAtLogin.ok,
    click: async () => {
      const result = toggleStartAtLogin(app, store);
      // Rebuild before showing an error so a successful change is visible
      // immediately and a failed change falls back to the OS readback.
      buildMenu();
      if (!result.ok) await showStartAtLoginError(result.error);
    },
  });

  template.push({ type: 'separator' });

  // Default vault
  template.push({
    label: defaultVault ? `Default Vault: ${shortenPath(defaultVault)}` : 'Default Vault: Not set',
    enabled: false,
  });
  template.push({
    label: 'Set Default Vault...',
    click: async () => {
      const result = await pickDirectory('Select Default Vault');
      if (!result.canceled && result.filePaths.length > 0) {
        store.set('defaultVaultPath', result.filePaths[0]);
        const bookmark = getVaultBookmarkFromSelection(result);
        if (bookmark) store.set('defaultVaultBookmark', bookmark);
        buildMenu();
      }
    },
  });
  if (defaultVault) {
    template.push({
      label: 'Open Default Vault',
      click: () => shell.openPath(defaultVault),
    });
  }

  template.push({ type: 'separator' });
  template.push({
    label: 'Add Account...',
    submenu: addAccountSubmenu,
  });

  if (isCliInstallAvailable()) {
    template.push({ type: 'separator' });
    const cliStatus = getCliInstallStatus();
    if (cliStatus.installed) {
      template.push({ label: `CLI: ${shortenPath(cliStatus.path)}`, enabled: false });
    } else {
      template.push({
        label: 'Install Command Line Tool…',
        click: async () => {
          const result = await installCliTool();
          await showCliInstallResult(dialog, result);
          buildMenu();
        },
      });
    }
  }

  template.push({ type: 'separator' });
  template.push(buildUpdateItem());

  template.push({ type: 'separator' });
  template.push({
    label: 'Quit',
    click: () => {
      tray = null;
      app.quit();
    },
  });

  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
  tray.setToolTip(`chatdump — ${header}`);
  applyTrayIcon();
}

function onStatus(_state, _message, _accountId) {
  // Status now derived from scheduler state + per-account fields; just trigger a refresh.
  buildMenu();
}

function buildUpdateItem() {
  const update = getUpdateState();

  if (update.status === 'downloaded') {
    const v = update.version ? ` (v${update.version})` : '';
    return { label: `🔄 Restart to Update${v}`, click: () => quitAndInstall() };
  }
  if (update.status === 'downloading') {
    const pct = update.percent ? ` ${update.percent}%` : '';
    return { label: `Downloading update…${pct}`, enabled: false };
  }
  if (update.status === 'checking') {
    return { label: 'Checking for Updates…', enabled: false };
  }
  if (update.status === 'error') {
    return {
      label: `⚠️ Update check failed: ${truncateMenuText(update.error, 70)}`,
      enabled: update.supported,
      click: () => checkForUpdates(),
    };
  }
  return {
    label: 'Check for Updates…',
    enabled: update.supported,
    click: () => checkForUpdates(),
  };
}

async function showStartAtLoginError(error) {
  try {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Could not update Start at Login',
      message: 'Could not update Start at Login',
      detail: error || 'Unknown error',
    });
  } catch (dialogError) {
    // Showing an error should never turn a recoverable OS setting failure into
    // an uncaught rejection in the tray click handler.
    console.error(`[tray] Could not show Start at Login error: ${dialogError.message}`);
  }
}

function shortenPath(p) {
  const home = require('node:os').homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatChatCount(count) {
  return new Intl.NumberFormat().format(count);
}

function getSavedChatCount(account) {
  const vaultPath = getVaultPath(account.id);
  const provider = getProvider(account.provider);
  if (!vaultPath || !provider) return 0;

  let stopAccessing = null;
  const bookmark = getVaultBookmark(account.id);
  if (bookmark && typeof app.startAccessingSecurityScopedResource === 'function') {
    try {
      stopAccessing = app.startAccessingSecurityScopedResource(bookmark);
    } catch {
      return 0;
    }
  }

  try {
    return countSavedChats(vaultPath, provider.subdir, account.email || account.id);
  } finally {
    if (typeof stopAccessing === 'function') stopAccessing();
  }
}

function getVaultBookmarkFromSelection(result) {
  return result.bookmarks?.[0] || '';
}

async function pickDirectory(title) {
  if (process.platform === 'darwin') app.dock?.show();
  let focusWin = null;
  try {
    focusWin = new BrowserWindow({ show: false });
    return await dialog.showOpenDialog(focusWin, {
      properties: ['openDirectory'],
      title,
      securityScopedBookmarks: true,
    });
  } finally {
    if (focusWin && !focusWin.isDestroyed()) focusWin.destroy();
    if (process.platform === 'darwin') app.dock?.hide();
  }
}

function buildVaultSelection(result) {
  const update = { vaultPath: result.filePaths[0] };
  const bookmark = getVaultBookmarkFromSelection(result);
  if (bookmark) update.vaultBookmark = bookmark;
  return update;
}

// ChatGPT is the only provider where syncing has a visible side effect on the
// provider's own UI, so warn once before the user commits to adding one.
// Returns false when the user backs out.
async function confirmChatGptSideEffect(prov) {
  if (prov.name !== 'openai') return true;
  if (store.get('chatgpt.skipAddAccountWarning', false)) return true;

  if (process.platform === 'darwin') app.dock?.show();
  try {
    const focusWin = new BrowserWindow({ show: false });
    const res = await dialog.showMessageBox(focusWin, {
      type: 'info',
      buttons: ['Sign in to ChatGPT', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Heads up — ChatGPT-only side effect',
      message: "Reading a chat inevitably bumps it to the top of ChatGPT's sidebar.",
      detail:
        "ChatGPT's API has no read-only fetch — every conversation chatdump " +
        'reads bumps its server-side update_time, so threads jump to the top ' +
        'of your ChatGPT sidebar one by one as sync runs.\n\n' +
        'chatdump reads them oldest-touched first, so once sync finishes the ' +
        'sidebar settles back to its natural order (most-recently-used at top). ' +
        'The disturbance is temporary.\n\n' +
        'Claude and Gemini are not affected.',
      checkboxLabel: "Don't show this again",
      checkboxChecked: false,
      noLink: true,
    });
    focusWin.destroy();
    const proceed = res.response === 0;
    // Only remember the opt-out when the user actually goes ahead; backing
    // out should not silently suppress the warning next time.
    if (proceed && res.checkboxChecked) store.set('chatgpt.skipAddAccountWarning', true);
    return proceed;
  } finally {
    if (process.platform === 'darwin') app.dock?.hide();
  }
}

let idleIcon = null;
let syncingIcon = null;
let attentionIcon = null;

function loadIcon(name) {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', name));
  img.setTemplateImage(true);
  return img;
}

function applyTrayIcon() {
  if (!tray) return;
  const icons = { idle: idleIcon, syncing: syncingIcon, attention: attentionIcon };
  tray.setImage(icons[getTrayIconState(getAccounts(), getSyncingCount())]);
}

function createTray() {
  idleIcon = loadIcon('iconTemplate.png');
  syncingIcon = loadIcon('iconTemplate-syncing.png');
  attentionIcon = loadIcon('iconTemplate-attention.png');

  tray = new Tray(idleIcon);
  buildMenu();

  return { tray, onStatus, buildMenu };
}

module.exports = { createTray };
