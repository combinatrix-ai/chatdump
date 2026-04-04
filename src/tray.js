const { app, shell, Tray, Menu, nativeImage, dialog, BrowserWindow } = require('electron');
const path = require('path');
const { store, getAccounts, upsertAccount, removeAccount, updateAccount, getVaultPath } = require('./store');
const { syncAccount, syncAll } = require('./scheduler');
const { openLoginWindow } = require('./auth');
const { allProviders, getProvider } = require('./providers');

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

    return {
      label: `${displayName}: ${label}${plan} (${lastSync})${statusIcon}`,
      submenu: [
        {
          label: 'Sync Now',
          click: () => syncAccount(account.id, onStatus),
        },
        { type: 'separator' },
        {
          label: vaultPath ? `Vault: ${shortenPath(vaultPath)}` : 'Vault: (default)',
          enabled: false,
        },
        {
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
        },
        {
          label: 'Use Default Vault',
          enabled: !!account.vaultPath,
          click: () => {
            updateAccount(account.id, { vaultPath: '' });
            buildMenu();
          },
        },
        {
          label: vaultPath ? 'Open Vault' : 'Open Vault (not set)',
          enabled: !!vaultPath,
          click: () => shell.openPath(vaultPath),
        },
        { type: 'separator' },
        {
          label: `Auto-sync: ${account.autoSync ? '☑ ON' : '☐ OFF'}`,
          click: () => {
            updateAccount(account.id, { autoSync: !account.autoSync });
            buildMenu();
          },
        },
        { type: 'separator' },
        {
          label: 'Re-login',
          click: async () => {
            await openLoginWindow(account.provider).catch(() => {});
            // Refresh account info
            const prov = getProvider(account.provider);
            if (prov) {
              try {
                const info = await prov.getAccountInfo();
                if (info) {
                  upsertAccount({ ...account, ...info, status: 'ok' });
                  buildMenu();
                }
              } catch { /* ignore */ }
            }
          },
        },
        {
          label: 'Remove Account',
          click: () => {
            removeAccount(account.id);
            buildMenu();
          },
        },
      ],
    };
  });

  // --- Add Account submenu ---
  const addAccountSubmenu = allProviders().map((prov) => ({
    label: prov.displayName,
    click: async () => {
      try {
        await openLoginWindow(prov.name);
        const info = await prov.getAccountInfo();
        if (info && info.email) {
          const accountId = `${prov.name}:${info.email}`;
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
