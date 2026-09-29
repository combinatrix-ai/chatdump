const assert = require('node:assert/strict');
const test = require('node:test');

// Load claude.js with a stubbed request module so no network or Electron is needed.
function loadClaude(routes) {
  const requestPath = require.resolve('../src/providers/request');
  const sleepPath = require.resolve('../src/sleep');
  const calls = [];
  const stub = {
    shouldRethrowProviderError: (_e, signal) => Boolean(signal?.aborted),
    makeRequest: async (url) => {
      calls.push(url);
      const route = routes.find(([m]) => url.endsWith(m));
      if (!route) throw new Error(`unexpected ${url}`);
      if (route[1] instanceof Error) throw route[1];
      return route[1];
    },
  };
  const claudePath = require.resolve('../src/providers/claude');
  delete require.cache[claudePath];
  require.cache[requestPath] = {
    id: requestPath,
    filename: requestPath,
    loaded: true,
    exports: stub,
  };
  require.cache[sleepPath] = {
    id: sleepPath,
    filename: sleepPath,
    loaded: true,
    exports: { sleep: async () => {} },
  };
  const claude = require(claudePath);
  delete require.cache[requestPath];
  delete require.cache[sleepPath];
  delete require.cache[claudePath];
  return { claude, calls };
}

test('fetchConversations reports project names when asked', async () => {
  const { claude } = loadClaude([
    ['/api/organizations', [{ uuid: 'org-1' }]],
    [
      '/api/organizations/org-1/projects',
      [{ uuid: 'p-1', name: 'Supdate', description: 'x' }, { name: 'no uuid' }],
    ],
    ['/api/organizations/org-1/chat_conversations', []],
  ]);
  let got;
  await claude.fetchConversations({}, {}, null, null, {
    onProjects: (p) => {
      got = p;
    },
  });
  assert.deepEqual(got, [{ uuid: 'p-1', name: 'Supdate', orgId: 'org-1' }]);
});

test('a failing project list never stops the export, and nothing is fetched without onProjects', async () => {
  const { claude, calls } = loadClaude([
    ['/api/organizations', [{ uuid: 'org-1' }]],
    ['/api/organizations/org-1/projects', new Error('HTTP 404')],
    ['/api/organizations/org-1/chat_conversations', [{ uuid: 'c-1', updated_at: 't' }]],
    ['/api/organizations/org-1/chat_conversations/c-1', { uuid: 'c-1' }],
  ]);
  const seen = [];
  await claude.fetchConversations({}, {}, null, (c) => seen.push(c.uuid), {
    onProjects: () => assert.fail('not called'),
  });
  assert.deepEqual(seen, ['c-1']);
  calls.length = 0;
  await claude.fetchConversations({}, {}, null, null, {});
  assert.ok(!calls.some((u) => u.endsWith('/projects')));
});
