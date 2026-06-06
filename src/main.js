// Swallow EPIPE on stdout/stderr — happens when the launching terminal goes away
// while the detached Electron process keeps running. Without this, any later
// console.log/error throws and crashes the app.
process.stdout.on('error', (e) => {
  if (e.code !== 'EPIPE') throw e;
});
process.stderr.on('error', (e) => {
  if (e.code !== 'EPIPE') throw e;
});

const { app, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTray } = require('./tray');
const { startScheduler, stopScheduler, setMenuRefreshCallback } = require('./scheduler');
const { store, getAccounts } = require('./store');
const { getSession } = require('./auth');
const { getProvider } = require('./providers');

function ensureDefaultVaultPath() {
  if (store.get('defaultVaultPath')) return;
  if (process.mas) return;
  const fallback = path.join(os.homedir(), 'chativist');
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

app.whenReady().then(async () => {
  ensureDefaultVaultPath();
  await migrateCookies();

  const { onStatus, buildMenu } = createTray();
  setMenuRefreshCallback(buildMenu);

  if (getAccounts().length > 0) {
    startScheduler(onStatus);
  } else {
    onStatus('idle', 'Add an account to start');
  }
});

app.on('window-all-closed', () => {
  // Tray-only app: keep running after login/dialog windows close.
});

app.on('before-quit', () => {
  stopScheduler();
});
