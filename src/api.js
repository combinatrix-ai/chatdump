const { net } = require('electron');
const store = require('./store');

const BASE_URL = 'https://claude.ai/api';

function request(path) {
  return new Promise((resolve, reject) => {
    const req = net.request({
      url: `${BASE_URL}${path}`,
      useSessionCookies: true,
    });
    req.setHeader('Accept', 'application/json');
    req.setHeader('Content-Type', 'application/json');

    let body = '';
    req.on('response', (response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        reject(new Error('AUTH_EXPIRED'));
        return;
      }
      if (response.statusCode >= 400) {
        reject(new Error(`API error: ${response.statusCode}`));
        return;
      }
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getOrgId() {
  let orgId = store.get('orgId');
  if (orgId) return orgId;

  const orgs = await request('/organizations');
  if (!orgs || orgs.length === 0) throw new Error('No organizations found');
  orgId = orgs[0].uuid;
  store.set('orgId', orgId);
  return orgId;
}

async function listConversations() {
  const orgId = await getOrgId();
  console.log(`[webui-sync] listing conversations for org ${orgId}`);
  const result = await request(`/organizations/${orgId}/chat_conversations`);
  console.log(`[webui-sync] listConversations returned ${Array.isArray(result) ? result.length : typeof result} items`);
  return result;
}

async function getConversation(conversationId) {
  const orgId = await getOrgId();
  return request(`/organizations/${orgId}/chat_conversations/${conversationId}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchUpdatedConversations(onProgress) {
  const conversations = await listConversations();
  const timestamps = store.get('lastConversationTimestamps');
  const updated = [];

  const toFetch = conversations.filter((conv) => {
    const lastKnown = timestamps[conv.uuid];
    return !lastKnown || lastKnown !== conv.updated_at;
  });

  console.log(`[webui-sync] ${toFetch.length}/${conversations.length} conversations need fetching`);

  for (let i = 0; i < toFetch.length; i++) {
    const conv = toFetch[i];
    onProgress?.(i + 1, toFetch.length);
    await sleep(500); // Rate limit
    try {
      const full = await getConversation(conv.uuid);
      updated.push(full);
      timestamps[conv.uuid] = conv.updated_at;
    } catch (e) {
      console.error(`Failed to fetch conversation ${conv.uuid}: ${e.message}`);
    }
  }

  store.set('lastConversationTimestamps', timestamps);
  return updated;
}

async function getAccountInfo() {
  try {
    const orgs = await request('/organizations');
    console.log('[webui-sync] orgs response:', JSON.stringify(orgs, null, 2));
    if (!orgs || orgs.length === 0) return null;

    const org = orgs[0];
    let email = '';
    let name = '';

    // Try multiple endpoints to find user info
    for (const endpoint of ['/bootstrap', '/auth/user', '/settings']) {
      try {
        const data = await request(endpoint);
        console.log(`[webui-sync] ${endpoint} response keys:`, Object.keys(data || {}));
        console.log(`[webui-sync] ${endpoint} response:`, JSON.stringify(data, null, 2).slice(0, 2000));

        // Try common paths for email/name
        email = email ||
          data?.account?.email_address ||
          data?.email ||
          data?.user?.email ||
          data?.account?.email ||
          '';
        name = name ||
          data?.account?.display_name ||
          data?.account?.full_name ||
          data?.name ||
          data?.user?.name ||
          data?.account?.name ||
          '';

        if (email || name) break;
      } catch (e) {
        console.log(`[webui-sync] ${endpoint} failed: ${e.message}`);
      }
    }

    const info = {
      email,
      name,
      orgName: org.name || '',
      orgId: org.uuid,
      plan: org.capabilities?.includes('claude_max') ? 'Max'
        : org.capabilities?.includes('claude_pro') ? 'Pro'
        : org.active_flags?.includes('pro') ? 'Pro'
        : org.active_flags?.includes('max') ? 'Max'
        : 'Free',
    };
    console.log('[webui-sync] accountInfo result:', JSON.stringify(info));
    return info;
  } catch (e) {
    console.error('[webui-sync] getAccountInfo error:', e.message);
    if (e.message === 'AUTH_EXPIRED') throw e;
    return null;
  }
}

module.exports = { listConversations, getConversation, fetchUpdatedConversations, getOrgId, getAccountInfo };
