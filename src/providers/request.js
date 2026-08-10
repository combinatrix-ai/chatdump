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

// Provider sync treats authentication expiry and an explicit request abort as
// control-flow errors. Keep the checks in one place so per-conversation loops
// do not accidentally turn either condition into a successful partial sync.
function isAuthExpiredError(error) {
  return error?.message === 'AUTH_EXPIRED';
}

function isRequestAbortedError(error) {
  return error?.message === 'Request aborted';
}

function shouldRethrowProviderError(error, signal) {
  return Boolean(signal?.aborted) || isAuthExpiredError(error) || isRequestAbortedError(error);
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
    cancel,
    finish() {
      if (settled) return false;
      settled = true;
      cleanup();
      return true;
    },
  };
}

function redactedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key,
      /authorization|cookie/i.test(key) ? '[redacted]' : value,
    ]),
  );
}

function isAllowedHost(hostname, allowedHosts, allowedHostSuffixes) {
  return (
    allowedHosts.includes(hostname) ||
    allowedHostSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
  );
}

function createBinaryAccumulator(maxBytes) {
  const chunks = [];
  let size = 0;

  return {
    write(chunk) {
      size += chunk.length;
      if (size > maxBytes) throw createHttpError(`Image exceeds ${maxBytes} byte limit`);
      chunks.push(Buffer.from(chunk));
    },
    end() {
      return Buffer.concat(chunks, size);
    },
  };
}

