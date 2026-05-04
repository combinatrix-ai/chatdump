const { makeRawPostRequest, makeRawRequest } = require('./request');
const { withRetry } = require('./retry');

const BASE = 'https://gemini.google.com';
const BATCH_EXEC = `${BASE}/_/BardChatUi/data/batchexecute`;

const provider = {
  name: 'gemini',
  displayName: 'Gemini',
  iconAsset: 'assets/providers/gemini.png',
  baseUrl: BASE,
  loginUrl: `${BASE}/app`,
  subdir: 'gemini',
  cookieName: '__Secure-1PSID',
  parserVersion: 1,

  getId(conversation) {
    return conversation?.id || '';
  },

  getRawCache(conversation) {
    return conversation;
  },

  parseFromCache(raw) {
    if (raw && typeof raw._rawMsgResp === 'string') {
      return {
        id: raw.id,
        title: raw.title,
        timestamp: raw.timestamp,
        messages: parseConversationMessages(raw._rawMsgResp),
        _rawMsgResp: raw._rawMsgResp,
      };
    }
    return raw;
  },

  // Extract account info from cookies
  parseAccountFromCookies(_cookies) {
    // No reliable email in cookies for Gemini — will be filled from page HTML
    return { email: '', name: '', plan: '' };
  },

  parseAccountInfo() {
    return null;
  },

  async getAccountInfo(ses) {
    // Fetch the app page and extract email from HTML
    try {
      const html = await makeRawRequest(`${BASE}/app`, ses);
      const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      const email =
        emails.find((e) => !e.includes('google.com') && !e.includes('googlers')) || emails[0] || '';
      // Check for Pro/Advanced subscription
      const isPro = html.includes('"PRO"') || html.includes('"gemini_advanced"');
      return { email, name: '', plan: isPro ? 'Pro' : 'Free' };
    } catch (e) {
      console.error('[gemini] getAccountInfo error:', e.message);
      return null;
    }
  },

  async fetchConversations(ses, timestamps, onProgress, onConversation, options = {}) {
    // Step 1: Get tokens from the app page
    const tokens = await getPageTokens(ses);
    if (!tokens.at) {
      throw new Error('AUTH_EXPIRED');
    }

    // Step 2: Fetch conversation list via MaZiqc RPC
    const listPayload = JSON.stringify([13, null, [0, null, 1]]);
    const listResp = await batchExecute(ses, tokens, 'MaZiqc', listPayload);
    const conversations = parseConversationList(listResp);

    console.log(`[gemini] Found ${conversations.length} conversations`);

    // Also fetch pinned conversations
    try {
      const pinnedPayload = JSON.stringify([13, null, [1, null, 1]]);
      const pinnedResp = await batchExecute(ses, tokens, 'MaZiqc', pinnedPayload);
      const pinned = parseConversationList(pinnedResp);
      // Merge, avoiding duplicates
      const existingIds = new Set(conversations.map((c) => c.id));
      for (const p of pinned) {
        if (!existingIds.has(p.id)) {
          conversations.push(p);
        }
      }
    } catch {
      /* ignore */
    }

    // Step 3: Filter to updated conversations
    const toFetch = conversations.filter((c) => {
      const last = timestamps[c.id];
      return !last || last !== c.timestamp;
    });

    console.log(`[gemini] ${toFetch.length}/${conversations.length} to fetch`);

    // Step 4: Fetch each conversation's messages
    for (let i = 0; i < toFetch.length; i++) {
      if (options.signal?.aborted) {
        console.log(`[gemini] sync aborted at ${i}/${toFetch.length}`);
        break;
      }
      const conv = toFetch[i];
      onProgress?.(i + 1, toFetch.length);
      await new Promise((r) => setTimeout(r, 500));
      try {
        const msgPayload = JSON.stringify([conv.id, 50, null, 1, [1], [4], null, 1]);
        const msgResp = await batchExecute(ses, tokens, 'hNvQHb', msgPayload);
        const messages = parseConversationMessages(msgResp);
        const full = {
          id: conv.id,
          title: conv.title,
          timestamp: conv.timestamp,
          messages,
          _rawMsgResp: msgResp,
        };
        onConversation?.(full);
        timestamps[conv.id] = conv.timestamp;
      } catch (e) {
        console.error(`[gemini] Failed ${conv.id}: ${e.message}`);
      }
    }
    return [];
  },

  convertToMarkdown(conversation) {
    const title = conversation.title || 'Untitled';
    const ts = conversation.timestamp;
    const created = ts ? new Date(ts).toISOString() : '';
    const id = conversation.id || '';

    const frontmatter = [
      '---',
      `title: "${title.replace(/"/g, '\\"')}"`,
      `created: ${created}`,
      'source: gemini',
      `id: "${id}"`,
      `parser_version: ${provider.parserVersion}`,
      '---',
    ]
      .filter(Boolean)
      .join('\n');

    const body = (conversation.messages || [])
      .map((msg) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        return `## ${role}\n\n${msg.text}`;
      })
      .filter(Boolean)
      .join('\n\n');

    return `${frontmatter}\n\n${body}\n`;
  },

  makeFilename(conversation) {
    const ts = conversation.timestamp;
    const date = ts
      ? new Date(ts).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const title = sanitize(conversation.title || 'untitled');
    const idSuffix = (conversation.id || '').replace('c_', '').slice(0, 8);
    return `${date}_${title}_${idSuffix}.md`;
  },
};

// --- Helpers ---

