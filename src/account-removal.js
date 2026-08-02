async function removeAccountSafely(account, deps) {
  deps.stopSync(account.id);
  const stopped = await deps.waitForSyncStop(account.id);
  if (stopped === false) {
    const message = 'The sync could not be stopped, so the account was kept.';
    deps.updateAccount(account.id, { status: 'error', lastError: message });
    return { ok: false, error: message };
  }
  try {
    await deps.getSession(account.id).clearStorageData();
  } catch (error) {
    const message = 'The login session could not be cleared, so the account was kept.';
    deps.updateAccount(account.id, { status: 'error', lastError: message });
    deps.logger?.(`[account] Could not clear session for ${account.id}: ${error.message}`);
    return { ok: false, error: message };
  }
  deps.removeAccount(account.id);
  return { ok: true };
}

module.exports = { removeAccountSafely };
