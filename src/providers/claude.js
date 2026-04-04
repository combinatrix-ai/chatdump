const { net } = require('electron');

const provider = {
  name: 'claude',
  displayName: 'Claude',
  baseUrl: 'https://claude.ai',
  loginUrl: 'https://claude.ai/login',
  subdir: 'claude',
  cookieName: 'sessionKey',

  request(path) {
    return new Promise((resolve, reject) => {
      const req = net.request({
        url: `${provider.baseUrl}/api${path}`,
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
    const orgs = await provider.request('/organizations');
    if (!orgs || orgs.length === 0) return null;
    const org = orgs[0];

    let email = '', name = '';
    try {
      const bootstrap = await provider.request('/bootstrap');
      email = bootstrap?.account?.email_address || '';
      name = bootstrap?.account?.display_name || bootstrap?.account?.full_name || '';
    } catch { /* ignore */ }

    const plan = org.capabilities?.includes('claude_max') ? 'Max'
      : org.capabilities?.includes('claude_pro') ? 'Pro'
      : 'Free';

    return { email, name, plan, orgId: org.uuid };
  },

  async fetchConversations(timestamps, onProgress) {
    const orgs = await provider.request('/organizations');
    if (!orgs || orgs.length === 0) return [];
    const orgId = orgs[0].uuid;

    const conversations = await provider.request(`/organizations/${orgId}/chat_conversations`);
    const toFetch = conversations.filter((c) => {
      const last = timestamps[c.uuid];
      return !last || last !== c.updated_at;
    });

    console.log(`[claude] ${toFetch.length}/${conversations.length} to fetch`);
    const updated = [];

    for (let i = 0; i < toFetch.length; i++) {
      const conv = toFetch[i];
      onProgress?.(i + 1, toFetch.length);
      await new Promise((r) => setTimeout(r, 500));
      try {
        const full = await provider.request(`/organizations/${orgId}/chat_conversations/${conv.uuid}`);
        updated.push(full);
        timestamps[conv.uuid] = conv.updated_at;
      } catch (e) {
        console.error(`[claude] Failed ${conv.uuid}: ${e.message}`);
      }
    }
    return updated;
  },

  convertToMarkdown(conversation) {
    const title = conversation.name || 'Untitled';
    const created = conversation.created_at || '';
    const updated = conversation.updated_at || '';
    const model = conversation.model || '';
    const id = conversation.uuid || '';

    const frontmatter = [
      '---',
      `title: "${title.replace(/"/g, '\\"')}"`,
      `created: ${created}`,
      `updated: ${updated}`,
      model ? `model: ${model}` : null,
      'source: claude',
      `conversation_id: "${id}"`,
      '---',
    ].filter(Boolean).join('\n');

    const messages = (conversation.chat_messages || [])
      .map((msg) => {
        const role = msg.sender === 'human' ? 'Human' : 'Assistant';
        const text = extractText(msg.content || msg.text);
        return `## ${role}\n\n${text}`;
      })
      .join('\n\n');

    return `${frontmatter}\n\n${messages}\n`;
  },

  makeFilename(conversation) {
    const date = (conversation.created_at || new Date().toISOString()).slice(0, 10);
    const title = sanitize(conversation.name || 'untitled');
    return `${date}_${title}.md`;
  },
};

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b.type === 'text') return b.text || '';
        if (b.type === 'code') return `\`\`\`${b.language || ''}\n${b.content || b.text || ''}\n\`\`\``;
        if (b.type === 'tool_use') return `*[Tool: ${b.name}]*`;
        if (b.type === 'tool_result') return b.content ? extractText(b.content) : '';
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return JSON.stringify(content);
}

function sanitize(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80);
}

module.exports = provider;
