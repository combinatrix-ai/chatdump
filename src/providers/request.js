const { net } = require('electron');
const { logHttp } = require('../debug-log');

const BODY_LOG_LIMIT = 4096;

function truncate(s) {
  if (typeof s !== 'string') return s;
  return s.length > BODY_LOG_LIMIT
    ? `${s.slice(0, BODY_LOG_LIMIT)}…(+${s.length - BODY_LOG_LIMIT} bytes)`
    : s;
}

async function buildCookieHeader(ses, urls) {
  if (!ses) return '';

  const seen = new Set();
  const parts = [];
  for (const url of urls) {
    const cookies = await ses.cookies.get({ url });
    for (const cookie of cookies) {
      const key = `${cookie.name}=${cookie.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(key);
    }
  }
  return parts.join('; ');
}

async function makeRequest(url, ses, extraHeaders) {
  const cookieHeader = await buildCookieHeader(ses, [url]);

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
  const cookieHeader = await buildCookieHeader(ses, [url]);

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

async function makeRawPostRequest(url, ses, body, extraHeaders = {}, cookieUrls = [url]) {
  const cookieHeader = await buildCookieHeader(ses, cookieUrls);

  const requestHeaders = {
    ...extraHeaders,
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const options = { url, method: 'POST', useSessionCookies: !ses };
    if (ses) options.session = ses;

    const req = net.request(options);
    for (const [k, v] of Object.entries(requestHeaders)) {
      req.setHeader(k, v);
    }

    let responseBody = '';
    req.on('response', (response) => {
      const status = response.statusCode;
      const responseHeaders = response.headers;

      response.on('data', (chunk) => {
        responseBody += chunk.toString();
      });
      response.on('end', () => {
        const durationMs = Date.now() - startedAt;
        const ok = status < 400;

        logHttp({
          kind: 'raw',
          method: 'POST',
          url,
          status,
          durationMs,
          requestHeaders,
          responseHeaders,
          responseBody: truncate(responseBody),
          ok,
        });

        if (status === 401 || status === 403) {
          reject(new Error('AUTH_EXPIRED'));
          return;
        }
        if (status >= 400) {
          reject(new Error(`HTTP ${status} ${url} body=${truncate(responseBody)}`));
          return;
        }
        resolve(responseBody);
      });
    });
    req.on('error', (err) => {
      logHttp({
        kind: 'raw',
        method: 'POST',
        url,
        durationMs: Date.now() - startedAt,
        requestHeaders,
        error: err.message,
        ok: false,
      });
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { makeRequest, makeRawRequest, makeRawPostRequest };
