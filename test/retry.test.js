const assert = require('node:assert/strict');
const test = require('node:test');
const { withRetry } = require('../src/providers/retry');

const HOUR_MS = 60 * 60 * 1000;

function httpError(statusCode) {
  const error = new Error(`HTTP ${statusCode}`);
  error.statusCode = statusCode;
  return error;
}

test('withRetry retries retryable HTTP errors and returns the first success', async () => {
  const attempts = [];
  const result = await withRetry(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw httpError(429);
      return 'ok';
    },
    { getDelayMs: () => 0 },
  );

  assert.equal(result, 'ok');
  assert.deepEqual(attempts, [1, 2, 3]);
});

test('withRetry rethrows non-retryable errors without waiting', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw httpError(404);
      },
      { getDelayMs: () => HOUR_MS },
    ),
    /HTTP 404/,
  );
  assert.equal(calls, 1);
});

// Without signal-aware backoff this would sit out the full hour instead of
// letting the aborted request fail fast.
test('withRetry cuts its backoff short when the signal aborts', async () => {
  const controller = new AbortController();
  let calls = 0;

  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          controller.abort();
          throw httpError(500);
        }
        throw new Error('Request aborted');
      },
      { getDelayMs: () => HOUR_MS, signal: controller.signal },
    ),
    /Request aborted/,
  );
  assert.equal(calls, 2);
});
