const { makeRequest } = require('./request');
const { withRetry } = require('./retry');

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
  parserVersion: 2,

  getId(conversation) {
    return conversation?.conversation_id || conversation?.id || '';
  },

  getRawCache(conversation) {
    return conversation;
  },

  parseFromCache(raw) {
    return raw;
  },

  // Extract account info from cookies (primary method)
  parseAccountFromCookies(cookies) {
    let email = '';
    let name = cookies['oai-gn'] ? decodeURIComponent(cookies['oai-gn']) : '';
    const plan = '';

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

    if (!email && cookies._puid) {
      email = cookies._puid.split(':')[0]; // user-xxx:timestamp-hash
    }

    return { email, name, plan };
  },

  parseAccountInfo(_data) {
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
      const planLabel =
        plan === 'pro'
          ? 'Pro'
          : plan === 'plus'
            ? 'Plus'
            : plan === 'team'
              ? 'Team'
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

  async fetchConversations(ses, timestamps, onProgress, onConversation, options = {}) {
    const mode = options.mode || 'sync';
    let token = await provider.getAccessToken(ses);
    if (!token) {
      throw new Error('AUTH_EXPIRED');
    }

    let allConvs = [];
    let offset = 0;
    const limit = 100;

    // Note: ChatGPT's /backend-api/conversations `total` is not the real total —
    // it returns offset+items.length+1 while more pages exist, only becoming the real
    // count on the final page. Don't display it as a denominator.
    while (true) {
      await new Promise((r) => setTimeout(r, 1000));
      const page = await makeRequest(
        `${BASE}/backend-api/conversations?offset=${offset}&limit=${limit}`,
        ses,
        { Authorization: `Bearer ${token}` },
      );
      const items = page?.items || [];
      allConvs = allConvs.concat(items);
      onProgress?.(-1, null, `Listing ${allConvs.length}…`);
      console.log(`[openai] Listed ${allConvs.length} conversations`);
      if (items.length < limit) break;
      offset += limit;
    }

    let toFetch;
    if (mode === 'fix-order:created_at' || mode === 'fix-order:last_message_at') {
      // Touch every conversation in ascending order so the LAST one accessed becomes
      // the most-recently-updated on chatgpt.com. After this run, list order on
      // chatgpt.com matches the chosen criterion (newest at top).
      const sortKey = mode === 'fix-order:created_at' ? 'created_at' : 'last_message_at';
      toFetch = [...allConvs].sort(
        (a, b) => sortKeyMs(a, sortKey, timestamps) - sortKeyMs(b, sortKey, timestamps),
      );
      console.log(
        `[openai] fix-order mode: touching all ${toFetch.length} conversations by ${sortKey} ascending`,
      );
    } else {
      toFetch = allConvs.filter((c) => {
        const last = timestamps[c.id]?.update_time;
        const current = normalizeTimestamp(c.update_time);
        return !last || last !== current;
      });
      console.log(`[openai] ${toFetch.length}/${allConvs.length} to fetch`);
    }
    let fetchedCount = 0;

    // ChatGPT (via Cloudflare) does not return Retry-After on 429, so we can't react
    // smartly — only stay below the threshold. 10s base + ±20% jitter avoids the
    // synchronized-burst pattern that Cloudflare's bot management seems to flag.
    let delay = 10000;
    const minDelay = 8000;
    const maxDelay = 30000;
    const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));
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
        } catch {
          /* keep old token */
        }
      }

      await new Promise((r) => setTimeout(r, jitter(delay)));

      let success = false;
      try {
        const full = await withRetry(
          () =>
            makeRequest(`${BASE}/backend-api/conversation/${conv.id}`, ses, {
              Authorization: `Bearer ${token}`,
            }),
          {
            maxAttempts: 5,
            getDelayMs: (attempt) => Math.min(120000, 5000 * 2 ** (attempt - 1)),
            onRetry: (e, attempt, maxAttempts, backoff) => {
              consecutiveFails++;
              console.log(
                `[openai] HTTP ${e.statusCode} on ${i + 1}/${toFetch.length}, backoff ${backoff / 1000}s (attempt ${attempt}/${maxAttempts})`,
              );
              delay = Math.min(maxDelay, delay + 3000);
            },
          },
        );
        onConversation?.(full);
        const pathMessages = getCurrentPathMessages(full.mapping || {}, full.current_node);
        timestamps[conv.id] = {
          update_time: normalizeTimestamp(full.update_time) || normalizeTimestamp(conv.update_time),
          create_time: normalizeTimestamp(full.create_time) || normalizeTimestamp(conv.create_time),
          last_message_at: getLatestMessageCreateTime(pathMessages) || null,
        };
        fetchedCount++;
        success = true;
        consecutiveFails = 0;
        delay = Math.max(minDelay, delay * 0.95); // Slowly ease back
      } catch (e) {
        console.error(`[openai] Failed ${conv.id}: ${e.message}`);
      }

      // Log progress periodically
      if (success && fetchedCount % 50 === 0) {
        console.log(
          `[openai] Progress: ${fetchedCount} fetched, ${i + 1}/${toFetch.length} processed, delay=${delay / 1000}s`,
        );
      }

      // If too many consecutive retryable failures, pause longer
      if (consecutiveFails >= 10) {
        console.log(
          `[openai] ${consecutiveFails} consecutive retryable failures, pausing 5 minutes...`,
        );
        await new Promise((r) => setTimeout(r, 300000));
        consecutiveFails = 0;
        delay = 10000;
        // Refresh token after long pause
        try {
          const newToken = await provider.getAccessToken(ses);
          if (newToken) token = newToken;
        } catch {
          /* keep old */
        }
      }
    }
    return []; // Conversations already written via onConversation callback
  },

  convertToMarkdown(conversation) {
    const title = conversation.title || 'Untitled';
    const created = timestampToIso(conversation.create_time);
    const pathMessages = getCurrentPathMessages(
      conversation.mapping || {},
      conversation.current_node,
    );
    const updated = getLatestMessageCreateTime(pathMessages);
    const model = conversation.default_model_slug || '';
    const id = conversation.conversation_id || conversation.id || '';

    const frontmatter = [
      '---',
      `title: "${title.replace(/"/g, '\\"')}"`,
      `created: ${created}`,
      `updated: ${updated}`,
      model ? `model: ${model}` : null,
      'source: chatgpt',
      `id: "${id}"`,
      `parser_version: ${provider.parserVersion}`,
      '---',
    ]
      .filter(Boolean)
      .join('\n');

    const messages = flattenMessages(pathMessages);
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
    const created =
      timestampToIso(conversation.create_time).slice(0, 10) ||
      new Date().toISOString().slice(0, 10);
    const title = sanitize(conversation.title || 'untitled');
    const idSuffix = (conversation.conversation_id || conversation.id || '').slice(0, 8);
    return `${created}_${title}_${idSuffix}.md`;
  },
};