async function getPageTokens(ses) {
  try {
    const html = await makeRawRequest(`${BASE}/app`, ses);
    const at = (html.match(/"SNlM0e":"([^"]+)"/) || [])[1] || '';
    const bl = (html.match(/"cfb2h":"([^"]+)"/) || [])[1] || '';
    const sid = (html.match(/"FdrFJe":"([^"]+)"/) || [])[1] || '';
    return { at, bl, sid };
  } catch (e) {
    console.error('[gemini] Failed to get page tokens:', e.message);
    return { at: '', bl: '', sid: '' };
  }
}

async function batchExecute(ses, tokens, rpcId, payload) {
  // Build form body
  const formBody = new URLSearchParams();
  formBody.set('f.req', JSON.stringify([[[rpcId, payload, null, 'generic']]]));
  formBody.set('at', tokens.at);

  // Build query string
  const qs = new URLSearchParams({
    rpcids: rpcId,
    'source-path': '/app',
    bl: tokens.bl,
    'f.sid': tokens.sid,
    hl: 'en',
    _reqid: String(Math.floor(Math.random() * 1000000)),
    rt: 'c',
  });

  const url = `${BATCH_EXEC}?${qs.toString()}`;

  return withRetry(
    () =>
      makeRawPostRequest(
        url,
        ses,
        formBody.toString(),
        {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          Origin: BASE,
          Referer: `${BASE}/`,
          'X-Same-Domain': '1',
        },
        [BASE, 'https://google.com'],
      ),
    {
      maxAttempts: 3,
      getDelayMs: (attempt) => [2000, 5000, 10000][attempt - 1] || 10000,
      onRetry: (e, attempt, maxAttempts, delayMs) => {
        console.log(
          `[gemini] HTTP ${e.statusCode} on ${rpcId}, retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxAttempts})`,
        );
      },
    },
  );
}

function parseConversationList(raw) {
  // Response starts with )]}' followed by newlines — strip XSSI prefix
  const xssiIdx = raw.indexOf('\n');
  const cleaned = xssiIdx >= 0 ? raw.slice(xssiIdx) : raw;
  const conversations = [];

  try {
    const frames = parseFrames(cleaned);
    for (const frame of frames) {
      if (!Array.isArray(frame)) continue;
      if (frame[0] !== 'wrb.fr' || frame[1] !== 'MaZiqc') continue;

      const dataStr = frame[2];
      if (typeof dataStr !== 'string') continue;

      const data = JSON.parse(dataStr);
      // data = [null, "encryptedToken", [[conv1], [conv2], ...]]
      // Find the first nested array that contains conversation arrays
      let items = [];
      for (const entry of data) {
        if (Array.isArray(entry) && entry.length > 0 && Array.isArray(entry[0])) {
          items = entry;
          break;
        }
      }
      for (const conv of items) {
        if (!Array.isArray(conv)) continue;
        const id = conv[0];
        const title = conv[1] || '';
        const ts = conv[5] ? conv[5][0] * 1000 : null;
        if (id) {
          conversations.push({ id, title, timestamp: ts });
        }
      }
    }
  } catch (e) {
    console.error('[gemini] Failed to parse conversation list:', e.message);
  }

  return conversations;
}

function parseConversationMessages(raw) {
  const cleaned = raw.replace(/^\)\]\}'\s*/, '');
  const messages = [];

  try {
    const frames = parseFrames(cleaned);
    for (const frame of frames) {
      if (!Array.isArray(frame) || frame[0] !== 'wrb.fr' || frame[1] !== 'hNvQHb') continue;
      const data = JSON.parse(frame[2]);
      const turns = data[0] || [];

      for (const turn of turns) {
        // User message at [2][0][0]
        try {
          const userText = turn?.[2]?.[0]?.[0];
          if (userText) {
            messages.push({ role: 'user', text: userText });
          }
        } catch {
          /* skip */
        }

        // Model response — try multiple paths since structure varies
        try {
          const responsePart = turn?.[3];
          if (responsePart && responsePart.length > 0) {
            const firstCandidate = responsePart[0];
            // Path 1: [3][0][0][1][0] — candidate rcid + text array
            let text = '';
            if (Array.isArray(firstCandidate?.[0])) {
              // firstCandidate[0] = ["rc_xxx", ["text content"], ...]
              const textArr = firstCandidate[0]?.[1];
              if (Array.isArray(textArr)) {
                text = textArr.filter((t) => typeof t === 'string').join('\n\n');
              } else if (typeof textArr === 'string') {
                text = textArr;
              }
            }
            // Path 2: [3][0][1][0] — direct text
            if (!text && firstCandidate?.[1]?.[0]) {
              text = typeof firstCandidate[1][0] === 'string' ? firstCandidate[1][0] : '';
            }
            if (text) {
              messages.push({ role: 'model', text });
            }
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch (e) {
    console.error('[gemini] Failed to parse messages:', e.message);
  }

  return messages;
}

function parseFrames(text) {
  const frames = [];

  // Find all top-level JSON arrays by looking for [[ patterns
  // This is more robust than length-prefix parsing which has encoding issues
  let pos = 0;
  while (pos < text.length) {
    const arrStart = text.indexOf('[[', pos);
    if (arrStart === -1) break;

    // Try to parse a JSON array starting here
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = arrStart;

    for (let i = arrStart; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '[') depth++;
      if (ch === ']') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (depth === 0 && end > arrStart) {
      const jsonStr = text.slice(arrStart, end);
      try {
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (Array.isArray(item)) {
              frames.push(item);
            }
          }
        }
      } catch {
        /* skip */
      }
      pos = end;
    } else {
      pos = arrStart + 2;
    }
  }

  return frames;
}

function sanitize(name) {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

module.exports = provider;
