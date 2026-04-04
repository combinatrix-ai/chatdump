const { net } = require('electron');

function makeRequest(url, ses) {
  return new Promise((resolve, reject) => {
    const options = { url };
    if (ses) {
      options.session = ses;
    } else {
      options.useSessionCookies = true;
    }

    const req = net.request(options);
    req.setHeader('Accept', 'application/json');
    req.setHeader('Content-Type', 'application/json');

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
function makeRawRequest(url, ses) {
  return new Promise((resolve, reject) => {
    const options = { url };
    if (ses) {
      options.session = ses;
    } else {
      options.useSessionCookies = true;
    }

    const req = net.request(options);
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
