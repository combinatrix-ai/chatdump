const assert = require('node:assert/strict');
const test = require('node:test');
const { chromeUserAgent } = require('../src/user-agent');

test('builds a reduced Chrome user agent without Electron or the app name', () => {
  const userAgent = chromeUserAgent('144.0.7559.97', 'darwin');

  assert.equal(
    userAgent,
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  );
  assert.doesNotMatch(userAgent, /Electron|chatdump/i);
});

test('rejects a missing or malformed Chromium version', () => {
  assert.throws(() => chromeUserAgent('', 'darwin'), /Invalid Chrome version/);
  assert.throws(() => chromeUserAgent('beta', 'darwin'), /Invalid Chrome version/);
});
