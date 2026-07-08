// Auto-update via electron-updater (Squirrel.Mac) with GitHub Releases as the
// feed. The release CI signs + notarizes the .app and publishes latest-mac.yml
// alongside the .zip, which is exactly what autoUpdater downloads here.
//
// Tray-only app: we never force a restart. Updates download in the background
// and the tray surfaces a "Restart to Update" item; if the user just quits,
// electron-updater installs the staged update on next launch (autoInstallOnAppQuit).

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// status: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error'
let state = { status: 'idle', version: null, percent: 0, error: null };
let onChange = null;
let intervalTimer = null;
let wired = false;

function setState(next) {
  state = { ...state, ...next };
  onChange?.();
}

// Only meaningful in a packaged mac build. In dev there is no app-update.yml,
// so electron-updater would throw; skip cleanly and report a dev-only state.
function isSupported() {
  return process.platform === 'darwin' && app.isPackaged;
}

function wireEvents() {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) =>
    setState({ status: 'downloading', version: info?.version || null, percent: 0 }),
  );
  autoUpdater.on('update-not-available', () =>
    setState({ status: 'idle', version: null, percent: 0 }),
  );
  autoUpdater.on('download-progress', (p) =>
    setState({ status: 'downloading', percent: Math.round(p?.percent || 0) }),
  );
  autoUpdater.on('update-downloaded', (info) =>
    setState({ status: 'downloaded', version: info?.version || null, percent: 100 }),
  );
  autoUpdater.on('error', (err) => {
    console.error(`[updater] ${err?.message || err}`);
    setState({ status: 'error', error: err?.message || String(err) });
  });
}

// Kick off a check. `interactive` is set from the manual "Check for Updates…"
// menu item so we can surface "up to date" instead of silently going idle.
async function checkForUpdates({ interactive = false } = {}) {
  if (!isSupported()) {
    if (interactive)
      setState({ status: 'error', error: 'Updates are only available in the packaged app.' });
    return;
  }
  wireEvents();
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    console.error(`[updater] check failed: ${e?.message || e}`);
    setState({ status: 'error', error: e?.message || String(e) });
  }
}

function quitAndInstall() {
  if (state.status !== 'downloaded') return;
  // isSilent=false (show the installer progress), isForceRunAfter=true (relaunch).
  autoUpdater.quitAndInstall(false, true);
}

function initUpdater(onChangeCallback) {
  onChange = onChangeCallback;
  if (!isSupported()) return;
  // Don't compete with tray/scheduler startup; first check shortly after launch,
  // then on a fixed interval for as long as the app stays resident.
  setTimeout(() => checkForUpdates().catch(() => {}), 10_000);
  intervalTimer = setInterval(() => checkForUpdates().catch(() => {}), CHECK_INTERVAL_MS);
}

function stopUpdater() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

function getUpdateState() {
  return { ...state, supported: isSupported() };
}

module.exports = {
  initUpdater,
  stopUpdater,
  checkForUpdates,
  quitAndInstall,
  getUpdateState,
};
