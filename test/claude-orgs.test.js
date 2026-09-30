const assert = require('node:assert/strict');
const test = require('node:test');

// Replace the network layer before the provider loads it.
const requestPath = require.resolve('../src/providers/request');
const realRequest = require(requestPath);
let routes = {};
require.cache[requestPath].exports = {
  ...realRequest,
  makeRequest: async (url) => {
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (route === undefined) throw new Error(`unexpected ${url}`);
    return route;
  },
};
const sleepPath = require.resolve('../src/sleep');
require(sleepPath);
require.cache[sleepPath].exports = { sleep: async () => {} };
const claude = require('../src/providers/claude');

const BASE = 'https://claude.ai/api/organizations';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const API = 'cccccccc-0000-4000-8000-000000000003';

function conv(uuid, updated = '2026-01-01T00:00:00Z') {
  return { uuid, name: uuid, updated_at: updated, created_at: updated, chat_messages: [] };
}

test('fetchConversations exports every chat organization and tags each conversation', async () => {
  routes = {
    [BASE]: [
      { uuid: A, name: 'Personal', capabilities: ['chat', 'claude_max'] },
      { uuid: API, name: 'API only', capabilities: ['api'] },
      { uuid: B, name: 'Team', capabilities: ['chat', 'raven'] },
    ],
    [`${BASE}/${A}/chat_conversations`]: [conv('a1')],
    [`${BASE}/${B}/chat_conversations`]: [conv('b1'), conv('b2')],
    [`${BASE}/${A}/chat_conversations/a1`]: conv('a1'),
    [`${BASE}/${B}/chat_conversations/b1`]: conv('b1'),
    [`${BASE}/${B}/chat_conversations/b2`]: conv('b2'),
  };
  const got = [];
  const timestamps = { b2: '2026-01-01T00:00:00Z' };
  const res = await claude.fetchConversations(null, timestamps, null, async (c) => got.push(c));
  assert.deepEqual(res.failed, []);
  assert.deepEqual(res.orgs, [
    { uuid: A, name: 'Personal' },
    { uuid: B, name: 'Team' },
  ]);
  assert.deepEqual(
    got.map((c) => [c.uuid, c.org_uuid, c.org_name]),
    [
      ['a1', A, 'Personal'],
      ['b1', B, 'Team'],
    ],
  );
  assert.equal(timestamps.a1, '2026-01-01T00:00:00Z');
  assert.equal(timestamps.b1, '2026-01-01T00:00:00Z');
});

test('a later organization that refuses listing is recorded, the others still export', async () => {
  routes = {
    [BASE]: [
      { uuid: A, name: 'Personal', capabilities: ['chat'] },
      { uuid: B, name: 'Locked', capabilities: ['chat'] },
    ],
    [`${BASE}/${A}/chat_conversations`]: [conv('a1')],
    [`${BASE}/${B}/chat_conversations`]: new Error('AUTH_EXPIRED'),
    [`${BASE}/${A}/chat_conversations/a1`]: conv('a1'),
  };
  const got = [];
  const res = await claude.fetchConversations(null, {}, null, async (c) => got.push(c.uuid));
  assert.deepEqual(got, ['a1']);
  assert.deepEqual(res.failed, [{ id: `org:${B}`, error: 'AUTH_EXPIRED' }]);
});

test('the first organization failing still stops the sync as before', async () => {
  routes = {
    [BASE]: [{ uuid: A, name: 'Personal', capabilities: ['chat'] }],
    [`${BASE}/${A}/chat_conversations`]: new Error('AUTH_EXPIRED'),
  };
  await assert.rejects(
    claude.fetchConversations(null, {}, null, async () => {}),
    /AUTH_EXPIRED/,
  );
});

test('chatOrganizations keeps orgs without a capabilities list and falls back to the first org', () => {
  const { chatOrganizations } = claude._test;
  assert.deepEqual(
    chatOrganizations([{ uuid: A }, { uuid: API, capabilities: ['api'] }]).map((o) => o.uuid),
    [A],
  );
  assert.deepEqual(
    chatOrganizations([{ uuid: API, capabilities: ['api'] }]).map((o) => o.uuid),
    [API],
  );
});

test('convertToMarkdown writes org_uuid and org_name when the conversation has them', () => {
  const md = claude.convertToMarkdown({ ...conv('x'), org_uuid: A, org_name: 'Team "Q"' });
  assert.match(
    md,
    /parser_version: 1\norg_uuid: "aaaaaaaa-0000-4000-8000-000000000001"\norg_name: "Team \\"Q\\""\n---/,
  );
  assert.doesNotMatch(claude.convertToMarkdown(conv('y')), /org_uuid/);
});

test('project names are listed for every chat organization, and only a complete list is reported', async () => {
  routes = {
    [BASE]: [
      { uuid: A, name: 'Personal', capabilities: ['chat'] },
      { uuid: B, name: 'Team', capabilities: ['chat'] },
    ],
    [`${BASE}/${A}/projects`]: [{ uuid: 'p-a', name: 'Home' }],
    [`${BASE}/${B}/projects`]: [{ uuid: 'p-b', name: 'Launch' }],
    [`${BASE}/${A}/chat_conversations`]: [],
    [`${BASE}/${B}/chat_conversations`]: [],
  };
  let got;
  await claude.fetchConversations(null, {}, null, null, { onProjects: (p) => (got = p) });
  assert.deepEqual(got, [
    { uuid: 'p-a', name: 'Home', orgId: A },
    { uuid: 'p-b', name: 'Launch', orgId: B },
  ]);

  routes[`${BASE}/${B}/projects`] = new Error('HTTP 404');
  got = undefined;
  await claude.fetchConversations(null, {}, null, null, { onProjects: (p) => (got = p) });
  assert.equal(got, undefined);
});
