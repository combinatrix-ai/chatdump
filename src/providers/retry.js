const { sleep } = require('../sleep');

function isRetryableHttpError(error) {
  const status = error?.statusCode;
  return status === 429 || (status >= 500 && status <= 504);
}

async function withRetry(operation, options = {}) {
  const {
    maxAttempts = 3,
    getDelayMs = (attempt) => 1000 * 2 ** (attempt - 1),
    shouldRetry = isRetryableHttpError,
    onRetry,
    signal,
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (e) {
      lastError = e;
      if (attempt >= maxAttempts || !shouldRetry(e)) {
        throw e;
      }

      const delayMs = getDelayMs(attempt, e);
      onRetry?.(e, attempt, maxAttempts, delayMs);
      // Wake early on abort: the next attempt then fails fast against the
      // aborted signal instead of sitting out a two-minute backoff.
      await sleep(delayMs, signal);
    }
  }

  throw lastError;
}

module.exports = { withRetry };
