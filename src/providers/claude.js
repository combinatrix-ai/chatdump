const { makeRequest } = require('./request');

const BASE = 'https://claude.ai';

const provider = {
  name: 'claude',
  displayName: 'Claude',
  iconAsset: 'assets/providers/claude.png',
  baseUrl: BASE,
  loginUrl: `${BASE}/login`,
  subdir: 'claude',
  cookieName: 'sessionKey',
  meEndpoint: `${BASE}/api/bootstrap`,
  parserVersion: 1,

  getId(conversation) {
    return conversation?.uuid || '';
  },

  getRawCache(conversation) {
    return conversation;
  },

  parseFromCache(raw) {
    return raw;
  },

  parseAccountInfo(bootstrap) {
    const email = bootstrap?.account?.email_address || '';
    const name = bootstrap?.account?.display_name || bootstrap?.account?.full_name || '';
    const orgs = bootstrap?.account?.memberships?.map((m) => m.organization) || [];
    const org = orgs[0] || {};
    const plan = org.capabilities?.includes('claude_max')
      ? 'Max'
      : org.capabilities?.includes('claude_pro')
        ? 'Pro'
        : 'Free';
    return { email, name, plan, orgId: org.uuid };
  },

  async getAccountInfo(ses) {
    const orgs = await makeRequest(`${BASE}/api/organizations`, ses);
    if (!orgs || orgs.length === 0) return null;
    const org = orgs[0];

    let email = '',
      name = '';
    try {
      const bootstrap = await makeRequest(`${BASE}/api/bootstrap`, ses);
      email = bootstrap?.account?.email_address || '';
      name = bootstrap?.account?.display_name || bootstrap?.account?.full_name || '';
    } catch {
      /* ignore */
    }

    const plan = org.capabilities?.includes('claude_max')
      ? 'Max'
      : org.capabilities?.includes('claude_pro')
        ? 'Pro'
        : 'Free';

    return { email, name, plan, orgId: org.uuid };
  },

  async fetchConversations(ses, timestamps, onProgress, onConversation, options = {}) {
    const orgs = await makeRequest(`${BASE}/api/organizations`, ses, undefined, {
      signal: options.signal,
    });
    if (!orgs || orgs.length === 0) return [];
    const orgId = orgs[0].uuid;

    const conversations = await makeRequest(
      `${BASE}/api/organizations/${orgId}/chat_conversations`,
      ses,
      undefined,
      { signal: options.signal },
    );
    const toFetch = conversations.filter((c) => {
      const last = timestamps[c.uuid];
      return !last || last !== c.updated_at;
    });

    console.log(`[claude] ${toFetch.length}/${conversations.length} to fetch`);

    for (let i = 0; i < toFetch.length; i++) {
      if (options.signal?.aborted) {
        console.log(`[claude] sync aborted at ${i}/${toFetch.length}`);
        break;
      }
      const conv = toFetch[i];
      onProgress?.(i + 1, toFetch.length);
      await new Promise((r) => setTimeout(r, 500));
      try {
        const full = await makeRequest(
          `${BASE}/api/organizations/${orgId}/chat_conversations/${conv.uuid}`,
          ses,
          undefined,
          { signal: options.signal },
        );
        await onConversation?.(full);
        timestamps[conv.uuid] = conv.updated_at;
      } catch (e) {
        console.error(`[claude] Failed ${conv.uuid}: ${e.message}`);
      }
    }
    return [];
  },

  convertToMarkdown(conversation) {
    const title = conversation.name || 'Untitled';
    const created = conversation.created_at || '';
    const updated = conversation.updated_at || '';
    const model = conversation.model || '';
    const id = conversation.uuid || '';

    const frontmatter = [
      '---',
      `title: ${JSON.stringify(title)}`,
      `created: ${created}`,
      `updated: ${updated}`,
      model ? `model: ${model}` : null,
      'source: claude',
      `id: "${id}"`,
      `parser_version: ${provider.parserVersion}`,
      '---',
    ]
      .filter(Boolean)
      .join('\n');

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
    const idSuffix = (conversation.uuid || '').slice(0, 8);
    return `${date}_${title}_${idSuffix}.md`;
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
        if (b.type === 'code')
          return `\`\`\`${b.language || ''}\n${b.content || b.text || ''}\n\`\`\``;
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
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

provider._test = { extractText };

module.exports = provider;
