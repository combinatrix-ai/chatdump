// Debug script: opens ChatGPT login, keeps window open, and probes the API
const { app, BrowserWindow, session } = require('electron');

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:debug-openai');

  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    title: 'Debug: ChatGPT',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: ses,
    },
  });

  // Check if already logged in
  const cookies = await ses.cookies.get({ url: 'https://chatgpt.com' });
  const hasSession = cookies.some(c => c.name.startsWith('__Secure-next-auth.session-token'));

  if (hasSession) {
    console.log('=== Already have session cookies, loading chatgpt.com directly ===');
    win.loadURL('https://chatgpt.com/');
  } else {
    console.log('=== No session, loading login page ===');
    win.loadURL('https://chatgpt.com/auth/login');
  }

  // Wait for the page to fully load on chatgpt.com domain
  win.webContents.on('did-finish-load', async () => {
    const url = win.webContents.getURL();
    if (!url.startsWith('https://chatgpt.com/') || url.includes('/auth/') || url.includes('/login')) {
      console.log(`[waiting] Still on: ${url}`);
      return;
    }

    console.log(`\n=== Page loaded: ${url} ===`);
    console.log('=== Probing APIs from browser context ===\n');

    // Probe 1: /backend-api/me with various approaches
    const probes = [
      {
        name: '/backend-api/me (simple fetch)',
        code: `fetch('/backend-api/me').then(r => ({ status: r.status, headers: Object.fromEntries(r.headers), body: r.text() })).then(async o => JSON.stringify({ status: o.status, body: (await o.body).slice(0, 1000) }))`,
      },
      {
        name: '/backend-api/me (with credentials)',
        code: `fetch('/backend-api/me', { credentials: 'include' }).then(r => ({ status: r.status, body: r.text() })).then(async o => JSON.stringify({ status: o.status, body: (await o.body).slice(0, 1000) }))`,
      },
      {
        name: '/backend-api/me (with auth header from page)',
        code: `
          (async () => {
            // Try to find access token in page state
            let token = '';
            try {
              const r = await fetch('/api/auth/session', { credentials: 'include' });
              const d = await r.json();
              token = d.accessToken || d.access_token || '';
            } catch(e) {}

            const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
            const r = await fetch('/backend-api/me', { credentials: 'include', headers });
            const body = await r.text();
            return JSON.stringify({ status: r.status, hasToken: !!token, tokenPrefix: token.slice(0,20), body: body.slice(0, 1000) });
          })()
        `,
      },
      {
        name: '/api/auth/session',
        code: `fetch('/api/auth/session', { credentials: 'include' }).then(r => r.text()).then(t => JSON.stringify({ body: t.slice(0, 1000) }))`,
      },
      {
        name: 'Check window.__NEXT_DATA__',
        code: `JSON.stringify({ hasNextData: !!window.__NEXT_DATA__, keys: window.__NEXT_DATA__ ? Object.keys(window.__NEXT_DATA__) : [], props: window.__NEXT_DATA__?.props ? Object.keys(window.__NEXT_DATA__.props) : [] })`,
      },
    ];

    for (const probe of probes) {
      console.log(`--- ${probe.name} ---`);
      try {
        const result = await win.webContents.executeJavaScript(probe.code);
        const parsed = JSON.parse(result);
        console.log(JSON.stringify(parsed, null, 2));
      } catch (e) {
        console.log(`Error: ${e.message}`);
      }
      console.log('');
    }

    // Also dump interesting cookies
    console.log('=== Relevant Cookies ===');
    const allCookies = await ses.cookies.get({ url: 'https://chatgpt.com' });
    for (const c of allCookies) {
      if (['oai-gn', 'oai-client-auth-info', '_puid', 'oai-sc'].includes(c.name)) {
        const val = decodeURIComponent(c.value);
        console.log(`${c.name} = ${val.slice(0, 200)}`);
      }
    }

    console.log('\n=== Done. Window stays open for manual inspection. ===');
  });
});
