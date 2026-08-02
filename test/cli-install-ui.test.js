const assert = require('node:assert/strict');
const test = require('node:test');
const { showCliInstallResult } = require('../src/cli-install-ui');

test('showCliInstallResult reports success and actionable failures', async () => {
  const shown = [];
  const dialog = { showMessageBox: async (options) => shown.push(options) };
  await showCliInstallResult(dialog, { ok: true, path: '/usr/local/bin/chatdump' });
  await showCliInstallResult(dialog, { ok: false, reason: 'error', message: 'permission denied' });
  await showCliInstallResult(dialog, { ok: false, reason: 'cancelled' });
  assert.equal(shown.length, 2);
  assert.match(shown[0].detail, /chatdump list/);
  assert.equal(shown[1].detail, 'permission denied');
});
