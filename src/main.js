const { app } = require('electron');
const { createTray } = require('./tray');
const { startScheduler, stopScheduler, setAccountRefreshCallback } = require('./scheduler');
const store = require('./store');

// Don't show dock icon on macOS (tray-only app)
if (process.platform === 'darwin') {
  app.dock?.hide();
}

app.whenReady().then(() => {
  const { onStatus, refreshAccountInfo } = createTray();
  setAccountRefreshCallback(refreshAccountInfo);

  // If vault path is configured, start scheduler
  if (store.get('vaultPath')) {
    startScheduler(onStatus);
  } else {
    onStatus('idle', 'Set vault path to start');
  }
});

app.on('window-all-closed', (e) => {
  // Prevent app from quitting when all windows close (tray app)
  e.preventDefault();
});

app.on('before-quit', () => {
  stopScheduler();
});
