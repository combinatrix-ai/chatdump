const { net } = require('electron');
const { logHttp } = require('../debug-log');

const BODY_LOG_LIMIT = 4096;

function truncate(s) {
  if (typeof s !== 'string') return s;
  return s.length > BODY_LOG_LIMIT
    ? `${s.slice(0, BODY_LOG_LIMIT)}…(+${s.length - BODY_LOG_LIMIT} bytes)`
    : s;
}

async function makeRequest(url, ses, extraHeaders) {
  let cookieHeader = '';
  if (ses) {
    const cookies = await ses.cookies.get({ url });
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  const requestHeaders = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(extraHeaders || {}),
  };
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const options = { url, useSessionCookies: !ses };
    if (ses) options.session = ses;

    const req = net.request(options);
    for (const [k, v] of Object.entries(requestHeaders)) {
      req.setHeader(k, v);
    }

    let body = '';
    req.on('response', (response) => {
      const status = response.statusCode;
      const responseHeaders = response.headers;

      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        const durationMs = Date.now() - startedAt;
        const ok = status < 400;

        let parsed = null;
        let summary = null;
        try {
          parsed = JSON.parse(body);
          if (parsed && typeof parsed === 'object') {
            summary = {
              keys: Object.keys(parsed),
              total: parsed.total,
              limit: parsed.limit,
              offset: parsed.offset,
              itemsLength: Array.isArray(parsed.items) ? parsed.items.length : undefined,
            };
          }
        } catch {
          /* leave parsed=null */
        }

        logHttp({
          kind: 'json',
          method: 'GET',
          url,
          status,
          durationMs,
          requestHeaders,
          responseHeaders,
          responseSummary: summary,
          responseBody: truncate(body),
          ok,
        });

        if (status === 401 || status === 403) {
          reject(new Error('AUTH_EXPIRED'));
          return;
        }
        if (status >= 400) {
          reject(new Error(`API error: ${status} ${url} body=${truncate(body)}`));
          return;
        }
        if (parsed === null) {
          reject(new Error(`Parse error on ${url}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', (err) => {
      logHttp({
        kind: 'json',
        method: 'GET',
        url,
        durationMs: Date.now() - startedAt,
        requestHeaders,
        error: err.message,
        ok: false,
      });
      reject(err);
    });
    req.end();
  });
}

async function makeRawRequest(url, ses) {
  let cookieHeader = '';
  if (ses) {
    const cookies = await ses.cookies.get({ url });
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  const requestHeaders = cookieHeader ? { Cookie: cookieHeader } : {};
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const options = { url, useSessionCookies: !ses };
    if (ses) options.session = ses;

    const req = net.request(options);
    for (const [k, v] of Object.entries(requestHeaders)) {
      req.setHeader(k, v);
    }

    let body = '';
    req.on('response', (response) => {
      const status = response.statusCode;
      const responseHeaders = response.headers;

      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        const durationMs = Date.now() - startedAt;
        const ok = status < 400;

        logHttp({
          kind: 'raw',
          method: 'GET',
          url,
          status,
          durationMs,
          requestHeaders,
          responseHeaders,
          responseBody: truncate(body),
          ok,
        });

        if (status === 401 || status === 403) {
          reject(new Error('AUTH_EXPIRED'));
          return;
        }
        if (status >= 400) {
          reject(new Error(`HTTP ${status} ${url} body=${truncate(body)}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', (err) => {
      logHttp({
        kind: 'raw',
        method: 'GET',
        url,
        durationMs: Date.now() - startedAt,
        requestHeaders,
        error: err.message,
        ok: false,
      });
      reject(err);
    });
    req.end();
  });
}

module.exports = { makeRequest, makeRawRequest };
