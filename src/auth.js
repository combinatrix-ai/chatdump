const { BrowserWindow, session, app } = require('electron');
const { getProvider } = require('./providers');

// Each account gets its own persistent session partition
// so cookies don't bleed between accounts on the same provider
function getSession(accountId) {
  if (!accountId) return session.defaultSession;
  // persist: prefix makes it persistent across app restarts
  return session.fromPartition(`persist:${accountId}`);
}

async function getSessionCookie(providerName, accountId) {
  const prov = getProvider(providerName);
  if (!prov) return null;

  const ses = getSession(accountId);
  const cookies = await ses.cookies.get({
    url: prov.baseUrl,
    name: prov.cookieName,
  });
  return cookies.length > 0 ? cookies[0].value : null;
}

function openLoginWindow(providerName, accountId) {
  const prov = getProvider(providerName);
  if (!prov) return Promise.reject(new Error(`Unknown provider: ${providerName}`));

  // For new accounts (no accountId yet), use a temp partition
  // that we'll copy cookies from after login
  const partitionName = accountId ? `persist:${accountId}` : `temp:login-${Date.now()}`;
  const ses = session.fromPartition(partitionName);

  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') app.dock?.show();

    const win = new BrowserWindow({
      width: 800,
      height: 700,
      title: `Login to ${prov.displayName}`,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: ses,
      },
    });

    win.loadURL(prov.loginUrl);

    let resolved = false;
    let initialNavDone = false;

    win.webContents.on('did-finish-load', () => {
      initialNavDone = true;
    });

    async function checkLogin() {
      if (!initialNavDone) return;
      const url = win.webContents.getURL();

      const isLoginPage = url.includes('/login') || url.includes('/auth') || url.includes('/oauth') || url.includes('/signin');
      if (!isLoginPage && url.startsWith(prov.baseUrl)) {
        const cookies = await ses.cookies.get({
          url: prov.baseUrl,
          name: prov.cookieName,
        });
        if (cookies.length > 0 && !resolved) {
          resolved = true;
          win.close();
          resolve({ cookie: cookies[0].value, session: ses, partition: partitionName });
        }
      }
    }

    win.webContents.on('did-navigate', checkLogin);
    win.webContents.on('did-navigate-in-page', checkLogin);

    win.on('closed', async () => {
      if (process.platform === 'darwin') app.dock?.hide();
      if (resolved) return;
      const cookies = await ses.cookies.get({
        url: prov.baseUrl,
        name: prov.cookieName,
      });
      if (cookies.length > 0) {
        resolve({ cookie: cookies[0].value, session: ses, partition: partitionName });
      } else {
        reject(new Error('Login window closed without authentication'));
      }
    });
  });
}

async function ensureAuthenticated(providerName, accountId) {
  const cookie = await getSessionCookie(providerName, accountId);
  if (cookie) return cookie;
  const result = await openLoginWindow(providerName, accountId);
  return result.cookie;
}

module.exports = { getSession, getSessionCookie, openLoginWindow, ensureAuthenticated };
