const { makeBinaryRequest, makeRequest } = require('./request');
const { withRetry } = require('./retry');

const BASE = 'https://chatgpt.com';

const provider = {
  name: 'openai',
  displayName: 'ChatGPT',
  iconAsset: 'assets/providers/openai.png',
  baseUrl: BASE,
  loginUrl: `${BASE}/auth/login`,
  subdir: 'chatgpt',
  cookieName: '__Secure-next-auth.session-token',
  cookiePrefix: true,
  meEndpoint: null, // We use cookies + /api/auth/session instead
  parserVersion: 3,

  getId(conversation) {
    return conversation?.conversation_id || conversation?.id || '';
  },

  getRawCache(conversation) {
    return conversation;
  },

  parseFromCache(raw) {
    return raw;
  },

  extractDocument(conversation) {
    const pathMessages = getCurrentPathMessages(
      conversation.mapping || {},
      conversation.current_node,
    );
    return extractDocument(pathMessages);
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
  async getAccessToken(ses, options = {}) {
    try {
      const authSession = await makeRequest(`${BASE}/api/auth/session`, ses, undefined, {
        signal: options.signal,
      });
      return authSession?.accessToken || null;
    } catch (e) {
      if (options.signal?.aborted || e.message === 'Request aborted') throw e;
      return null;
    }
  },

  async fetchConversationById(ses, conversationId, options = {}) {
    const token = await provider.getAccessToken(ses, { signal: options.signal });
    if (!token) {
      throw new Error('AUTH_EXPIRED');
    }

    return makeRequest(
      `${BASE}/backend-api/conversation/${encodeURIComponent(conversationId)}`,
      ses,
      {
        Authorization: `Bearer ${token}`,
      },
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs || 60000,
      },
    );
  },

  // Fetch a *shared* conversation by its share id (from https://chatgpt.com/share/<id>).
  // Unlike /backend-api/conversation/{id}, the share endpoint is public: it returns the
  // shared snapshot to any authenticated session, even one that does not own the chat.
  async fetchSharedConversationById(ses, shareId, options = {}) {
    // A valid session is still needed to clear Cloudflare, but ownership is not required,
    // so a missing access token is non-fatal here — send it when we have it.
    const token = await provider.getAccessToken(ses, { signal: options.signal });
    const raw = await makeRequest(
      `${BASE}/backend-api/share/${encodeURIComponent(shareId)}`,
      ses,
      token ? { Authorization: `Bearer ${token}` } : undefined,
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs || 60000,
      },
    );
    return normalizeSharePayload(raw, shareId);
  },

  async downloadAsset(ses, asset, options = {}) {
    const assetId = parseAssetPointer(asset.pointer);
    const token = await provider.getAccessToken(ses, { signal: options.signal });
    if (!token) throw new Error('AUTH_EXPIRED');
    const headers = { Authorization: `Bearer ${token}` };
    const requestOptions = {
      signal: options.signal,
      timeoutMs: options.timeoutMs || 60000,
      maxBytes: options.maxBytes || 50 * 1024 * 1024,
      allowedHosts: ['chatgpt.com'],
      allowedHostSuffixes: ['oaiusercontent.com'],
    };
    const fileUrl = `${BASE}/backend-api/files/${encodeURIComponent(assetId)}/download`;

    let resolverReturnedJson = false;
    let resolved = null;
    try {
      resolved = await makeRequest(fileUrl, ses, headers, {
        signal: options.signal,
        timeoutMs: requestOptions.timeoutMs,
        redactSecrets: true,
      });
      resolverReturnedJson = true;
    } catch (e) {
      if (e.message === 'AUTH_EXPIRED' || e.message === 'Request aborted') throw e;
    }
    const downloadUrl = resolved?.download_url || resolved?.url;
    if (downloadUrl) {
      const validatedUrl = validateAssetDownloadUrl(downloadUrl);
      const downloadHost = new URL(validatedUrl).hostname;
      return makeBinaryRequest(
        validatedUrl,
        ses,
        downloadHost === 'chatgpt.com' ? headers : {},
        requestOptions,
      );
    }

    if (!resolverReturnedJson) {
      try {
        return await makeBinaryRequest(fileUrl, ses, headers, requestOptions);
      } catch (e) {
        if (e.message === 'AUTH_EXPIRED' || e.message === 'Request aborted') throw e;
        if (e.statusCode && ![404, 405].includes(e.statusCode)) throw e;
      }
    }

    return makeBinaryRequest(
      `${BASE}/backend-api/estuary/content?id=${encodeURIComponent(assetId)}`,
      ses,
      headers,
      requestOptions,
    );
  },

  async fetchConversations(ses, timestamps, onProgress, onConversation, options = {}) {
    const mode = options.mode || 'sync';
    let token = await provider.getAccessToken(ses, { signal: options.signal });
    if (!token) {
      throw new Error('AUTH_EXPIRED');
    }

    let allConvs = [];
    let offset = 0;
    const limit = 100;
    const isFirstRun = Object.keys(timestamps).length === 0;
    const sinceDays = isFirstRun ? null : (options.sinceDays ?? 30);
    const cutoffMs = sinceDays != null ? Date.now() - sinceDays * 86400000 : 0;
    const listingCutoffMs = mode === 'sync' && options.sinceDays != null ? cutoffMs : 0;
    const listingCutoffIso = listingCutoffMs ? new Date(listingCutoffMs).toISOString() : '';
    let listedPages = 0;

    // Note: ChatGPT's /backend-api/conversations `total` is not the real total —
    // it returns offset+items.length+1 while more pages exist, only becoming the real
    // count on the final page. Don't display it as a denominator.
    while (true) {
      if (options.signal?.aborted) return [];
      await new Promise((r) => setTimeout(r, 1000));
      const page = await withRetry(
        () =>
          makeRequest(
            `${BASE}/backend-api/conversations?offset=${offset}&limit=${limit}`,
            ses,
            {
              Authorization: `Bearer ${token}`,
            },
            {
              signal: options.signal,
            },
          ),
        {
          maxAttempts: 5,
          getDelayMs: (attempt) => Math.min(120000, 5000 * 2 ** (attempt - 1)),
          onRetry: (e, attempt, maxAttempts, backoff) => {
            console.log(
              `[openai] HTTP ${e.statusCode} listing offset=${offset}, backoff ${backoff / 1000}s (attempt ${attempt}/${maxAttempts})`,
            );
          },
        },
      );
      const items = page?.items || [];
      listedPages++;
      allConvs = allConvs.concat(items);
      onProgress?.(-1, null, `Listing ${allConvs.length}…`);
      console.log(`[openai] Listed ${allConvs.length} conversations`);

      if (
        listingCutoffMs &&
        items.length > 0 &&
        items.every((item) => {
          const updateMs = timestampToEpochMs(item.update_time);
          return typeof updateMs === 'number' && updateMs < listingCutoffMs;
        })
      ) {
        console.log(
          `[openai] sync listing stopped early after ${listedPages} pages (${allConvs.length} conversations); all page update_time values are older than ${listingCutoffIso}, skipping remaining pages from offset ${offset + limit}`,
        );
        break;
      }

      if (items.length < limit) break;
      offset += limit;
    }

    let toFetch;
    if (mode === 'full-sync:created_at' || mode === 'full-sync:last_message_at') {
      // Touch every conversation in ascending order so the LAST one accessed becomes
      // the most-recently-updated on chatgpt.com. After this run, list order on
      // chatgpt.com matches the chosen criterion (newest at top).
      const sortKey = mode === 'full-sync:created_at' ? 'created_at' : 'last_message_at';
      toFetch = [...allConvs].sort(
        (a, b) => sortKeyMs(a, sortKey, timestamps) - sortKeyMs(b, sortKey, timestamps),
      );
      console.log(
        `[openai] full-sync mode: touching all ${toFetch.length} conversations by ${sortKey} ascending`,
      );
    } else {
      // Sync mode: window-bounded diff fetch. On the very first run (no stored
      // timestamps) we ignore the window and let the user kick off a full sync
      // explicitly via the menu.
      // Reverse the API-returned order (update_time DESC) so we read oldest-touched
      // first. Each read bumps update_time on the server, so walking oldest→newest
      // means the final touched conversation ends up topmost — chatgpt.com sidebar
      // settles back to update_time DESC after sync finishes.
      const filtered = allConvs.filter((c) => {
        if (cutoffMs && (timestampToEpochMs(c.create_time) || 0) < cutoffMs) return false;
        const last = timestamps[c.id]?.update_time;
        const current = normalizeTimestamp(c.update_time);
        return !last || last !== current;
      });
      toFetch = filtered.reverse();
      const windowLabel = sinceDays != null ? `last ${sinceDays}d` : 'all time';
      console.log(
        `[openai] sync mode (${windowLabel}): ${toFetch.length}/${allConvs.length} to fetch`,
      );
    }
    let fetchedCount = 0;

    // ChatGPT (via Cloudflare) does not return Retry-After on 429, so we can't react
    // smartly — only stay below the threshold. 10s base + ±20% jitter avoids the
    // synchronized-burst pattern that Cloudflare's bot management seems to flag.
    let delay = 10000;
    const minDelay = 8000;
    const maxDelay = 30000;
    const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));
    const sleep = (ms) =>
      new Promise((resolve) => {
        if (options.signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        options.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    let consecutiveFails = 0;

    for (let i = 0; i < toFetch.length; i++) {
      if (options.signal?.aborted) {
        console.log(`[openai] sync aborted at ${i}/${toFetch.length}`);
        break;
      }
      const conv = toFetch[i];
      onProgress?.(i + 1, toFetch.length);

      // If token might be expired (>5min), refresh it
      if (i > 0 && i % 100 === 0) {
        try {
          const newToken = await provider.getAccessToken(ses, { signal: options.signal });
          if (newToken) token = newToken;
          console.log(`[openai] Refreshed access token at item ${i}`);
        } catch {
          /* keep old token */
        }
      }

      await sleep(jitter(delay));
      if (options.signal?.aborted) break;

      let success = false;
      try {
        const full = await withRetry(
          () =>
            makeRequest(
              `${BASE}/backend-api/conversation/${conv.id}`,
              ses,
              {
                Authorization: `Bearer ${token}`,
              },
              {
                signal: options.signal,
              },
            ),
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
        await onConversation?.(full);
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
        await sleep(300000);
        if (options.signal?.aborted) break;
        consecutiveFails = 0;
        delay = 10000;
        // Refresh token after long pause
        try {
          const newToken = await provider.getAccessToken(ses, { signal: options.signal });
          if (newToken) token = newToken;
        } catch {
          /* keep old */
        }
      }
    }
    return []; // Conversations already written via onConversation callback
  },

  async askWithBrowser(ses, options = {}) {
    const { askChatGptInBrowser } = require('./openai-ask');
    return askChatGptInBrowser(ses, options);
  },

  convertToMarkdown(conversation, options = {}) {
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
      `title: ${JSON.stringify(title)}`,
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

    const document = extractDocument(pathMessages);
    const assetPaths = options.assetPaths || {};
    const body = renderTurns(document.turns, assetPaths);

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

// The /backend-api/share/{id} payload is shaped like a conversation but with a few
// gaps: conversation_id may be absent, and older/edge responses expose the thread as a
// flat `linear_conversation` array instead of a `mapping`. Normalize both into the
// mapping+current_node shape that convertToMarkdown expects.
function normalizeSharePayload(data, shareId) {
  if (!data || typeof data !== 'object') {
    throw new Error('Empty share response');
  }
  const conv =
    data.conversation && typeof data.conversation === 'object' ? data.conversation : data;

  let mapping = conv.mapping;
  let currentNode = conv.current_node;

  if ((!mapping || Object.keys(mapping).length === 0) && Array.isArray(conv.linear_conversation)) {
    mapping = {};
    let prevId = null;
    for (const node of conv.linear_conversation) {
      const id = node?.id || node?.message?.id;
      if (!id) continue;
      mapping[id] = { id, message: node.message || null, parent: prevId, children: [] };
      if (prevId && mapping[prevId]) mapping[prevId].children.push(id);
      prevId = id;
    }
    currentNode = prevId;
  }

  return {
    ...conv,
    mapping: mapping || {},
    current_node: currentNode,
    conversation_id: conv.conversation_id || conv.id || shareId,
    title: conv.title || data.title || 'Shared conversation',
    create_time: conv.create_time ?? data.create_time,
  };
}

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
  return extractDocument(messages)
    .turns.map((turn) => {
      const text = turn.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n\n');
      return text.trim() ? { role: turn.role, text } : null;
    })
    .filter(Boolean);
}

function assetFromPart(part) {
  if (!part || typeof part !== 'object' || part.content_type !== 'image_asset_pointer') {
    return null;
  }
  const pointer = String(part.asset_pointer || '');
  const match = pointer.match(/^sediment:\/\/(file_[A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const mimeType = String(part.mime_type || '').toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) return null;
  return {
    id: match[1],
    pointer,
    mimeType,
    sizeBytes: Number.isSafeInteger(part.size_bytes) && part.size_bytes > 0 ? part.size_bytes : 0,
    width: Number.isSafeInteger(part.width) && part.width > 0 ? part.width : null,
    height: Number.isSafeInteger(part.height) && part.height > 0 ? part.height : null,
  };
}

function parseAssetPointer(pointer) {
  const match = String(pointer || '').match(/^sediment:\/\/(file_[A-Za-z0-9_-]+)$/);
  if (!match) throw new Error('Invalid ChatGPT image asset pointer');
  return match[1];
}

function validateAssetDownloadUrl(value) {
  const url = new URL(value);
  const allowed =
    url.hostname === 'chatgpt.com' ||
    url.hostname === 'oaiusercontent.com' ||
    url.hostname.endsWith('.oaiusercontent.com');
  if (url.protocol !== 'https:' || !allowed) {
    throw new Error(`Untrusted ChatGPT image URL host: ${url.hostname}`);
  }
  return url.toString();
}

function messageParts(message, options = {}) {
  const contentType = message?.content?.content_type;
  const visibleContent =
    !contentType || contentType === 'text' || contentType === 'multimodal_text';
  if (!visibleContent) return { parts: [], assets: [] };
  const generated = options.generated === true;
  const includeText = options.includeText !== false;
  const alt = generated
    ? String(message?.metadata?.image_gen_title || 'Generated image')
    : String(message?.metadata?.image_title || 'Uploaded image');
  const parts = [];
  const assets = [];
  for (const value of message?.content?.parts || []) {
    if (includeText && typeof value === 'string' && value.trim()) {
      parts.push({ type: 'text', text: value });
      continue;
    }
    const asset = assetFromPart(value);
    if (!asset) continue;
    assets.push(asset);
    parts.push({ type: 'image', assetId: asset.id, alt, generated });
  }
  return { parts, assets };
}

function appendUniqueImage(turn, imagePart) {
  if (turn.parts.some((part) => part.type === 'image' && part.assetId === imagePart.assetId))
    return;
  turn.parts.push(imagePart);
}

function extractDocument(messages) {
  const turns = [];
  const assets = new Map();

  for (const message of messages) {
    const role = message?.author?.role;
    if (role === 'user' || role === 'assistant') {
      const extracted = messageParts(message);
      if (extracted.parts.length === 0) continue;

      let turn = null;
      const previous = turns.at(-1);
      if (role === 'assistant' && previous?.role === 'assistant' && previous.synthetic) {
        turn = previous;
        turn.synthetic = false;
      } else {
        turn = { role, parts: [], synthetic: false };
        turns.push(turn);
      }
      for (const part of extracted.parts) {
        if (part.type === 'image') appendUniqueImage(turn, part);
        else turn.parts.push(part);
      }
      for (const asset of extracted.assets) assets.set(asset.id, asset);
      continue;
    }

    if (role === 'tool') {
      const extracted = messageParts(message, { generated: true, includeText: false });
      if (extracted.parts.length === 0) continue;
      let turn = turns.at(-1);
      if (!turn || turn.role !== 'assistant') {
        turn = { role: 'assistant', parts: [], synthetic: true };
        turns.push(turn);
      }
      for (const part of extracted.parts) appendUniqueImage(turn, part);
      for (const asset of extracted.assets) assets.set(asset.id, asset);
    }
  }

  return {
    turns: turns.map(({ role, parts }) => ({ role, parts })),
    assets: [...assets.values()],
  };
}

function escapeMarkdownAlt(value) {
  return String(value || 'Image')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function renderTurns(turns, assetPaths = {}) {
  return turns
    .map((turn) => {
      const role = turn.role === 'user' ? 'User' : turn.role === 'assistant' ? 'Assistant' : null;
      if (!role) return null;
      const content = turn.parts
        .map((part) => {
          if (part.type === 'text') return part.text;
          if (part.type !== 'image') return null;
          const localPath = assetPaths[part.assetId];
          if (localPath) return `![${escapeMarkdownAlt(part.alt)}](${localPath})`;
          const label = part.generated ? 'Generated image' : 'Image';
          return `[${label}: ${part.alt}]`;
        })
        .filter(Boolean)
        .join('\n\n');
      return content ? `## ${role}\n\n${content}` : null;
    })
    .filter(Boolean)
    .join('\n\n');
}

function sanitize(name) {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

provider._test = {
  getCurrentPathMessages,
  getLatestMessageCreateTime,
  timestampToEpochMs,
  timestampToIso,
  flattenMessages,
  extractDocument,
  renderTurns,
  assetFromPart,
  parseAssetPointer,
  validateAssetDownloadUrl,
  sanitize,
  normalizeSharePayload,
};

module.exports = provider;
