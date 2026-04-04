const { BrowserWindow, session, app } = require('electron');
const { getProvider } = require('./providers');

async function getSessionCookie(providerName) {
  const prov = getProvider(providerName);
  if (!prov) return null;

  const cookies = await session.defaultSession.cookies.get({
    url: prov.baseUrl,
    name: prov.cookieName,
  });
  return cookies.length > 0 ? cookies[0].value : null;
}

function openLoginWindow(providerName) {
  const prov = getProvider(providerName);
  if (!prov) return Promise.reject(new Error(`Unknown provider: ${providerName}`));

  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') app.dock?.show();

    const win = new BrowserWindow({
      width: 800,
      height: 700,
      title: `Login to ${prov.displayName}`,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
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

      // Check if we've navigated away from login/auth pages
      const isLoginPage = url.includes('/login') || url.includes('/auth') || url.includes('/oauth') || url.includes('/signin');
      if (!isLoginPage && url.startsWith(prov.baseUrl)) {
        const cookie = await getSessionCookie(providerName);
        if (cookie && !resolved) {
          resolved = true;
          win.close();
          resolve(cookie);
        }
      }
    }

    win.webContents.on('did-navigate', checkLogin);
    win.webContents.on('did-navigate-in-page', checkLogin);

    win.on('closed', async () => {
      if (process.platform === 'darwin') app.dock?.hide();
      if (resolved) return;
      const cookie = await getSessionCookie(providerName);
      if (cookie) {
        resolve(cookie);
      } else {
        reject(new Error('Login window closed without authentication'));
      }
    });
  });
}

async function ensureAuthenticated(providerName) {
  const cookie = await getSessionCookie(providerName);
  if (cookie) return cookie;
  return openLoginWindow(providerName);
}

module.exports = { getSessionCookie, openLoginWindow, ensureAuthenticated };
