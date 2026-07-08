const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  _test: { getSocketPath, isGuiNotRunning },
} = require('../src/ipc-client');

test('getSocketPath resolves under the packaged app userData dir', () => {
  assert.equal(
    getSocketPath(),
    path.join(os.homedir(), 'Library', 'Application Support', 'chatdump', 'cli.sock'),
  );
});

test('isGuiNotRunning recognises ENOENT and ECONNREFUSED as "GUI not running"', () => {
  assert.equal(isGuiNotRunning({ code: 'ENOENT' }), true);
  assert.equal(isGuiNotRunning({ code: 'ECONNREFUSED' }), true);
  assert.equal(isGuiNotRunning({ code: 'EACCES' }), false);
  assert.equal(isGuiNotRunning(null), false);
});
