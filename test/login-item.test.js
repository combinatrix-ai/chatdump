const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyStartAtLoginDefault,
  readStartAtLogin,
  setStartAtLogin,
  toggleStartAtLogin,
} = require('../src/login-item');

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

function fakeStore(initial = {}) {
  const values = { ...initial };
  return {
    values,
    get(key, fallback) {
      return values[key] ?? fallback;
    },
    set(key, value) {
      values[key] = value;
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

test('applies Start at Login once when no default has been recorded', () => {
  const app = fakeApp(false);
  const store = fakeStore();

  assert.deepEqual(applyStartAtLoginDefault(app, store), {
    ok: true,
    enabled: true,
    applied: true,
  });
  assert.equal(store.values.startAtLoginDefaultApplied, true);
});

test('does not apply the default from an unpackaged development run', () => {
  const app = { ...fakeApp(false), isPackaged: false };
  const store = fakeStore();

  assert.deepEqual(applyStartAtLoginDefault(app, store), {
    ok: true,
    enabled: false,
    applied: false,
  });
  assert.deepEqual(app.calls, [['get']]);
  assert.equal(store.values.startAtLoginDefaultApplied, undefined);
});

test('preserves the current OS setting after the default was applied', () => {
  const app = fakeApp(false);
  const store = fakeStore({ startAtLoginDefaultApplied: true });

  assert.deepEqual(applyStartAtLoginDefault(app, store), {
    ok: true,
    enabled: false,
    applied: false,
  });
  assert.deepEqual(app.calls, [['get']]);
});

test('does not record a default that the OS failed to apply', () => {
  const app = fakeApp(false);
  app.setLoginItemSettings = () => {};
  const store = fakeStore();

  const result = applyStartAtLoginDefault(app, store);

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(store.values.startAtLoginDefaultApplied, undefined);
});

test('preserves an explicit opt-out instead of reapplying the default', () => {
  const app = fakeApp(true);
  const store = fakeStore();

  assert.deepEqual(toggleStartAtLogin(app, store), { ok: true, enabled: false });
  assert.deepEqual(applyStartAtLoginDefault(app, store), {
    ok: true,
    enabled: false,
    applied: false,
  });

  assert.equal(store.values.startAtLoginDefaultApplied, true);
});
