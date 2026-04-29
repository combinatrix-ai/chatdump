function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      await sleep(delayMs);
    }
  }

  throw lastError;
}

module.exports = { withRetry };
