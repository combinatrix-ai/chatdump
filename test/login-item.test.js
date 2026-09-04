const assert = require('node:assert/strict');
const test = require('node:test');
const { readStartAtLogin, setStartAtLogin, toggleStartAtLogin } = require('../src/login-item');

function fakeApp(initial = false) {
  const state = { openAtLogin: initial };
  const calls = [];
  return {
    state,
    calls,
    getLoginItemSettings() {
      calls.push(['get']);
      return { openAtLogin: state.openAtLogin };
    },
    setLoginItemSettings(settings) {
      calls.push(['set', settings]);
      state.openAtLogin = settings.openAtLogin;
    },
  };
}

test('reads the current OS login-item setting', () => {
  const app = fakeApp(true);

  assert.deepEqual(readStartAtLogin(app), { ok: true, enabled: true });
  assert.equal(app.calls.length, 1);
});

test('toggles from the current OS value and verifies the resulting value', () => {
  const app = fakeApp(true);

  assert.deepEqual(toggleStartAtLogin(app), { ok: true, enabled: false });
  assert.equal(app.state.openAtLogin, false);
  assert.deepEqual(app.calls, [['get'], ['get'], ['set', { openAtLogin: false }], ['get']]);
});

test('setting an explicit value uses OS readback as the result', () => {
  const app = fakeApp(false);

  assert.deepEqual(setStartAtLogin(app, true), { ok: true, enabled: true });
  assert.equal(app.state.openAtLogin, true);
});

test('reports setter failures without throwing', () => {
  const app = fakeApp(false);
  app.setLoginItemSettings = () => {
    throw new Error('permission denied');
  };

  assert.deepEqual(setStartAtLogin(app, true), {
    ok: false,
    enabled: false,
    error: 'permission denied',
  });
});

test('reports unavailable or failing OS reads without throwing', () => {
  assert.deepEqual(readStartAtLogin({}), {
    ok: false,
    enabled: false,
    error: 'Login item settings are unavailable on this platform.',
  });

  assert.deepEqual(
    readStartAtLogin({
      getLoginItemSettings() {
        throw new Error('failed to query login items');
      },
    }),
    { ok: false, enabled: false, error: 'failed to query login items' },
  );
});

test('reports when the OS does not apply the requested value', () => {
  const app = fakeApp(false);
  app.setLoginItemSettings = () => {};

  assert.deepEqual(setStartAtLogin(app, true), {
    ok: false,
    enabled: false,
    error: 'The system reported Start at Login is disabled after the change.',
  });
});
