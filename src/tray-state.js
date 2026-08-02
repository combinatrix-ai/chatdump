function getTrayIconState(accounts, syncingCount) {
  const needsAttention = accounts.some(
    (account) => account.status === 'expired' || Boolean(account.lastError),
  );
  if (needsAttention) return 'attention';
  if (syncingCount > 0) return 'syncing';
  return 'idle';
}

module.exports = { getTrayIconState };
