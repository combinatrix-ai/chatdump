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

  async fetchConversations(ses, timestamps, onProgress, onConversation) {
    let token = await provider.getAccessToken(ses);
    if (!token) {
      throw new Error('AUTH_EXPIRED');
    }

    let allConvs = [];
    let offset = 0;
    const limit = 100;
    let total = '?';

    while (true) {
      await new Promise((r) => setTimeout(r, 1000));
      const page = await makeRequest(
        `${BASE}/backend-api/conversations?offset=${offset}&limit=${limit}`,
        ses,
        { 'Authorization': `Bearer ${token}` }
      );
      const items = page?.items || [];
      if (page?.total != null) total = page.total;
      allConvs = allConvs.concat(items);
      onProgress?.(-1, total, `Listing ${allConvs.length}/${total}`);
      console.log(`[openai] Listed ${allConvs.length}/${total} conversations`);
      if (items.length < limit) break;
      offset += limit;
    }

    const toFetch = allConvs.filter((c) => {
      const last = timestamps[c.id];
      return !last || last !== c.update_time;
    });

    console.log(`[openai] ${toFetch.length}/${allConvs.length} to fetch`);
    const updated = [];

    let delay = 5000; // 5s between requests — ChatGPT rate limits aggressively
    let consecutiveFails = 0;

    for (let i = 0; i < toFetch.length; i++) {
      const conv = toFetch[i];
      onProgress?.(i + 1, toFetch.length);

      // If token might be expired (>5min), refresh it
      if (i > 0 && i % 100 === 0) {
        try {
          const newToken = await provider.getAccessToken(ses);
          if (newToken) token = newToken;
          console.log(`[openai] Refreshed access token at item ${i}`);
        } catch { /* keep old token */ }
      }

      await new Promise((r) => setTimeout(r, delay));

      let success = false;
      for (let retries = 0; retries < 5; retries++) {
        try {
          const full = await makeRequest(
            `${BASE}/backend-api/conversation/${conv.id}`,
            ses,
            { 'Authorization': `Bearer ${token}` }
          );
          onConversation?.(full);
          timestamps[conv.id] = conv.update_time;
          success = true;
          consecutiveFails = 0;
          delay = Math.max(3000, delay * 0.95); // Slowly ease back
          break;
        } catch (e) {
          if (e.message.includes('429')) {
            consecutiveFails++;
            const backoff = Math.min(120000, 5000 * Math.pow(2, retries)); // 10s, 20s, 40s, 80s, 120s
            console.log(`[openai] 429 on ${i+1}/${toFetch.length}, backoff ${backoff/1000}s (attempt ${retries+1}/5)`);
            delay = Math.min(15000, delay + 2000); // Progressively slow down
            await new Promise((r) => setTimeout(r, backoff));
          } else {
            console.error(`[openai] Failed ${conv.id}: ${e.message}`);
            break;
          }
        }
      }

      // Log progress periodically
      if (success && updated.length % 50 === 0) {
        console.log(`[openai] Progress: ${updated.length} fetched, ${i+1}/${toFetch.length} processed, delay=${delay/1000}s`);
      }

      // If too many consecutive fails, pause longer
      if (consecutiveFails >= 10) {
        console.log(`[openai] ${consecutiveFails} consecutive 429s, pausing 5 minutes...`);
        await new Promise((r) => setTimeout(r, 300000));
        consecutiveFails = 0;
        delay = 5000;
        // Refresh token after long pause
        try {
          const newToken = await provider.getAccessToken(ses);
          if (newToken) token = newToken;
        } catch { /* keep old */ }
      }
    }
    return []; // Conversations already written via onConversation callback
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
