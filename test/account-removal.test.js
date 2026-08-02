const assert = require('node:assert/strict');
const test = require('node:test');
const { removeAccountSafely } = require('../src/account-removal');

function deps(session, state) {
  return {
    stopSync: (id) => state.stopped.push(id),
    waitForSyncStop: async (id) => state.waited.push(id),
    getSession: () => session,
    removeAccount: (id) => state.removed.push(id),
    updateAccount: (id, update) => state.updated.push({ id, update }),
  };
}

test('removeAccountSafely keeps the record when sync does not stop', async () => {
  const state = { stopped: [], waited: [], removed: [], updated: [] };
  const result = await removeAccountSafely(
    { id: 'openai:user@example.com' },
    {
      ...deps(
        {
          clearStorageData: async () => {
            throw new Error('must not clear');
          },
        },
        state,
      ),
      waitForSyncStop: async () => false,
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /sync could not be stopped/);
  assert.deepEqual(state.removed, []);
  assert.equal(state.updated[0].update.status, 'error');
});

test('removeAccountSafely clears the persistent session before removing the record', async () => {
  const state = { stopped: [], waited: [], removed: [], updated: [] };
  const result = await removeAccountSafely(
    { id: 'openai:user@example.com' },
    deps({ clearStorageData: async () => (state.cleared = true) }, state),
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(state.cleared, true);
  assert.deepEqual(state.stopped, ['openai:user@example.com']);
  assert.deepEqual(state.waited, ['openai:user@example.com']);
  assert.deepEqual(state.removed, ['openai:user@example.com']);
  assert.deepEqual(state.updated, []);
});

test('removeAccountSafely keeps the record when session clearing fails', async () => {
  const state = { stopped: [], waited: [], removed: [], updated: [] };
  const result = await removeAccountSafely(
    { id: 'openai:user@example.com' },
    deps(
      {
        clearStorageData: async () => {
          throw new Error('locked');
        },
      },
      state,
    ),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /could not be cleared/);
  assert.deepEqual(state.stopped, ['openai:user@example.com']);
  assert.deepEqual(state.waited, ['openai:user@example.com']);
  assert.deepEqual(state.removed, []);
  assert.equal(state.updated[0].update.status, 'error');
});
