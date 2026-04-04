const { BrowserWindow, session, app } = require('electron');

const CLAUDE_URL = 'https://claude.ai';

async function getSessionCookie() {
  const cookies = await session.defaultSession.cookies.get({
    url: CLAUDE_URL,
    name: 'sessionKey',
  });
  return cookies.length > 0 ? cookies[0].value : null;
}

function openLoginWindow() {
  return new Promise((resolve, reject) => {
    // Show dock so the window gets focus on macOS
    if (process.platform === 'darwin') app.dock?.show();

    const win = new BrowserWindow({
      width: 800,
      height: 700,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    win.loadURL(`${CLAUDE_URL}/login`);

    let resolved = false;
    let initialNavDone = false;

    // Wait for the initial page to finish loading before watching navigations
    win.webContents.on('did-finish-load', () => {
      initialNavDone = true;
    });

    async function checkLogin() {
      if (!initialNavDone) return;
      const url = win.webContents.getURL();
      // Only auto-close when user has landed on the main chat page (login complete)
      if (url.startsWith(`${CLAUDE_URL}/`) && !url.includes('/login') && !url.includes('/oauth')) {
        const cookie = await getSessionCookie();
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
      const cookie = await getSessionCookie();
      if (cookie) {
        resolve(cookie);
      } else {
        reject(new Error('Login window closed without authentication'));
      }
    });
  });
}

async function ensureAuthenticated() {
  let cookie = await getSessionCookie();
  if (cookie) return cookie;
  return openLoginWindow();
}

module.exports = { getSessionCookie, openLoginWindow, ensureAuthenticated };
