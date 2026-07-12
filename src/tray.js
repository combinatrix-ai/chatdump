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
  isSyncing,
  getAccountProgress,
  getSyncingCount,
} = require('./scheduler');
const { openLoginWindow, getSession } = require('./auth');
const { allProviders, getProvider } = require('./providers');
const { getRecentLogs, openLogFile } = require('./synclog');
const { isCliInstallAvailable, installCliTool, getCliInstallStatus } = require('./cli-install');
const { getUpdateState, checkForUpdates, quitAndInstall } = require('./updater');
const { countSavedChats } = require('./archive-stats');

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

function shortenError(msg) {
  if (!msg) return '';
  // Strip common prefix and trim down for the menu
  let s = String(msg).replace(/^Sync failed:\s*/i, '');
  // For "API error: 500 https://… body=…" keep just status
  const apiMatch = s.match(/^API error:\s*(\d+)/i);
  if (apiMatch) return `API ${apiMatch[1]}`;
  if (s.length > 40) s = `${s.slice(0, 37)}…`;
  return s;
}

function truncateMenuText(value, maxLength = 120) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
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
        if (process.platform === 'darwin') app.dock?.show();
        try {
          const focusWin = new BrowserWindow({ show: false });
          const result = await dialog.showOpenDialog(focusWin, {
            properties: ['openDirectory'],
            title: `Select vault for ${displayName}: ${label}`,
            securityScopedBookmarks: true,
          });
          focusWin.destroy();
          if (!result.canceled && result.filePaths.length > 0) {
            updateAccount(account.id, buildVaultSelection(result));
            buildMenu();
          }
        } finally {
          if (process.platform === 'darwin') app.dock?.hide();
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
        const msg = log.message.length > 50 ? `${log.message.slice(0, 47)}...` : log.message;
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
      click: () => {
        removeAccount(account.id);
        buildMenu();
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
      try {
        if (prov.name === 'openai' && !store.get('chatgpt.skipAddAccountWarning', false)) {
          if (process.platform === 'darwin') app.dock?.show();
          let proceed = false;
          let dontShowAgain = false;
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
            proceed = res.response === 0;
            dontShowAgain = res.checkboxChecked;
          } finally {
            if (process.platform === 'darwin') app.dock?.hide();
          }
          if (!proceed) return;
          if (dontShowAgain) store.set('chatgpt.skipAddAccountWarning', true);
        }
        const result = await openLoginWindow(prov.name);
        const tempSes = result.session;
        let accountId = null;
        let persistSes = null;

        try {
          // Step 1: Create account entry immediately with a temp ID
          // Use timestamp to ensure uniqueness, will be updated with email later
          const tempId = `${prov.name}:account-${Date.now()}`;
          accountId = tempId;

          // Step 2: Copy cookies from temp session to persistent session
          persistSes = getSession(accountId);
          const cookies = await tempSes.cookies.get({ url: prov.baseUrl });
          await copyProviderCookies(cookies, persistSes, accountId);

          // Step 3: Save account entry right away so it appears in the menu
          upsertAccount({
            id: accountId,
            provider: prov.name,
            email: '',
            name: `${prov.displayName} account`,
            status: 'ok',
          });
          buildMenu();

          // Step 4: Try to get account info — multiple strategies
          let info = null;
          try {
            // Strategy 1: Parse from API response fetched via browser
            if (result.accountInfo && prov.parseAccountInfo) {
              info = prov.parseAccountInfo(result.accountInfo);
            }
            // Strategy 2: Parse from cookies directly
            console.log(
              `[tray] result.cookies keys: ${Object.keys(result.cookies || {}).join(', ')}`,
            );
            if (!info?.email && result.cookies && prov.parseAccountFromCookies) {
              const cookieInfo = prov.parseAccountFromCookies(result.cookies);
              if (cookieInfo.email || cookieInfo.name) {
                info = { ...info, ...cookieInfo };
              }
            }
            // Strategy 3: API call with session
            if (!info?.email) {
              const apiInfo = await prov.getAccountInfo(persistSes);
              if (apiInfo) info = { ...info, ...apiInfo };
            }
          } catch {
            /* ignore */
          }

          let syncId = accountId;
          if (info?.email) {
            const realId = `${prov.name}:${info.email}`;
            // Remove temp entry, create proper one
            removeAccount(accountId);

            // Re-copy cookies to the real account partition
            const realSes = getSession(realId);
            await copyProviderCookies(cookies, realSes, realId);

            upsertAccount({
              id: realId,
              provider: prov.name,
              email: info.email,
              name: info.name,
              status: 'ok',
            });
            syncId = realId;
          } else if (info?.name) {
            // Got name but no email — update the temp entry
            updateAccount(accountId, { name: info.name });
          }

          buildMenu();

          // Kick off the first sync immediately after a successful add.
          syncAccount(syncId, onStatus).catch((e) => {
            console.error(`Initial sync failed for ${syncId}: ${e.message}`);
          });
        } finally {
          if (
            accountId &&
            persistSes &&
            !getAccounts().some((account) => account.id === accountId)
          ) {
            await clearSessionStorage(persistSes, accountId);
          }
        }
      } catch (e) {
        console.error(`Add account failed: ${e.message}`);
      }
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
    click: () => syncAll(onStatus, { includeDisabled: true }),
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

  template.push({ type: 'separator' });

  // Default vault
  template.push({
    label: defaultVault ? `Default Vault: ${shortenPath(defaultVault)}` : 'Default Vault: Not set',
    enabled: false,
  });
  template.push({
    label: 'Set Default Vault...',
    click: async () => {
      if (process.platform === 'darwin') app.dock?.show();
      try {
        const focusWin = new BrowserWindow({ show: false });
        const result = await dialog.showOpenDialog(focusWin, {
          properties: ['openDirectory'],
          title: 'Select Default Vault',
          securityScopedBookmarks: true,
        });
        focusWin.destroy();
        if (!result.canceled && result.filePaths.length > 0) {
          store.set('defaultVaultPath', result.filePaths[0]);
          const bookmark = getVaultBookmarkFromSelection(result);
          if (bookmark) store.set('defaultVaultBookmark', bookmark);
          buildMenu();
        }
      } finally {
        if (process.platform === 'darwin') app.dock?.hide();
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
          if (result.ok) {
            await dialog.showMessageBox({
              type: 'info',
              title: 'chatdump command installed',
              message: 'chatdump command installed',
              detail: `chatdump command installed at ${result.path}. Try: chatdump cli list`,
            });
          } else if (result.reason !== 'cancelled') {
            await dialog.showMessageBox({
              type: 'error',
              title: 'Could not install chatdump command',
              message: 'Could not install chatdump command',
              detail: result.message || 'Unknown error',
            });
          }
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
  return {
    label: 'Check for Updates…',
    enabled: update.supported,
    click: () => checkForUpdates({ interactive: true }),
  };
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

function buildVaultSelection(result) {
  const update = { vaultPath: result.filePaths[0] };
  const bookmark = getVaultBookmarkFromSelection(result);
  if (bookmark) update.vaultBookmark = bookmark;
  return update;
}

async function copyProviderCookies(cookies, targetSession, targetLabel) {
  console.log(`[tray] Copying ${cookies.length} cookies to ${targetLabel}`);
  for (const cookie of cookies) {
    const details = {
      url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.expirationDate,
    };

    if (cookie.sameSite) {
      details.sameSite = cookie.sameSite;
    }

    try {
      await targetSession.cookies.set(details);
    } catch (e) {
      console.log(`[tray] Cookie copy failed for ${targetLabel}: ${cookie.name}: ${e.message}`);
    }
  }
}

async function clearSessionStorage(ses, label) {
  try {
    await ses.clearStorageData();
    console.log(`[tray] Cleared temporary session storage for ${label}`);
  } catch (e) {
    console.log(`[tray] Could not clear temporary session storage for ${label}: ${e.message}`);
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
  const needsAttention = getAccounts().some(
    (account) => account.status === 'expired' || account.lastError,
  );
  tray.setImage(needsAttention ? attentionIcon : getSyncingCount() > 0 ? syncingIcon : idleIcon);
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
