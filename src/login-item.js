// Small wrapper around Electron's login-item API. Keeping the OS readback and
// error handling here makes the tray menu easy to exercise without starting
// Electron.

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return String(error || 'Unknown error');
}

function readStartAtLogin(appApi) {
  try {
    if (typeof appApi?.getLoginItemSettings !== 'function') {
      throw new Error('Login item settings are unavailable on this platform.');
    }
    return { ok: true, enabled: Boolean(appApi.getLoginItemSettings().openAtLogin) };
  } catch (error) {
    return { ok: false, enabled: false, error: errorMessage(error) };
  }
}

function setStartAtLogin(appApi, enabled) {
  const desired = Boolean(enabled);
  const current = readStartAtLogin(appApi);
  if (!current.ok) return current;

  try {
    if (typeof appApi.setLoginItemSettings !== 'function') {
      throw new Error('Login item settings are unavailable on this platform.');
    }
    appApi.setLoginItemSettings({ openAtLogin: desired });
  } catch (error) {
    return { ok: false, enabled: current.enabled, error: errorMessage(error) };
  }

  // Electron's setter is synchronous, but read back from the OS so the UI
  // never treats our requested value as authoritative when the system rejects
  // or ignores it.
  const actual = readStartAtLogin(appApi);
  if (!actual.ok) return actual;
  if (actual.enabled !== desired) {
    return {
      ok: false,
      enabled: actual.enabled,
      error:
        `The system reported Start at Login is ${actual.enabled ? 'enabled' : 'disabled'} ` +
        'after the change.',
    };
  }
  return actual;
}

function toggleStartAtLogin(appApi) {
  const current = readStartAtLogin(appApi);
  if (!current.ok) return current;
  return setStartAtLogin(appApi, !current.enabled);
}

module.exports = {
  readStartAtLogin,
  setStartAtLogin,
  toggleStartAtLogin,
};
