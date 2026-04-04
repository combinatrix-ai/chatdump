const { app, shell, Tray, Menu, nativeImage, dialog, BrowserWindow } = require('electron');
const path = require('path');
const { store, getAccounts, upsertAccount, removeAccount, updateAccount, getVaultPath } = require('./store');
const { syncAccount, syncAll } = require('./scheduler');
const { openLoginWindow, getSession } = require('./auth');
const { allProviders, getProvider } = require('./providers');
const { getRecentLogs, openLogFile } = require('./synclog');

let tray = null;
let globalStatus = 'Ready';

function buildMenu() {
  if (!tray) return;

  const accounts = getAccounts();
  const defaultVault = store.get('defaultVaultPath');

  // --- Account items with submenu ---
  const accountItems = accounts.map((account) => {
    const provider = getProvider(account.provider);
    const displayName = provider?.displayName || account.provider;
    const label = account.email || account.name || 'Unknown';
    const plan = account.plan ? ` (${account.plan})` : '';
    const lastSync = account.lastSyncedAt
      ? new Date(account.lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'never';

    const statusIcon = account.status === 'expired' ? ' ⚠' : ' ✓';
    const vaultPath = getVaultPath(account.id);

    // Build submenu items
    const sub = [];

    // Error banner at top if there's an error
    if (account.lastError) {
      sub.push({ label: `⚠ ${account.lastError}`, enabled: false });
      sub.push({ type: 'separator' });
    }

    sub.push({
      label: 'Sync Now',
      click: () => syncAccount(account.id, onStatus),
    });

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
          });
          focusWin.destroy();
          if (!result.canceled && result.filePaths.length > 0) {
            updateAccount(account.id, { vaultPath: result.filePaths[0] });
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
        updateAccount(account.id, { vaultPath: '' });
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
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const icon = log.level === 'error' ? '✗' : '✓';
        // Truncate long messages for menu display
        const msg = log.message.length > 50 ? log.message.slice(0, 47) + '...' : log.message;
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
              upsertAccount({ ...account, ...info, status: 'ok', lastError: null });
              buildMenu();
            }
          } catch { /* ignore */ }
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
      label: `${displayName}: ${label}${plan} (${lastSync})${statusIcon}`,
      submenu: sub,
    };
  });

  // --- Add Account submenu ---
  const addAccountSubmenu = allProviders().map((prov) => ({
    label: prov.displayName,
    click: async () => {
      try {
        // Login with a temp session first
        const result = await openLoginWindow(prov.name);
        const tempSes = result.session;

        // Get account info using the temp session
        const info = await prov.getAccountInfo(tempSes);
        if (info && info.email) {
          const accountId = `${prov.name}:${info.email}`;

          // Copy cookies from temp session to the account's persistent session
          const persistSes = getSession(accountId);
          const cookies = await tempSes.cookies.get({ url: prov.baseUrl });
          for (const cookie of cookies) {
            const cookieDetails = {
              url: prov.baseUrl,
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              expirationDate: cookie.expirationDate,
            };
            await persistSes.cookies.set(cookieDetails).catch(() => {});
          }

          upsertAccount({
            id: accountId,
            provider: prov.name,
            email: info.email,
            name: info.name,
            plan: info.plan,
            status: 'ok',
          });
          buildMenu();
        }
      } catch (e) {
        console.error(`Add account failed: ${e.message}`);
      }
    },
  }));

  // --- Build full menu ---
  const template = [
    { label: globalStatus, enabled: false },
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
        });
        focusWin.destroy();
        if (!result.canceled && result.filePaths.length > 0) {
          store.set('defaultVaultPath', result.filePaths[0]);
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
  tray.setToolTip(`webui-sync — ${globalStatus}`);
}

function onStatus(state, message, _accountId) {
  globalStatus = message;
  buildMenu();
}

function shortenPath(p) {
  const home = require('os').homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'iconTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  buildMenu();

  return { tray, onStatus, buildMenu };
}

module.exports = { createTray };
