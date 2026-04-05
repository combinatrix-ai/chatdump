const { makeRequest } = require('./request');

const BASE = 'https://chatgpt.com';

const provider = {
  name: 'openai',
  displayName: 'ChatGPT',
  baseUrl: BASE,
  loginUrl: `${BASE}/auth/login`,
  subdir: 'chatgpt',
  cookieName: '__Secure-next-auth.session-token',
  cookiePrefix: true,
  meEndpoint: null, // We use cookies + /api/auth/session instead

  // Extract account info from cookies (primary method)
  parseAccountFromCookies(cookies) {
    let email = '';
    let name = cookies['oai-gn'] ? decodeURIComponent(cookies['oai-gn']) : '';
    let plan = '';

    if (cookies['oai-client-auth-info']) {
      try {
        const decoded = decodeURIComponent(cookies['oai-client-auth-info']);
        const authInfo = JSON.parse(decoded);
        email = authInfo?.user?.email || '';
        name = name || authInfo?.user?.name || '';
      } catch (e) {
        console.log('[openai] Failed to parse oai-client-auth-info:', e.message);
      }
    }

    if (!email && cookies['_puid']) {
      email = cookies['_puid'].split(':')[0]; // user-xxx:timestamp-hash
    }

    return { email, name, plan };
  },

  parseAccountInfo(data) {
    // Not used — we use parseAccountFromCookies
    return null;
  },

  async getAccountInfo(ses) {
    // Try to get access token from /api/auth/session, then hit /backend-api/me
    try {
      const authSession = await makeRequest(`${BASE}/api/auth/session`, ses);
      const email = authSession?.user?.email || '';
      const name = authSession?.user?.name || '';
      const plan = authSession?.account?.planType || '';
      const planLabel = plan === 'pro' ? 'Pro'
        : plan === 'plus' ? 'Plus'
        : plan === 'team' ? 'Team'
        : plan || 'Free';

      return { email, name, plan: planLabel };
    } catch (e) {
      console.error('[openai] getAccountInfo error:', e.message);
      return null;
    }
  },

  // Get access token needed for /backend-api/* calls
  async getAccessToken(ses) {
    try {
      const authSession = await makeRequest(`${BASE}/api/auth/session`, ses);
      return authSession?.accessToken || null;
    } catch {
      return null;
    }
  },

  async fetchConversations(ses, timestamps, onProgress) {
    const token = await provider.getAccessToken(ses);
    if (!token) {
      throw new Error('AUTH_EXPIRED');
    }

    let allConvs = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const page = await makeRequest(
        `${BASE}/backend-api/conversations?offset=${offset}&limit=${limit}`,
        ses,
        { 'Authorization': `Bearer ${token}` }
      );
      const items = page?.items || [];
      allConvs = allConvs.concat(items);
      if (items.length < limit) break;
      offset += limit;
    }

    const toFetch = allConvs.filter((c) => {
      const last = timestamps[c.id];
      return !last || last !== c.update_time;
    });

    console.log(`[openai] ${toFetch.length}/${allConvs.length} to fetch`);
    const updated = [];

    for (let i = 0; i < toFetch.length; i++) {
      const conv = toFetch[i];
      onProgress?.(i + 1, toFetch.length);
      await new Promise((r) => setTimeout(r, 500));
      try {
        const full = await makeRequest(
          `${BASE}/backend-api/conversation/${conv.id}`,
          ses,
          { 'Authorization': `Bearer ${token}` }
        );
        updated.push(full);
        timestamps[conv.id] = conv.update_time;
      } catch (e) {
        console.error(`[openai] Failed ${conv.id}: ${e.message}`);
      }
    }
    return updated;
  },

  convertToMarkdown(conversation) {
    const title = conversation.title || 'Untitled';
    const created = conversation.create_time ? new Date(conversation.create_time * 1000).toISOString() : '';
    const updated = conversation.update_time ? new Date(conversation.update_time * 1000).toISOString() : '';
    const model = conversation.default_model_slug || '';
    const id = conversation.conversation_id || conversation.id || '';

    const frontmatter = [
      '---',
      `title: "${title.replace(/"/g, '\\"')}"`,
      `created: ${created}`,
      `updated: ${updated}`,
      model ? `model: ${model}` : null,
      'source: chatgpt',
      `conversation_id: "${id}"`,
      '---',
    ].filter(Boolean).join('\n');

    const messages = flattenMessages(conversation.mapping || {});
    const body = messages
      .map((msg) => {
        const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : null;
        if (!role) return null;
        return `## ${role}\n\n${msg.text}`;
      })
      .filter(Boolean)
      .join('\n\n');

    return `${frontmatter}\n\n${body}\n`;
  },

  makeFilename(conversation) {
    const created = conversation.create_time
      ? new Date(conversation.create_time * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const title = sanitize(conversation.title || 'untitled');
    return `${created}_${title}.md`;
  },
};

function flattenMessages(mapping) {
  const nodes = Object.values(mapping);
  let current = nodes.find((n) => !n.parent);
  if (!current) return [];

  const messages = [];
  const visited = new Set();
  const queue = [current];

  while (queue.length > 0) {
    const node = queue.shift();
    if (visited.has(node.id)) continue;
    visited.add(node.id);

    if (node.message?.content?.parts) {
      const text = node.message.content.parts
        .filter((p) => typeof p === 'string')
        .join('\n\n');
      if (text.trim()) {
        messages.push({
          role: node.message.author?.role || 'unknown',
          text,
        });
      }
    }

    const children = (node.children || [])
      .map((id) => mapping[id])
      .filter(Boolean);
    queue.push(...children);
  }

  return messages;
}

function sanitize(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80);
}

module.exports = provider;
