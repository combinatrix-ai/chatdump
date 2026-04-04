const { net } = require('electron');
const { makeRawRequest } = require('./request');

const BASE = 'https://gemini.google.com';

const provider = {
  name: 'gemini',
  displayName: 'Gemini',
  baseUrl: BASE,
  loginUrl: `${BASE}/app`,
  subdir: 'gemini',
  cookieName: '__Secure-1PSID',

  async getAccountInfo(ses) {
    try {
      const html = await makeRawRequest(`${BASE}/app`, ses);
      const emailMatch = html.match(/"([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/);
      return {
        email: emailMatch ? emailMatch[1] : '',
        name: '',
        plan: 'Free',
      };
    } catch {
      return null;
    }
  },

  async fetchConversations(ses, timestamps, onProgress) {
    // Gemini's internal API uses protobuf-like RPC, not yet reverse-engineered
    console.log('[gemini] Conversation fetch not yet fully implemented');
    return [];
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
