const assert = require('node:assert/strict');
const test = require('node:test');
const {
  configureProviderSessionPermissions,
  _test: { isLocalNetworkPermission },
} = require('../src/session-permissions');

test('recognizes Chromium local-network permission names', () => {
  assert.equal(isLocalNetworkPermission('local-network'), true);
  assert.equal(isLocalNetworkPermission('local-network-access'), true);
  assert.equal(isLocalNetworkPermission('loopback-network'), true);
  assert.equal(isLocalNetworkPermission('notifications'), false);
});

test('provider sessions deny only local-network permission checks and requests', () => {
  let checkHandler;
  let requestHandler;
  const ses = {
    setPermissionCheckHandler: (handler) => {
      checkHandler = handler;
    },
    setPermissionRequestHandler: (handler) => {
      requestHandler = handler;
    },
  };

  assert.equal(configureProviderSessionPermissions(ses), ses);

  assert.equal(checkHandler(null, 'local-network'), false);
  assert.equal(checkHandler(null, 'local-network-access'), false);
  assert.equal(checkHandler(null, 'loopback-network'), false);
  assert.equal(checkHandler(null, 'notifications'), true);

  for (const permission of [
    'local-network',
    'local-network-access',
    'loopback-network',
    'notifications',
  ]) {
    let decision;
    requestHandler(null, permission, (allowed) => {
      decision = allowed;
    });
    assert.equal(decision, permission === 'notifications');
  }
});
