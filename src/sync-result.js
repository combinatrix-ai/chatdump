function addProviderFailures(failureDetails, failures = []) {
  for (const failure of failures) {
    const id = failure.id || 'unknown';
    if (!failureDetails.has(id)) {
      failureDetails.set(id, failure.error || 'provider fetch failed');
    }
  }
  return failureDetails.size;
}

function partialFailureMessage(count) {
  return count > 0 ? `${count} conversation(s) failed during sync` : null;
}

module.exports = { addProviderFailures, partialFailureMessage };
