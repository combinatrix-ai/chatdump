// Covers the four request functions end to end against a fake electron `net`.
// They are the transport every provider runs through, so the status
// classification, payload handling, cancellation and image host rules below
// are what keep a refactor of the shared plumbing honest.
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

// --- fake electron `net` --------------------------------------------------

const pending = [];

class FakeRequest extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.headers = {};
    this.written = [];
    this.ended = false;
    this.aborted = false;
  }

  setHeader(key, value) {
    this.headers[key] = value;
  }

  removeHeader(key) {
    delete this.headers[key];
  }

  write(chunk) {
    this.written.push(chunk);
  }

  end() {
    this.ended = true;
  }

  abort() {
    this.aborted = true;
  }

  followRedirect() {
    this.followed = true;
  }

  // Test-side driver: deliver a response and complete the request.
  respond({ status = 200, headers = {}, body = '', url } = {}) {
    const response = new EventEmitter();
    response.statusCode = status;
    response.headers = headers;
    if (url) response.url = url;
    this.emit('response', response);
    for (const chunk of Array.isArray(body) ? body : [body]) {
      response.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    response.emit('end');
  }
}

const electronStub = {
  net: {
    request(options) {
      const req = new FakeRequest(options);
      pending.push(req);
      return req;
    },
  },
};

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};

const {
  makeRequest,
  makeRawRequest,
  makeRawPostRequest,
  makeBinaryRequest,
} = require('../src/providers/request');

Module._load = originalLoad;

// --- helpers --------------------------------------------------------------

const SESSION = {
  cookies: {
    get: async () => [
      { name: 'sessionKey', value: 'abc' },
      { name: 'other', value: 'def' },
    ],
  },
};

// Run `start()`, wait for it to reach net.request, then let the test drive the
// captured request object.
async function withRequest(start, drive) {
  pending.length = 0;
  const promise = start();
  const req = await waitForRequest();
  await drive(req);
  return promise;
}

async function waitForRequest() {
  for (let i = 0; i < 100 && pending.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(pending.length > 0, 'expected a net.request to be issued');
  return pending[0];
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);

// --- makeRequest (JSON) ---------------------------------------------------

test('makeRequest sends cookies and resolves the parsed body', async () => {
  let captured;
  const result = await withRequest(
    () => makeRequest('https://claude.ai/api/x', SESSION, { 'X-Extra': '1' }),
    (req) => {
      captured = req;
      req.respond({ body: JSON.stringify({ items: [1, 2] }) });
    },
  );

  assert.deepEqual(result, { items: [1, 2] });
  assert.equal(captured.headers.Cookie, 'sessionKey=abc; other=def');
  assert.equal(captured.headers.Accept, 'application/json');
  assert.equal(captured.headers['X-Extra'], '1');
  assert.equal(captured.options.session, SESSION);
  assert.equal(captured.ended, true);
});

test('makeRequest rejects an unparseable body', async () => {
  await assert.rejects(
    withRequest(
      () => makeRequest('https://claude.ai/api/x', SESSION),
      (req) => req.respond({ body: 'not json' }),
    ),
    /Parse error on https:\/\/claude.ai\/api\/x/,
  );
});

test('makeRequest maps 401 to AUTH_EXPIRED', async () => {
  await assert.rejects(
    withRequest(
      () => makeRequest('https://claude.ai/api/x', SESSION),
      (req) => req.respond({ status: 401, body: '{}' }),
    ),
    (e) => e.message === 'AUTH_EXPIRED' && e.statusCode === 401,
  );
});

test('makeRequest treats a plain 403 as expired but a challenge 403 as an HTTP error', async () => {
  await assert.rejects(
    withRequest(
      () => makeRequest('https://claude.ai/api/x', SESSION),
      (req) => req.respond({ status: 403, headers: { 'content-type': 'application/json' } }),
    ),
    (e) => e.message === 'AUTH_EXPIRED' && e.statusCode === 403,
  );

  await assert.rejects(
    withRequest(
      () => makeRequest('https://claude.ai/api/x', SESSION),
      (req) =>
        req.respond({
          status: 403,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: 'Just a moment…',
        }),
    ),
    (e) => /HTTP 403/.test(e.message) && e.statusCode === 403,
  );
});

test('makeRequest reports other error statuses with the body', async () => {
  await assert.rejects(
    withRequest(
      () => makeRequest('https://claude.ai/api/x', SESSION),
      (req) => req.respond({ status: 500, body: 'boom' }),
    ),
    (e) => /API error: 500/.test(e.message) && /boom/.test(e.message) && e.statusCode === 500,
  );
});

test('makeRequest rejects and aborts when the signal fires mid-flight', async () => {
  const controller = new AbortController();
  let captured;
  const promise = withRequest(
    () => makeRequest('https://claude.ai/api/x', SESSION, undefined, { signal: controller.signal }),
    (req) => {
      captured = req;
      controller.abort();
    },
  );

  await assert.rejects(promise, /Request aborted/);
  assert.equal(captured.aborted, true);
});

test('makeRequest refuses to start once the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  pending.length = 0;

  await assert.rejects(
    makeRequest('https://claude.ai/api/x', SESSION, undefined, { signal: controller.signal }),
    /Request aborted/,
  );
  assert.equal(pending.length, 0);
});

