// Wait `ms`, or wake as soon as `signal` aborts. Never rejects: every caller
// already re-checks `signal.aborted` (or lets the next aborted request throw)
// after awaiting, and an abort here means "stop waiting", not "fail".
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

module.exports = { sleep };
