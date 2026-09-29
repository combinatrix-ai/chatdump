const { isRequestAbortedError, makeRequest, shouldRethrowProviderError } = require('./request');
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

    // A login can belong to several organizations (e.g. a personal plan and a Team
    // workspace). Export every one that has chat, not just the first.
    const chatOrgs = chatOrganizations(orgs);

    // Project names: conversations carry only project_uuid, so list each organization's
    // projects once per sync. Best effort: a failure here never stops the conversation export.
    if (options.onProjects) {
      const projects = [];
      let listedAll = true;
      for (const org of chatOrgs) {
        try {
          const list = await makeRequest(
            `${BASE}/api/organizations/${org.uuid}/projects`,
            ses,
            undefined,
            { signal: options.signal },
          );
          if (Array.isArray(list)) {
            for (const p of list) {
              if (p?.uuid) projects.push({ uuid: p.uuid, name: p.name || '', orgId: org.uuid });
            }
          }
        } catch (e) {
          if (shouldRethrowProviderError(e, options.signal)) throw e;
          listedAll = false;
          console.error(`[claude] Project list failed for org ${org.uuid}: ${e.message}`);
        }
      }
      // A partial list would drop names an earlier sync saved, so write only a complete one.
      if (listedAll) await options.onProjects(projects);
    }

    const failed = [];
    const toFetch = [];
    let listed = 0;
    for (let o = 0; o < chatOrgs.length; o++) {
      const org = chatOrgs[o];
      let conversations;
      try {
        conversations = await makeRequest(
          `${BASE}/api/organizations/${org.uuid}/chat_conversations`,
          ses,
          undefined,
          { signal: options.signal },
        );
      } catch (e) {
        // The first organization keeps the old behavior (auth errors stop the sync).
        // A later one that refuses listing must not cost the others.
        if (o === 0 || options.signal?.aborted || isRequestAbortedError(e)) throw e;
        failed.push({ id: `org:${org.uuid}`, error: e.message });
        console.error(`[claude] Failed to list org ${org.uuid}: ${e.message}`);
        continue;
      }
      listed += conversations.length;
      for (const c of conversations) {
        const last = timestamps[c.uuid];
        if (!last || last !== c.updated_at) toFetch.push({ conv: c, org });
      }
    }

    console.log(`[claude] ${toFetch.length}/${listed} to fetch across ${chatOrgs.length} org(s)`);

    for (let i = 0; i < toFetch.length; i++) {
      if (options.signal?.aborted) {
        console.log(`[claude] sync aborted at ${i}/${toFetch.length}`);
        break;
      }
      const { conv, org } = toFetch[i];
      onProgress?.(i + 1, toFetch.length);
      await sleep(500, options.signal);
      try {
        const full = await makeRequest(
          `${BASE}/api/organizations/${org.uuid}/chat_conversations/${conv.uuid}`,
          ses,
          undefined,
          { signal: options.signal },
        );
        await onConversation?.(withOrg(full, org));
        timestamps[conv.uuid] = conv.updated_at;
      } catch (e) {
        if (shouldRethrowProviderError(e, options.signal)) throw e;
        failed.push({ id: conv.uuid, error: e.message });
        console.error(`[claude] Failed ${conv.uuid}: ${e.message}`);
      }
    }
    // Every chat organization this sync enumerated, so `chatdump list --json` can
    // say which organizations the archive covers.
    return { failed, orgs: chatOrgs.map((o) => ({ uuid: o.uuid, name: o.name || '' })) };
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
        orgUuid: conversation.org_uuid,
        orgName: conversation.org_name,
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

// Organizations whose capabilities say they have no chat (API-only orgs) are
// skipped; an org without a capabilities list is kept.
function chatOrganizations(orgs) {
  const withChat = orgs.filter(
    (o) => o?.uuid && (!Array.isArray(o.capabilities) || o.capabilities.includes('chat')),
  );
  return withChat.length ? withChat : orgs.slice(0, 1);
}

// The conversation payload carries no organization; record which one it came
// from so the Markdown frontmatter and the raw cache say so.
function withOrg(conversation, org) {
  if (!conversation || typeof conversation !== 'object') return conversation;
  return { ...conversation, org_uuid: org.uuid, org_name: org.name || '' };
}

provider._test = { extractText, chatOrganizations, withOrg };

module.exports = provider;
