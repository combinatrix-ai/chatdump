const { BrowserWindow, session, app } = require('electron');
const { getProvider } = require('./providers');

function getSession(accountId) {
  if (!accountId) return session.defaultSession;
  return session.fromPartition(`persist:${accountId}`);
}

// Find auth cookie — handles both exact name and prefix (split cookies like .0, .1)
async function findAuthCookie(ses, prov) {
  // Try exact match first
  const cookies = await ses.cookies.get({ url: prov.baseUrl, name: prov.cookieName });
  if (cookies.length > 0) return cookies[0].value;

  // Try prefix match (e.g. __Secure-next-auth.session-token.0)
  if (prov.cookiePrefix) {
    const allCookies = await ses.cookies.get({ url: prov.baseUrl });
    const matched = allCookies
      .filter((c) => c.name.startsWith(prov.cookieName))
      .sort((a, b) => getCookieChunkIndex(a.name) - getCookieChunkIndex(b.name));
    if (matched.length > 0) {
      return matched.map((c) => c.value).join('');
    }
  }

  return null;
}

function getCookieChunkIndex(name) {
  const suffix = name.split('.').pop();
  const index = Number.parseInt(suffix, 10);
  return Number.isNaN(index) ? Number.MAX_SAFE_INTEGER : index;
}

async function getSessionCookie(providerName, accountId) {
  const prov = getProvider(providerName);
  if (!prov) return null;
  return findAuthCookie(getSession(accountId), prov);
}

function openLoginWindow(providerName, accountId) {
  const prov = getProvider(providerName);
  if (!prov) return Promise.reject(new Error(`Unknown provider: ${providerName}`));

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

    let resolved = false;

    // Clear any existing auth cookies so the change listener only fires on a real new login.
    // Without this, stale cookies (e.g. on re-login) can cause the listener to fire while the
    // login page itself rotates session cookies, closing the window before the user logs in.
    (async () => {
      try {
        const existing = await ses.cookies.get({ url: prov.baseUrl });
        for (const c of existing) {
          const matches =
            c.name === prov.cookieName || (prov.cookiePrefix && c.name.startsWith(prov.cookieName));
          if (matches) {
            await ses.cookies.remove(prov.baseUrl, c.name);
          }
        }
      } catch (e) {
        console.log(`[auth] Could not clear existing cookies: ${e.message}`);
      }
      win.loadURL(prov.loginUrl);
    })();

    async function finish(cookie) {
      if (resolved) return;
      resolved = true;
      console.log(`[auth] Login success for ${prov.name}`);
      ses.cookies.removeListener('changed', onCookieChanged);

      // Grab all cookies for the provider domain — providers can extract info from them
      let accountInfo = null;
      const allCookies = {};
      try {
        const cookieList = await ses.cookies.get({ url: prov.baseUrl });
        for (const c of cookieList) {
          allCookies[c.name] = c.value;
        }
      } catch {
        /* ignore */
      }

      // Also try fetching account info via browser JS context
      if (prov.meEndpoint) {
        try {
          const raw = await win.webContents.executeJavaScript(
            `fetch('${prov.meEndpoint}', { credentials: 'include' }).then(r => r.json()).then(d => JSON.stringify(d))`,
          );
          accountInfo = JSON.parse(raw);
          console.log(`[auth] Fetched account info via browser for ${prov.name}`);
        } catch (e) {
          console.log(`[auth] Could not fetch account info via browser: ${e.message}`);
        }
      }

      win.close();
      resolve({ cookie, session: ses, partition: partitionName, accountInfo, cookies: allCookies });
    }

    function onCookieChanged(_event, cookie, _cause, removed) {
      if (removed) return;
      // Match exact name or prefix (e.g. cookieName.0, cookieName.1)
      const matches =
        cookie.name === prov.cookieName ||
        (prov.cookiePrefix && cookie.name.startsWith(prov.cookieName));
      if (!matches) return;

      const domain = new URL(prov.baseUrl).hostname;
      if (cookie.domain === domain || cookie.domain === `.${domain}`) {
        console.log(`[auth] Cookie ${cookie.name} set for ${cookie.domain}`);
        // Delay to let all split cookies arrive
        setTimeout(async () => {
          // Don't resolve if we're still on a login/auth page — ChatGPT rotates
          // session cookies during the login flow before the user has actually authenticated.
          const currentUrl = win.isDestroyed() ? '' : win.webContents.getURL();
          if (/\/(auth|login|signin|signup|sign-in|sign-up|oauth|authorize)/i.test(currentUrl)) {
            console.log(`[auth] Ignoring cookie change while on auth page: ${currentUrl}`);
            return;
          }
          const value = await findAuthCookie(ses, prov);
          if (value) finish(value);
        }, 1000);
      }
    }

    ses.cookies.on('changed', onCookieChanged);

    win.webContents.on('did-navigate', async () => {
      const url = win.webContents.getURL();
      console.log(`[auth] Navigate: ${url}`);
    });

    win.on('closed', async () => {
      if (process.platform === 'darwin') app.dock?.hide();
      ses.cookies.removeListener('changed', onCookieChanged);
      if (resolved) return;

      const cookie = await findAuthCookie(ses, prov);
      if (cookie) {
        resolve({ cookie, session: ses, partition: partitionName });
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

module.exports = { getSession, openLoginWindow, ensureAuthenticated };