function getCurrentPathMessages(mapping, currentNodeId) {
  const start = currentNodeId ? mapping[currentNodeId] : null;
  if (start) {
    const path = [];
    const visited = new Set();
    let node = start;

    while (node && !visited.has(node.id)) {
      visited.add(node.id);
      if (node.message) path.push(node.message);
      node = mapping[node.parent];
    }

    return path.reverse();
  }

  const messages = [];
  const visited = new Set();
  const queue = Object.values(mapping).filter((n) => !n.parent);

  while (queue.length > 0) {
    const node = queue.shift();
    if (visited.has(node.id)) continue;
    visited.add(node.id);

    if (node.message?.content?.parts) {
      messages.push(node.message);
    }

    const children = (node.children || []).map((id) => mapping[id]).filter(Boolean);
    queue.push(...children);
  }

  return messages;
}

function sortKeyMs(conv, key, timestamps) {
  const stored = timestamps[conv.id];
  if (key === 'created_at') {
    return timestampToEpochMs(conv.create_time) ?? timestampToEpochMs(stored?.create_time) ?? 0;
  }
  // last_message_at — falls back to list update_time when not yet stored locally
  return timestampToEpochMs(stored?.last_message_at) ?? timestampToEpochMs(conv.update_time) ?? 0;
}

function getLatestMessageCreateTime(messages) {
  const latest = messages
    .map((message) => timestampToEpochMs(message.create_time))
    .filter((createTime) => typeof createTime === 'number')
    .reduce((max, createTime) => Math.max(max, createTime), 0);

  return latest ? new Date(latest).toISOString() : '';
}

function normalizeTimestamp(value) {
  const iso = timestampToIso(value);
  return iso || null;
}

function timestampToIso(value) {
  const ms = timestampToEpochMs(value);
  return typeof ms === 'number' ? new Date(ms).toISOString() : '';
}

function timestampToEpochMs(value) {
  if (typeof value === 'number') return Math.floor(value * 1000);
  if (typeof value !== 'string' || !value) return null;

  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function flattenMessages(messages) {
  return messages
    .filter((message) => message?.content?.parts)
    .map((message) => {
      const text = message.content.parts.filter((p) => typeof p === 'string').join('\n\n');
      if (!text.trim()) return null;
      return {
        role: message.author?.role || 'unknown',
        text,
      };
    })
    .filter(Boolean);
}

function sanitize(name) {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

module.exports = provider;
