const { net } = require('electron');

const provider = {
  name: 'gemini',
  displayName: 'Gemini',
  baseUrl: 'https://gemini.google.com',
  loginUrl: 'https://gemini.google.com/app',
  subdir: 'gemini',
  cookieName: '__Secure-1PSID',

  request(path) {
    return new Promise((resolve, reject) => {
      const url = path.startsWith('http') ? path : `${provider.baseUrl}${path}`;
      const req = net.request({
        url,
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
          // Gemini often returns )]}' prefix before JSON
          const cleaned = body.replace(/^\)]\}'\n?/, '');
          try { resolve(JSON.parse(cleaned)); }
          catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  },

  async getAccountInfo() {
    // Gemini doesn't have a clean user API - we get info from the page
    // For now, return basic info from cookies/session
    try {
      // Try to get user info from the app page data
      const req = net.request({
        url: `${provider.baseUrl}/app`,
        useSessionCookies: true,
      });

      return new Promise((resolve) => {
        let body = '';
        req.on('response', (response) => {
          if (response.statusCode !== 200) {
            resolve(null);
            return;
          }
          response.on('data', (chunk) => { body += chunk.toString(); });
          response.on('end', () => {
            // Try to extract email from page HTML
            const emailMatch = body.match(/\"([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\"/);
            resolve({
              email: emailMatch ? emailMatch[1] : '',
              name: '',
              plan: 'Free', // Hard to detect programmatically
            });
          });
        });
        req.on('error', () => resolve(null));
        req.end();
      });
    } catch {
      return null;
    }
  },

  async fetchConversations(timestamps, onProgress) {
    // Gemini's internal API is complex and uses protobuf-like encoding
    // The most reliable approach is scraping the conversation list from the web app
    // For now: use the known endpoint pattern
    console.log('[gemini] Fetching conversations...');

    try {
      // Gemini uses a batch execute RPC endpoint
      // GET conversations list
      const listUrl = `${provider.baseUrl}/app/conversations`;
      const req = net.request({ url: listUrl, useSessionCookies: true });

      const html = await new Promise((resolve, reject) => {
        let body = '';
        req.on('response', (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          response.on('data', (chunk) => { body += chunk.toString(); });
          response.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.end();
      });

      // Extract conversation data from page - Gemini embeds JSON in script tags
      const dataMatches = html.match(/data:\s*(\[[\s\S]*?\])\s*,\s*sideChannel/g);
      if (!dataMatches) {
        console.log('[gemini] Could not parse conversation list from page');
        return [];
      }

      // For now, return empty until we can reverse-engineer the exact format
      console.log('[gemini] Conversation parsing not yet fully implemented');
      return [];
    } catch (e) {
      console.error(`[gemini] Fetch error: ${e.message}`);
      return [];
    }
  },

  convertToMarkdown(conversation) {
    const title = conversation.title || 'Untitled';
    const created = conversation.created || '';
    const updated = conversation.updated || '';
    const id = conversation.id || '';

    const frontmatter = [
      '---',
      `title: "${title.replace(/"/g, '\\"')}"`,
      `created: ${created}`,
      `updated: ${updated}`,
      'source: gemini',
      `conversation_id: "${id}"`,
      '---',
    ].filter(Boolean).join('\n');

    const messages = (conversation.messages || [])
      .map((msg) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        return `## ${role}\n\n${msg.text || ''}`;
      })
      .join('\n\n');

    return `${frontmatter}\n\n${messages}\n`;
  },

  makeFilename(conversation) {
    const date = (conversation.created || new Date().toISOString()).slice(0, 10);
    const title = sanitize(conversation.title || 'untitled');
    return `${date}_${title}.md`;
  },
};

function sanitize(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80);
}

module.exports = provider;
