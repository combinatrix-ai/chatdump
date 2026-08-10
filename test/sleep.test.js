const assert = require('node:assert/strict');
const test = require('node:test');
const { sleep } = require('../src/sleep');

// These tests never assert on elapsed time: a delay that failed to wake on
// abort would simply hang until the test runner's timeout.
const HOUR_MS = 60 * 60 * 1000;

function settled(promise) {
  const state = { done: false };
  state.promise = promise.then(() => {
    state.done = true;
  });
  return state;
}

const drainMacrotasks = () => new Promise((resolve) => setImmediate(resolve));

test('sleep resolves after the delay when no signal is given', async () => {
  await sleep(0);
});

test('sleep with an already-aborted signal resolves without arming a timer', async () => {
  const controller = new AbortController();
  controller.abort();
  await sleep(HOUR_MS, controller.signal);
});

test('sleep wakes as soon as the signal aborts', async () => {
  const controller = new AbortController();
  const state = settled(sleep(HOUR_MS, controller.signal));

  await drainMacrotasks();
  assert.equal(state.done, false, 'sleep resolved before the signal aborted');

  controller.abort();
  await state.promise;
  assert.equal(state.done, true);
});

test('sleep resolves rather than rejecting on abort', async () => {
  const controller = new AbortController();
  const pending = sleep(HOUR_MS, controller.signal);
  controller.abort();
  assert.equal(await pending, undefined);
});

test('sleep detaches its abort listener once the delay elapses', async () => {
  const listeners = [];
  const signal = {
    aborted: false,
    addEventListener: (type, handler) => listeners.push([type, handler]),
    removeEventListener: (type, handler) => {
      const index = listeners.findIndex(([t, h]) => t === type && h === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };

  await sleep(0, signal);
  assert.deepEqual(listeners, []);
});
