const { net } = require('electron');

async function makeRequest(url, ses, extraHeaders) {
  // Manually attach cookies from session to work around Electron session isolation quirks
  let cookieHeader = '';
  if (ses) {
    const cookies = await ses.cookies.get({ url });
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  return new Promise((resolve, reject) => {
    const options = { url, useSessionCookies: !ses };
    if (ses) options.session = ses;

    const req = net.request(options);
    req.setHeader('Accept', 'application/json');
    req.setHeader('Content-Type', 'application/json');
    if (cookieHeader) req.setHeader('Cookie', cookieHeader);
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        req.setHeader(k, v);
      }
    }

    let body = '';
    req.on('response', (response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        reject(new Error('AUTH_EXPIRED'));
        return;
      }
      if (response.statusCode >= 400) {
        reject(new Error(`API error: ${response.statusCode}`));
        return;
      }
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Returns raw HTML (for Gemini page scraping)
async function makeRawRequest(url, ses) {
  let cookieHeader = '';
  if (ses) {
    const cookies = await ses.cookies.get({ url });
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  return new Promise((resolve, reject) => {
    const options = { url, useSessionCookies: !ses };
    if (ses) options.session = ses;

    const req = net.request(options);
    if (cookieHeader) req.setHeader('Cookie', cookieHeader);
    let body = '';
    req.on('response', (response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        reject(new Error('AUTH_EXPIRED'));
        return;
      }
      if (response.statusCode >= 400) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { makeRequest, makeRawRequest };
