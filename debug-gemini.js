// Debug script: opens Gemini, keeps window open, and probes APIs/cookies
const { app, BrowserWindow, session } = require('electron');

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:debug-gemini');

  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    title: 'Debug: Gemini',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: ses,
    },
  });

  // Check if already logged in
  const cookies = await ses.cookies.get({ url: 'https://gemini.google.com' });
  const hasSession = cookies.some(c => c.name === '__Secure-1PSID');

  if (hasSession) {
    console.log('=== Already have session cookies, loading Gemini directly ===');
    win.loadURL('https://gemini.google.com/app');
  } else {
    console.log('=== No session, loading Gemini (will redirect to Google login) ===');
    win.loadURL('https://gemini.google.com/app');
  }

  win.webContents.on('did-finish-load', async () => {
    const url = win.webContents.getURL();
    if (!url.startsWith('https://gemini.google.com/')) {
      console.log(`[waiting] Still on: ${url}`);
      return;
    }

    console.log(`\n=== Page loaded: ${url} ===`);
    console.log('=== Probing APIs from browser context ===\n');

    const probes = [
      {
        name: 'Extract user info from page',
        code: `
          (async () => {
            // Try various ways to find user info
            const results = {};

            // Check meta tags
            const metas = document.querySelectorAll('meta');
            const interestingMetas = {};
            metas.forEach(m => {
              const name = m.getAttribute('name') || m.getAttribute('property') || '';
              if (name.toLowerCase().includes('user') || name.toLowerCase().includes('email')) {
                interestingMetas[name] = m.getAttribute('content');
              }
            });
            results.metas = interestingMetas;

            // Check for user avatar/email in DOM
            const allText = document.body.innerText.slice(0, 500);
            results.bodyPreview = allText;

            // Look for email patterns in page source
            const html = document.documentElement.innerHTML;
            const emailMatches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g);
            results.emailsFound = [...new Set(emailMatches || [])].slice(0, 5);

            return JSON.stringify(results);
          })()
        `,
      },
      {
        name: 'Check WIZ_global_data',
        code: `
          (async () => {
            // Gemini uses WIZ framework, data is in window.WIZ_global_data
            const wiz = window.WIZ_global_data;
            if (wiz) {
              return JSON.stringify({
                keys: Object.keys(wiz),
                sample: JSON.stringify(wiz).slice(0, 1000)
              });
            }
            return JSON.stringify({ found: false });
          })()
        `,
      },
      {
        name: 'Check for conversation list API',
        code: `
          (async () => {
            // Try known Gemini API patterns
            const endpoints = [
              '/app/api/conversations',
              '/_/BardChatUi/data/batchexecute',
            ];
            const results = {};
            for (const ep of endpoints) {
              try {
                const r = await fetch(ep, { credentials: 'include' });
                results[ep] = { status: r.status, contentType: r.headers.get('content-type') };
                if (r.status === 200) {
                  const text = await r.text();
                  results[ep].bodyPreview = text.slice(0, 500);
                }
              } catch(e) {
                results[ep] = { error: e.message };
              }
            }
            return JSON.stringify(results);
          })()
        `,
      },
      {
        name: 'Intercept XHR/fetch patterns on page',
        code: `
          (async () => {
            // Check performance entries for API calls the page has made
            const entries = performance.getEntriesByType('resource')
              .filter(e => e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest')
              .map(e => e.name)
              .slice(0, 30);
            return JSON.stringify({ apiCalls: entries });
          })()
        `,
      },
      {
        name: 'Extract AT token (CSRF) from page',
        code: `
          (async () => {
            const html = document.documentElement.innerHTML;
            // Gemini embeds SNlM0e or similar token
            const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
            const blMatch = html.match(/"cfb2h":"([^"]+)"/);
            const sidMatch = html.match(/"FdrFJe":"([^"]+)"/);
            return JSON.stringify({
              hasAT: !!atMatch,
              atPreview: atMatch ? atMatch[1].slice(0, 50) : null,
              hasBL: !!blMatch,
              blPreview: blMatch ? blMatch[1].slice(0, 50) : null,
              hasSID: !!sidMatch,
              sidPreview: sidMatch ? sidMatch[1].slice(0, 50) : null,
            });
          })()
        `,
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

    // Dump interesting cookies
    console.log('=== Relevant Cookies ===');
    const allCookies = await ses.cookies.get({ url: 'https://gemini.google.com' });
    console.log(`Total cookies: ${allCookies.length}`);
    for (const c of allCookies) {
      // Show all cookie names and first 80 chars of value
      console.log(`  ${c.name} = ${c.value.slice(0, 80)}... (domain: ${c.domain})`);
    }

    console.log('\n=== Done. Window stays open for manual inspection. ===');
  });
});
