const { app } = require('electron');
const { createTray } = require('./tray');
const { startScheduler, stopScheduler, setMenuRefreshCallback } = require('./scheduler');
const { store, getAccounts } = require('./store');

// Don't show dock icon on macOS (tray-only app)
if (process.platform === 'darwin') {
  app.dock?.hide();
}

app.whenReady().then(() => {
  const { onStatus, buildMenu } = createTray();
  setMenuRefreshCallback(buildMenu);

  // Start scheduler if there are any accounts
  if (getAccounts().length > 0) {
    startScheduler(onStatus);
  } else {
    onStatus('idle', 'Add an account to start');
  }
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  stopScheduler();
});
