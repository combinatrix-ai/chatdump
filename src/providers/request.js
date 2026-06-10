const { net } = require('electron');
const { StringDecoder } = require('node:string_decoder');
const { logHttp } = require('../debug-log');

const BODY_LOG_LIMIT = 4096;

function truncate(s) {
  if (typeof s !== 'string') return s;
  return s.length > BODY_LOG_LIMIT
    ? `${s.slice(0, BODY_LOG_LIMIT)}…(+${s.length - BODY_LOG_LIMIT} bytes)`
    : s;
}

function createHttpError(message, statusCode) {
  const error = new Error(message);
  if (statusCode !== undefined) error.statusCode = statusCode;
  return error;
}

function createAuthExpiredError(statusCode) {
  const error = new Error('AUTH_EXPIRED');
  error.statusCode = statusCode;
  return error;
}

function getHeader(responseHeaders, name) {
  const lowerName = name.toLowerCase();
  const key = Object.keys(responseHeaders || {}).find((k) => k.toLowerCase() === lowerName);
  const value = key ? responseHeaders[key] : '';
  return Array.isArray(value) ? value.join(', ') : String(value || '');
}

function classifyAuthStatus(status, responseHeaders, body) {
  if (status === 401) return createAuthExpiredError(401);

  if (status !== 403) return null;

  const contentType = getHeader(responseHeaders, 'content-type');
  const isHtml = contentType.toLowerCase().includes('text/html');
  const isMitigation = /cloudflare|cf-mitigated|just a moment|challenge-platform/i.test(body);
  if (isHtml || isMitigation) {
    return createHttpError(`HTTP 403 body=${truncate(body)}`, 403);
  }

  return createAuthExpiredError(403);
}

function createUtf8Accumulator() {
  const decoder = new StringDecoder('utf8');
  let body = '';

  return {
    write(chunk) {
      body += decoder.write(chunk);
    },
    end() {
      body += decoder.end();
      return body;
    },
  };
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

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('Request aborted');
}

function logRequestError(kind, method, url, startedAt, requestHeaders, error) {
  logHttp({
    kind,
    method,
    url,
    durationMs: Date.now() - startedAt,
    requestHeaders,
    error: error.message,
    ok: false,
  });
}

function setupRequestCancellation(req, signal, timeoutMs, onCancel) {
  let settled = false;
  let timeoutId = null;
  let abortHandler = null;

  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  };

  const cancel = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    req.abort();
    onCancel(error);
  };

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      cancel(createHttpError(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  if (signal) {
    abortHandler = () => {
      cancel(new Error('Request aborted'));
    };
    signal.addEventListener('abort', abortHandler, { once: true });
    if (signal.aborted) abortHandler();
  }

  return {
    finish() {
      if (settled) return false;
      settled = true;
      cleanup();
      return true;
    },
  };
}

async function makeRequest(url, ses, extraHeaders, options = {}) {
  const { signal, timeoutMs = 60000 } = options;
  throwIfAborted(signal);
  const cookieHeader = await buildCookieHeader(ses, [url]);
  throwIfAborted(signal);

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

    const lifecycle = setupRequestCancellation(req, signal, timeoutMs, (error) => {
      logRequestError('json', 'GET', url, startedAt, requestHeaders, error);
      reject(error);
    });

    const responseBody = createUtf8Accumulator();
    req.on('response', (response) => {
      const status = response.statusCode;
      const responseHeaders = response.headers;

      response.on('data', (chunk) => {
        responseBody.write(chunk);
      });
      response.on('end', () => {
        if (!lifecycle.finish()) return;
        const body = responseBody.end();
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

        const authError = classifyAuthStatus(status, responseHeaders, body);
        if (authError) {
          reject(authError);
          return;
        }
        if (status >= 400) {
          reject(createHttpError(`API error: ${status} ${url} body=${truncate(body)}`, status));
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
      if (!lifecycle.finish()) return;
      logRequestError('json', 'GET', url, startedAt, requestHeaders, err);
      reject(err);
    });
    req.end();
  });
}

async function makeRawRequest(url, ses, options = {}) {
  const { signal, timeoutMs = 60000 } = options;
  throwIfAborted(signal);
  const cookieHeader = await buildCookieHeader(ses, [url]);
  throwIfAborted(signal);

  const requestHeaders = cookieHeader ? { Cookie: cookieHeader } : {};
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const options = { url, useSessionCookies: !ses };
    if (ses) options.session = ses;

    const req = net.request(options);
    for (const [k, v] of Object.entries(requestHeaders)) {
      req.setHeader(k, v);
    }

    const lifecycle = setupRequestCancellation(req, signal, timeoutMs, (error) => {
      logRequestError('raw', 'GET', url, startedAt, requestHeaders, error);
      reject(error);
    });

    const responseBody = createUtf8Accumulator();
    req.on('response', (response) => {
      const status = response.statusCode;
      const responseHeaders = response.headers;

      response.on('data', (chunk) => {
        responseBody.write(chunk);
      });
      response.on('end', () => {
        if (!lifecycle.finish()) return;
        const body = responseBody.end();
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

        const authError = classifyAuthStatus(status, responseHeaders, body);
        if (authError) {
          reject(authError);
          return;
        }
        if (status >= 400) {
          reject(createHttpError(`HTTP ${status} ${url} body=${truncate(body)}`, status));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', (err) => {
      if (!lifecycle.finish()) return;
      logRequestError('raw', 'GET', url, startedAt, requestHeaders, err);
      reject(err);
    });
    req.end();
  });
}

async function makeRawPostRequest(
  url,
  ses,
  body,
  extraHeaders = {},
  cookieUrls = [url],
  options = {},
) {
  const { signal, timeoutMs = 60000 } = options;
  throwIfAborted(signal);
  const cookieHeader = await buildCookieHeader(ses, cookieUrls);
  throwIfAborted(signal);

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

    const lifecycle = setupRequestCancellation(req, signal, timeoutMs, (error) => {
      logRequestError('raw', 'POST', url, startedAt, requestHeaders, error);
      reject(error);
    });

    const responseBody = createUtf8Accumulator();
    req.on('response', (response) => {
      const status = response.statusCode;
      const responseHeaders = response.headers;

      response.on('data', (chunk) => {
        responseBody.write(chunk);
      });
      response.on('end', () => {
        if (!lifecycle.finish()) return;
        const body = responseBody.end();
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
          responseBody: truncate(body),
          ok,
        });

        const authError = classifyAuthStatus(status, responseHeaders, body);
        if (authError) {
          reject(authError);
          return;
        }
        if (status >= 400) {
          reject(createHttpError(`HTTP ${status} ${url} body=${truncate(body)}`, status));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', (err) => {
      if (!lifecycle.finish()) return;
      logRequestError('raw', 'POST', url, startedAt, requestHeaders, err);
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = {
  makeRequest,
  makeRawRequest,
  makeRawPostRequest,
  _test: { createUtf8Accumulator },
};
