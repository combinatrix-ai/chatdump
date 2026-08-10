const { makeRequest, shouldRethrowProviderError } = require('./request');
const { conversationFilename, conversationMarkdown } = require('./markdown');
const { sleep } = require('../sleep');

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
    if (!orgs || orgs.length === 0) return { failed: [] };
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
    const failed = [];

    for (let i = 0; i < toFetch.length; i++) {
      if (options.signal?.aborted) {
        console.log(`[claude] sync aborted at ${i}/${toFetch.length}`);
        break;
      }
      const conv = toFetch[i];
      onProgress?.(i + 1, toFetch.length);
      await sleep(500, options.signal);
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
        if (shouldRethrowProviderError(e, options.signal)) throw e;
        failed.push({ id: conv.uuid, error: e.message });
        console.error(`[claude] Failed ${conv.uuid}: ${e.message}`);
      }
    }
    return { failed };
  },

  convertToMarkdown(conversation) {
    const messages = (conversation.chat_messages || [])
      .map((msg) => {
        const role = msg.sender === 'human' ? 'Human' : 'Assistant';
        const text = extractText(msg.content || msg.text);
        return `## ${role}\n\n${text}`;
      })
      .join('\n\n');

    return conversationMarkdown(
      {
        title: conversation.name,
        created: conversation.created_at,
        updated: conversation.updated_at,
        model: conversation.model,
        source: 'claude',
        id: conversation.uuid,
        parserVersion: provider.parserVersion,
      },
      messages,
    );
  },

  makeFilename(conversation) {
    return conversationFilename({
      date: conversation.created_at,
      title: conversation.name,
      id: conversation.uuid,
    });
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

provider._test = { extractText };

module.exports = provider;
