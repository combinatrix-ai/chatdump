const { app, shell, Tray, Menu, nativeImage, dialog, BrowserWindow } = require('electron');
const path = require('path');
const store = require('./store');
const { runSync } = require('./scheduler');
const { openLoginWindow } = require('./auth');
const { getAccountInfo } = require('./api');

let tray = null;
let statusMessage = 'Ready';
let accountInfo = null;

async function refreshAccountInfo() {
  try {
    accountInfo = await getAccountInfo();
    store.set('cachedAccountInfo', accountInfo);
  } catch {
    // Use cached info if API fails
    accountInfo = store.get('cachedAccountInfo') || null;
  }
  updateMenu();
}

function updateMenu() {
  if (!tray) return;

  const lastSynced = store.get('lastSyncedAt');
  const lastSyncLabel = lastSynced
    ? `Last synced: ${new Date(lastSynced).toLocaleString()}`
    : 'Never synced';

  const vaultPath = store.get('vaultPath');
  const vaultLabel = vaultPath
    ? `Vault: ${vaultPath}`
    : 'Vault: Not configured';

  // Account section
  const accountItems = [];
  if (accountInfo && (accountInfo.email || accountInfo.name)) {
    const displayName = accountInfo.name || accountInfo.email;
    accountItems.push({ label: `Account: ${displayName}`, enabled: false });
    if (accountInfo.name && accountInfo.email) {
      accountItems.push({ label: `  ${accountInfo.email}`, enabled: false });
    }
    if (accountInfo.plan) {
      accountItems.push({ label: `  Plan: ${accountInfo.plan}`, enabled: false });
    }
  } else {
    accountItems.push({ label: 'Account: Not logged in', enabled: false });
  }

  const menu = Menu.buildFromTemplate([
    { label: statusMessage, enabled: false },
    { type: 'separator' },
    ...accountItems,
    { type: 'separator' },
    {
      label: 'Sync Now',
      click: () => runSync(onStatus),
    },
    { type: 'separator' },
    { label: lastSyncLabel, enabled: false },
    { label: vaultLabel, enabled: false },
    {
      label: 'Open Vault in Finder',
      enabled: !!vaultPath,
      click: () => shell.openPath(vaultPath),
    },
    {
      label: 'Set Vault Path...',
      click: async () => {
        // Show dock temporarily so the dialog gets focus on macOS
        if (process.platform === 'darwin') app.dock?.show();
        try {
          // Use a dummy hidden window as parent to ensure dialog appears in front
          const focusWin = new BrowserWindow({ show: false });
          const result = await dialog.showOpenDialog(focusWin, {
            properties: ['openDirectory'],
            title: 'Select Obsidian Vault',
          });
          focusWin.destroy();
          if (!result.canceled && result.filePaths.length > 0) {
            store.set('vaultPath', result.filePaths[0]);
            updateMenu();
          }
        } finally {
          if (process.platform === 'darwin') app.dock?.hide();
        }
      },
    },
    { type: 'separator' },
    {
      label: accountInfo ? 'Switch Account...' : 'Login to claude.ai',
      click: async () => {
        await openLoginWindow().catch(() => {});
        refreshAccountInfo();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        tray = null;
        require('electron').app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(`webui-sync - ${statusMessage}`);
}

function onStatus(state, message) {
  statusMessage = message;
  updateMenu();
}

function createTray() {
  // macOS: use "Template" suffix so the OS renders it correctly in menu bar
  const iconPath = path.join(__dirname, '..', 'assets', 'iconTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);

  tray = new Tray(icon);

  // Load cached account info first, then refresh from API
  accountInfo = store.get('cachedAccountInfo') || null;
  updateMenu();
  refreshAccountInfo();

  return { tray, onStatus, refreshAccountInfo };
}

module.exports = { createTray };