// Shared transport for every provider call: attach cookies, drive the request
// through its timeout/abort lifecycle, accumulate the body, and log transport
// failures. Response logging, status classification and payload parsing stay
// with the callers below — those are the only things the four request kinds
// actually disagree on.
//
// `buildHeaders(cookieHeader)` lets each caller keep its own header
// precedence. Resolves { status, headers, value, finalUrl, durationMs,
// requestHeaders }, where requestHeaders is the log-ready (optionally
// redacted) copy and `value` comes from the accumulator.
async function sendRequest(config) {
  const {
    url,
    ses,
    method = 'GET',
    kind,
    buildHeaders,
    cookieUrls,
    body = null,
    signal,
    timeoutMs = 60000,
    netOptions = null,
    createAccumulator = createUtf8Accumulator,
    logUrl = url,
    redactLogHeaders = false,
    onRedirect = null,
  } = config;

  throwIfAborted(signal);
  const cookieHeader = await buildCookieHeader(ses, cookieUrls || [url]);
  throwIfAborted(signal);

  const requestHeaders = buildHeaders(cookieHeader);
  const logHeaders = redactLogHeaders ? redactedHeaders(requestHeaders) : requestHeaders;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const requestOptions = { url, useSessionCookies: !ses, ...(netOptions || {}) };
    if (method !== 'GET') requestOptions.method = method;
    if (ses) requestOptions.session = ses;

    const req = net.request(requestOptions);
    for (const [key, value] of Object.entries(requestHeaders)) {
      req.setHeader(key, value);
    }

    const lifecycle = setupRequestCancellation(req, signal, timeoutMs, (error) => {
      logRequestError(kind, method, logUrl, startedAt, logHeaders, error);
      reject(error);
    });

    if (onRedirect) {
      req.on('redirect', (_statusCode, _method, redirectUrl) => {
        onRedirect(req, redirectUrl, lifecycle.cancel);
      });
    }

    const accumulator = createAccumulator();
    req.on('response', (response) => {
      response.on('data', (chunk) => {
        try {
          accumulator.write(chunk);
        } catch (e) {
          lifecycle.cancel(e);
        }
      });
      response.on('end', () => {
        if (!lifecycle.finish()) return;
        resolve({
          status: response.statusCode,
          headers: response.headers,
          value: accumulator.end(),
          finalUrl: response.url || url,
          durationMs: Date.now() - startedAt,
          requestHeaders: logHeaders,
        });
      });
    });
    req.on('error', (err) => {
      if (!lifecycle.finish()) return;
      logRequestError(kind, method, logUrl, startedAt, logHeaders, err);
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

// Auth expiry first (it is a control-flow signal providers act on), then any
// other error status. `prefix` distinguishes the JSON and raw wordings.
function throwForErrorStatus(prefix, url, { status, headers, value }) {
  const authError = classifyAuthStatus(status, headers, value);
  if (authError) throw authError;
  if (status >= 400) {
    throw createHttpError(`${prefix} ${status} ${url} body=${truncate(value)}`, status);
  }
}

function summarizeJson(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    keys: Object.keys(parsed),
    total: parsed.total,
    limit: parsed.limit,
    offset: parsed.offset,
    itemsLength: Array.isArray(parsed.items) ? parsed.items.length : undefined,
  };
}

async function makeRequest(url, ses, extraHeaders, options = {}) {
  const response = await sendRequest({
    url,
    ses,
    kind: 'json',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    redactLogHeaders: options.redactSecrets,
    buildHeaders: (cookieHeader) => ({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(extraHeaders || {}),
    }),
  });

  let parsed = null;
  try {
    parsed = JSON.parse(response.value);
  } catch {
    /* leave parsed=null */
  }

  logHttp({
    kind: 'json',
    method: 'GET',
    url,
    status: response.status,
    durationMs: response.durationMs,
    requestHeaders: response.requestHeaders,
    responseHeaders: response.headers,
    responseSummary: summarizeJson(parsed),
    responseBody: options.redactSecrets ? undefined : truncate(response.value),
    ok: response.status < 400,
  });

  throwForErrorStatus('API error:', url, response);
  if (parsed === null) throw new Error(`Parse error on ${url}`);
  return parsed;
}

async function makeRawRequest(url, ses, options = {}) {
  const response = await sendRequest({
    url,
    ses,
    kind: 'raw',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    buildHeaders: (cookieHeader) => (cookieHeader ? { Cookie: cookieHeader } : {}),
  });

  logRawResponse('GET', url, response);
  throwForErrorStatus('HTTP', url, response);
  return response.value;
}

async function makeRawPostRequest(
  url,
  ses,
  body,
  extraHeaders = {},
  cookieUrls = [url],
  options = {},
) {
  const response = await sendRequest({
    url,
    ses,
    method: 'POST',
    kind: 'raw',
    body,
    cookieUrls,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    buildHeaders: (cookieHeader) => ({
      ...extraHeaders,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    }),
  });

  logRawResponse('POST', url, response);
  throwForErrorStatus('HTTP', url, response);
  return response.value;
}

function logRawResponse(method, url, response) {
  logHttp({
    kind: 'raw',
    method,
    url,
    status: response.status,
    durationMs: response.durationMs,
    requestHeaders: response.requestHeaders,
    responseHeaders: response.headers,
    responseBody: truncate(response.value),
    ok: response.status < 400,
  });
}

// Image downloads are the one place a redirect can leave the origin we
// authenticated against, so they follow redirects manually: every hop is
// re-checked against the allowlist and credentials are dropped cross-host.
function makeRedirectGuard(originHost, allowedHosts, allowedHostSuffixes) {
  return (req, redirectUrl, cancel) => {
    let redirect;
    try {
      redirect = new URL(redirectUrl);
    } catch {
      cancel(new Error('Invalid image redirect URL'));
      return;
    }
    if (
      redirect.protocol !== 'https:' ||
      !isAllowedHost(redirect.hostname, allowedHosts, allowedHostSuffixes)
    ) {
      cancel(new Error(`Image redirect host is not allowed: ${redirect.hostname}`));
      return;
    }
    if (redirect.hostname !== originHost) {
      req.removeHeader('Authorization');
      req.removeHeader('Cookie');
    }
    req.followRedirect();
  };
}

async function makeBinaryRequest(url, ses, extraHeaders = {}, options = {}) {
  const { maxBytes = 50 * 1024 * 1024 } = options;
  throwIfAborted(options.signal);
  const parsedUrl = new URL(url);
  const allowedHosts = options.allowedHosts || [];
  const allowedHostSuffixes = options.allowedHostSuffixes || [];
  if (parsedUrl.protocol !== 'https:') throw new Error('Binary request requires HTTPS');
  if (
    (allowedHosts.length > 0 || allowedHostSuffixes.length > 0) &&
    !isAllowedHost(parsedUrl.hostname, allowedHosts, allowedHostSuffixes)
  ) {
    throw new Error(`Binary request host is not allowed: ${parsedUrl.hostname}`);
  }

  const response = await sendRequest({
    url,
    ses,
    kind: 'binary',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    logUrl: parsedUrl.origin,
    redactLogHeaders: true,
    netOptions: { redirect: 'manual' },
    createAccumulator: () => createBinaryAccumulator(maxBytes),
    onRedirect: makeRedirectGuard(parsedUrl.hostname, allowedHosts, allowedHostSuffixes),
    buildHeaders: (cookieHeader) => ({
      Accept: 'image/png,image/jpeg,image/webp,image/gif,application/octet-stream',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...extraHeaders,
    }),
  });

  const contentType = getHeader(response.headers, 'content-type');
  logHttp({
    kind: 'binary',
    method: 'GET',
    url: parsedUrl.origin,
    status: response.status,
    durationMs: response.durationMs,
    requestHeaders: response.requestHeaders,
    responseHeaders: {
      'content-type': contentType,
      'content-length': getHeader(response.headers, 'content-length'),
    },
    responseSummary: { bytes: response.value.length },
    ok: response.status < 400,
  });

  if (response.status === 401 || response.status === 403) {
    throw createAuthExpiredError(response.status);
  }
  if (response.status >= 400) {
    throw createHttpError(`Image request failed: HTTP ${response.status}`, response.status);
  }
  return {
    data: response.value,
    contentType,
    finalUrl: response.finalUrl,
    status: response.status,
  };
}

module.exports = {
  makeRequest,
  makeBinaryRequest,
  makeRawRequest,
  makeRawPostRequest,
  isAuthExpiredError,
  isRequestAbortedError,
  shouldRethrowProviderError,
  _test: {
    createUtf8Accumulator,
    isAllowedHost,
    redactedHeaders,
  },
};
