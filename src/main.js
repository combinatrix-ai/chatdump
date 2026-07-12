// Swallow EPIPE on stdout/stderr — happens when the launching terminal goes away
// while the detached Electron process keeps running. Without this, any later
// console.log/error throws and crashes the app.
process.stdout.on('error', (e) => {
  if (e.code !== 'EPIPE') throw e;
});
process.stderr.on('error', (e) => {
  if (e.code !== 'EPIPE') throw e;
});

const { app, dialog, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromeUserAgent } = require('./user-agent');
const { createTray } = require('./tray');
const {
  startScheduler,
  stopScheduler,
  stopAllSyncs,
  setMenuRefreshCallback,
} = require('./scheduler');
const { store, getAccounts } = require('./store');
const { getSession } = require('./auth');
const { getProvider } = require('./providers');
const { isCliInstallAvailable, installCliTool, getCliInstallStatus } = require('./cli-install');
const { startIpcServer, stopIpcServer } = require('./ipc-server');
const { initUpdater, stopUpdater } = require('./updater');

// Electron's default User-Agent identifies both Electron and this application.
// Use the bundled Chromium major version so browser windows and net.request
// resemble the corresponding stable Chrome release without a stale hard-coded UA.
app.userAgentFallback = chromeUserAgent(process.versions.chrome);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  console.log('[main] Another chatdump instance is already running; exiting');
  app.quit();
}

function ensureDefaultVaultPath() {
  if (store.get('defaultVaultPath')) return;
  if (process.mas) return;
  const fallback = path.join(os.homedir(), 'chatdump');
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch (e) {
    console.error(`[main] Failed to create default vault at ${fallback}: ${e.message}`);
    return;
  }
  store.set('defaultVaultPath', fallback);
  console.log(`[main] Default vault initialised at ${fallback}`);
}
const {
  ENABLED: DEBUG_ENABLED,
  BODY_ENABLED: DEBUG_BODY_ENABLED,
  getLogPath,
} = require('./debug-log');

if (DEBUG_ENABLED) {
  const bodyMode = DEBUG_BODY_ENABLED ? 'response bodies included' : 'response bodies omitted';
  console.log(`[debug] HTTP logging enabled (${bodyMode}) → ${getLogPath()}`);
}

// Don't show dock icon on macOS (tray-only app)
if (process.platform === 'darwin') {
  app.dock?.hide();
}

// Migrate cookies from defaultSession to per-account partitions (one-time)
async function migrateCookies() {
  const migrated = store.get('cookiesMigrated');
  if (migrated) return;

  const accounts = getAccounts();
  for (const account of accounts) {
    const prov = getProvider(account.provider);
    if (!prov) continue;

    const cookies = await session.defaultSession.cookies.get({ url: prov.baseUrl });
    if (cookies.length === 0) continue;

    const ses = getSession(account.id);
    for (const cookie of cookies) {
      await ses.cookies
        .set({
          url: prov.baseUrl,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: cookie.expirationDate,
        })
        .catch(() => {});
    }
    console.log(`[migrate] Copied cookies for ${account.id}`);
  }
  store.set('cookiesMigrated', true);
}

async function cleanupOrphanPartitions() {
  const partitionsDir = path.join(app.getPath('userData'), 'Partitions');
  let entries;
  try {
    entries = await fs.promises.readdir(partitionsDir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.log(`[main] Could not read partitions directory: ${e.message}`);
    }
    return;
  }

  const currentAccountIds = new Set(getAccounts().map((account) => account.id));
  const orphanPattern = /^(?:[a-z]+):account-\d+$/;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    let partitionId;
    try {
      partitionId = decodeURIComponent(entry.name);
    } catch {
      continue;
    }

    if (!orphanPattern.test(partitionId)) continue;
    if (currentAccountIds.has(partitionId)) continue;

    try {
      await session.fromPartition(`persist:${partitionId}`).clearStorageData();
      console.log(`[main] Cleared orphaned login partition ${partitionId}`);
    } catch (e) {
      console.log(`[main] Could not clear orphaned login partition ${partitionId}: ${e.message}`);
    }
  }
}

// Offer to install the `chatdump` command line tool once, the first time the
// GUI app runs after it becomes available (packaged, non-MAS builds).
async function maybePromptCliInstall(buildMenu) {
  if (!isCliInstallAvailable()) return;
  if (store.get('cliInstallPrompted')) return;
  store.set('cliInstallPrompted', true);

  if (getCliInstallStatus().installed) return;

  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Install', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Install command line tool?',
    message: 'Install the chatdump command line tool?',
    detail: 'Enables chatdump cli and the MCP server from your terminal.',
  });
  if (response !== 0) return;

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
  buildMenu?.();
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    ensureDefaultVaultPath();
    await migrateCookies();
    await cleanupOrphanPartitions();

    const { onStatus, buildMenu } = createTray();
    setMenuRefreshCallback(buildMenu);
    startIpcServer();
    initUpdater(buildMenu);

    if (getAccounts().length > 0) {
      startScheduler(onStatus);
    } else {
      onStatus('idle', 'Add an account to start');
    }

    // Non-blocking: don't hold up scheduler/tray startup on this dialog.
    maybePromptCliInstall(buildMenu).catch((e) => {
      console.error(`[main] CLI install prompt failed: ${e.message}`);
    });
  });

  app.on('window-all-closed', () => {
    // Tray-only app: keep running after login/dialog windows close.
  });

  app.on('before-quit', () => {
    stopIpcServer();
    stopAllSyncs();
    stopScheduler();
    stopUpdater();
  });
}
