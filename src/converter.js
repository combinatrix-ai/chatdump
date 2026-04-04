function extractTextFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block.type === 'text') return block.text || '';
        if (block.type === 'code') return `\`\`\`${block.language || ''}\n${block.content || block.text || ''}\n\`\`\``;
        if (block.type === 'tool_use') return `*[Tool: ${block.name}]*`;
        if (block.type === 'tool_result') return block.content ? extractTextFromContent(block.content) : '';
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return JSON.stringify(content);
}

function conversationToMarkdown(conversation) {
  const title = conversation.name || conversation.title || 'Untitled';
  const created = conversation.created_at || '';
  const updated = conversation.updated_at || '';
  const model = conversation.model || '';
  const id = conversation.uuid || conversation.id || '';

  const frontmatter = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `created: ${created}`,
    `updated: ${updated}`,
    model ? `model: ${model}` : null,
    `source: claude.ai`,
    `conversation_id: "${id}"`,
    '---',
  ].filter(Boolean).join('\n');

  const messages = (conversation.chat_messages || [])
    .map((msg) => {
      const role = msg.sender === 'human' ? 'Human' : 'Assistant';
      const text = extractTextFromContent(msg.content || msg.text);
      return `## ${role}\n\n${text}`;
    })
    .join('\n\n');

  return `${frontmatter}\n\n${messages}\n`;
}

function sanitizeFilename(name) {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function makeFilename(conversation) {
  const date = (conversation.created_at || new Date().toISOString()).slice(0, 10);
  const title = sanitizeFilename(conversation.name || conversation.title || 'untitled');
  return `${date}_${title}.md`;
}

module.exports = { conversationToMarkdown, makeFilename };