test('makeRequest surfaces transport errors', async () => {
  await assert.rejects(
    withRequest(
      () => makeRequest('https://claude.ai/api/x', SESSION),
      (req) => req.emit('error', new Error('socket hang up')),
    ),
    /socket hang up/,
  );
});

// --- makeRawRequest / makeRawPostRequest ----------------------------------

test('makeRawRequest resolves the undecoded body and sends only cookies', async () => {
  let captured;
  const body = await withRequest(
    () => makeRawRequest('https://gemini.google.com/app', SESSION),
    (req) => {
      captured = req;
      req.respond({ body: '<html>結果</html>' });
    },
  );

  assert.equal(body, '<html>結果</html>');
  assert.deepEqual(Object.keys(captured.headers), ['Cookie']);
});

test('makeRawRequest reports error statuses as HTTP errors', async () => {
  await assert.rejects(
    withRequest(
      () => makeRawRequest('https://gemini.google.com/app', SESSION),
      (req) => req.respond({ status: 502, body: 'bad gateway' }),
    ),
    (e) => /HTTP 502/.test(e.message) && e.statusCode === 502,
  );
});

test('makeRawPostRequest writes the body and keeps cookies over extra headers', async () => {
  let captured;
  const body = await withRequest(
    () =>
      makeRawPostRequest(
        'https://gemini.google.com/rpc',
        SESSION,
        'f.req=payload',
        {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://gemini.google.com',
        },
        ['https://gemini.google.com', 'https://google.com'],
      ),
    (req) => {
      captured = req;
      req.respond({ body: ")]}'\n[[]]" });
    },
  );

  assert.equal(body, ")]}'\n[[]]");
  assert.equal(captured.options.method, 'POST');
  assert.deepEqual(captured.written, ['f.req=payload']);
  assert.equal(captured.headers.Origin, 'https://gemini.google.com');
  assert.equal(captured.headers.Cookie, 'sessionKey=abc; other=def');
});

// --- makeBinaryRequest ----------------------------------------------------

test('makeBinaryRequest returns the bytes and the content type', async () => {
  const result = await withRequest(
    () =>
      makeBinaryRequest('https://chatgpt.com/file', SESSION, {}, { allowedHosts: ['chatgpt.com'] }),
    (req) =>
      req.respond({
        headers: { 'content-type': 'image/png' },
        body: [PNG.subarray(0, 4), PNG.subarray(4)],
      }),
  );

  assert.ok(result.data.equals(PNG));
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.status, 200);
});

test('makeBinaryRequest requires https and an allowed host', async () => {
  await assert.rejects(
    makeBinaryRequest('http://chatgpt.com/file', SESSION, {}, { allowedHosts: ['chatgpt.com'] }),
    /requires HTTPS/,
  );
  await assert.rejects(
    makeBinaryRequest('https://evil.example/file', SESSION, {}, { allowedHosts: ['chatgpt.com'] }),
    /host is not allowed: evil.example/,
  );
});

test('makeBinaryRequest strips credentials when redirected cross-host', async () => {
  let captured;
  await withRequest(
    () =>
      makeBinaryRequest(
        'https://chatgpt.com/file',
        SESSION,
        { Authorization: 'Bearer secret' },
        { allowedHosts: ['chatgpt.com'], allowedHostSuffixes: ['oaiusercontent.com'] },
      ),
    (req) => {
      captured = req;
      req.emit('redirect', 302, 'GET', 'https://files.oaiusercontent.com/x');
      req.respond({ headers: { 'content-type': 'image/png' }, body: PNG });
    },
  );

  assert.equal(captured.options.redirect, 'manual');
  assert.equal(captured.followed, true);
  assert.equal(captured.headers.Authorization, undefined);
  assert.equal(captured.headers.Cookie, undefined);
});

test('makeBinaryRequest refuses a redirect to a disallowed host', async () => {
  await assert.rejects(
    withRequest(
      () =>
        makeBinaryRequest(
          'https://chatgpt.com/file',
          SESSION,
          {},
          { allowedHosts: ['chatgpt.com'], allowedHostSuffixes: ['oaiusercontent.com'] },
        ),
      (req) => req.emit('redirect', 302, 'GET', 'https://evil.example/x'),
    ),
    /redirect host is not allowed: evil.example/i,
  );
});

test('makeBinaryRequest stops once the byte cap is exceeded', async () => {
  await assert.rejects(
    withRequest(
      () =>
        makeBinaryRequest(
          'https://chatgpt.com/file',
          SESSION,
          {},
          { allowedHosts: ['chatgpt.com'], maxBytes: 4 },
        ),
      (req) => req.respond({ body: Buffer.alloc(16) }),
    ),
    /exceeds 4 byte limit/,
  );
});

test('makeBinaryRequest maps 401 and 403 to AUTH_EXPIRED', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      withRequest(
        () =>
          makeBinaryRequest(
            'https://chatgpt.com/file',
            SESSION,
            {},
            { allowedHosts: ['chatgpt.com'] },
          ),
        (req) => req.respond({ status }),
      ),
      (e) => e.message === 'AUTH_EXPIRED' && e.statusCode === status,
    );
  }
});
