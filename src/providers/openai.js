const { net } = require('electron');

const provider = {
  name: 'openai',
  displayName: 'ChatGPT',
  baseUrl: 'https://chatgpt.com',
  loginUrl: 'https://chatgpt.com/auth/login',
  subdir: 'chatgpt',
  cookieName: '__Secure-next-auth.session-token',

  request(path) {
    return new Promise((resolve, reject) => {
      const req = net.request({
        url: `${provider.baseUrl}/backend-api${path}`,
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
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  },

  async getAccountInfo() {
    try {
      const me = await provider.request('/me');
      return {
        email: me?.email || '',
        name: me?.name || '',
        plan: me?.entitlement?.subscription_plan === 'chatgptplusplan' ? 'Plus'
          : me?.entitlement?.subscription_plan === 'chatgptteamplan' ? 'Team'
          : 'Free',
      };
    } catch {
      return null;
    }
  },

  async fetchConversations(timestamps, onProgress) {
    // ChatGPT paginates with offset/limit
    let allConvs = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const page = await provider.request(`/conversations?offset=${offset}&limit=${limit}`);
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
        const full = await provider.request(`/conversation/${conv.id}`);
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
  // Find root node (no parent)
  const nodes = Object.values(mapping);
  let current = nodes.find((n) => !n.parent);
  if (!current) return [];

  const messages = [];
  const visited = new Set();

  // Walk the tree depth-first following first child
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

    // Add children to queue
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
