function addProviderFailures(failureDetails, failures = []) {
  for (const failure of failures) {
    const id = failure.id || 'unknown';
    if (!failureDetails.has(id)) {
      failureDetails.set(id, failure.error || 'provider fetch failed');
    }
  }
  return failureDetails.size;
}

const FULL_SYNC_PREFIX = 'full-sync:';

// Log line written when a sync starts, naming the window it will cover.
function syncStartLabel(options = {}) {
  if (options.mode?.startsWith(FULL_SYNC_PREFIX)) {
    return `Full sync started (${options.mode.slice(FULL_SYNC_PREFIX.length)})`;
  }
  if (options.sinceDays != null) return `Sync started (last ${options.sinceDays}d)`;
  return 'Sync started';
}

// Log line and tray status written when a sync ends, however it ended.
function syncSummaryMessage({
  stopped = false,
  written = 0,
  fetched = 0,
  failedConversations = 0,
  totalConvs = 0,
} = {}) {
  if (stopped) return `Stopped: ${written} files written, ${fetched} fetched`;
  if (failedConversations) {
    return `Partial sync: ${written} files (${failedConversations} failed, ${fetched} fetched)`;
  }
  if (written > 0) return `Synced ${written} files (${fetched} fetched)`;
  return `Up to date (${totalConvs || 0} checked)`;
}

function partialFailureMessage(count) {
  return count > 0 ? `${count} conversation(s) failed during sync` : null;
}

module.exports = { addProviderFailures, partialFailureMessage, syncStartLabel, syncSummaryMessage };
