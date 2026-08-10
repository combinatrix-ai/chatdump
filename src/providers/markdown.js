// Shared shape of an archived conversation: the YAML frontmatter block every
// provider writes, and the `<date>_<title>_<id>.md` filename the writer dedupes
// on (see writer.js). Providers keep their own semantics -- which timestamps
// exist, the source label, how an id is derived -- and pass them in.
const { sanitizeFilenameTitle } = require('../path-utils');

// `updated` is emitted only when the caller passes the key at all: Claude and
// ChatGPT always write the line (blank when unknown), Gemini's list API has no
// update time and omits it. `model` is dropped whenever it is empty.
function conversationMarkdown(fields, body) {
  const lines = [
    '---',
    `title: ${JSON.stringify(fields.title || 'Untitled')}`,
    `created: ${fields.created || ''}`,
  ];
  if (Object.hasOwn(fields, 'updated')) lines.push(`updated: ${fields.updated || ''}`);
  if (fields.model) lines.push(`model: ${fields.model}`);
  lines.push(
    `source: ${fields.source}`,
    `id: "${fields.id || ''}"`,
    `parser_version: ${fields.parserVersion}`,
    '---',
  );

  return `${lines.join('\n')}\n\n${body}\n`;
}

// `date` is any ISO-ish timestamp; today is used when the conversation carries
// none. `id` is already provider-normalized and gets cut to the 8-character
// suffix the archive uses.
function conversationFilename({ date, title, id }) {
  const day = String(date || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  return `${day}_${sanitizeFilenameTitle(title)}_${String(id || '').slice(0, 8)}.md`;
}

module.exports = { conversationFilename, conversationMarkdown };
