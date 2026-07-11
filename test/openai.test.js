const assert = require('node:assert/strict');
const test = require('node:test');
const { _test } = require('../src/providers/openai');

const {
  flattenMessages,
  extractDocument,
  getCurrentPathMessages,
  getLatestMessageCreateTime,
  normalizeSharePayload,
  parseAssetPointer,
  renderTurns,
  sanitize,
  timestampToEpochMs,
  timestampToIso,
  validateAssetDownloadUrl,
} = _test;

test('normalizeSharePayload keeps a mapping-shaped share payload', () => {
  const raw = {
    title: 'Shared chat',
    create_time: 1700000000,
    current_node: 'b',
    mapping: { a: { id: 'a' }, b: { id: 'b', parent: 'a' } },
  };
  const result = normalizeSharePayload(raw, 'share-123');
  assert.equal(result.title, 'Shared chat');
  assert.equal(result.current_node, 'b');
  assert.equal(result.conversation_id, 'share-123');
  assert.deepEqual(Object.keys(result.mapping), ['a', 'b']);
});

test('normalizeSharePayload builds a mapping from linear_conversation', () => {
  const raw = {
    title: 'Linear share',
    linear_conversation: [
      { id: 'n1', message: { id: 'n1', author: { role: 'user' } } },
      { id: 'n2', message: { id: 'n2', author: { role: 'assistant' } } },
    ],
  };
  const result = normalizeSharePayload(raw, 'share-xyz');
  assert.equal(result.current_node, 'n2');
  assert.equal(result.mapping.n1.parent, null);
  assert.equal(result.mapping.n1.children[0], 'n2');
  assert.equal(result.mapping.n2.parent, 'n1');
});

function message(id, role, text, createTime) {
  return {
    id,
    author: { role },
    content: { parts: [text] },
    create_time: createTime,
  };
}

test('getCurrentPathMessages walks current node parent chain in order', () => {
  const mapping = {
    root: {
      id: 'root',
      parent: null,
      children: ['a'],
      message: message('root-message', 'system', 'root'),
    },
    a: {
      id: 'a',
      parent: 'root',
      children: ['b'],
      message: message('a-message', 'user', 'hello'),
    },
    b: {
      id: 'b',
      parent: 'a',
      children: [],
      message: message('b-message', 'assistant', 'hi'),
    },
  };

  assert.deepEqual(
    getCurrentPathMessages(mapping, 'b').map((item) => item.id),
    ['root-message', 'a-message', 'b-message'],
  );
});

test('getCurrentPathMessages falls back to BFS over roots when current node is missing', () => {
  const mapping = {
    root: {
      id: 'root',
      parent: null,
      children: ['a'],
      message: message('root-message', 'system', 'root'),
    },
    a: {
      id: 'a',
      parent: 'root',
      children: ['b'],
      message: message('a-message', 'user', 'hello'),
    },
    b: {
      id: 'b',
      parent: 'a',
      children: [],
      message: message('b-message', 'assistant', 'hi'),
    },
  };

  assert.deepEqual(
    getCurrentPathMessages(mapping, 'missing').map((item) => item.id),
    ['root-message', 'a-message', 'b-message'],
  );
});

test('getCurrentPathMessages stops on cycles in parent links', () => {
  const mapping = {
    a: {
      id: 'a',
      parent: 'b',
      children: ['b'],
      message: message('a-message', 'user', 'a'),
    },
    b: {
      id: 'b',
      parent: 'a',
      children: ['a'],
      message: message('b-message', 'assistant', 'b'),
    },
  };

  assert.deepEqual(
    getCurrentPathMessages(mapping, 'b').map((item) => item.id),
    ['a-message', 'b-message'],
  );
});

test('timestamp helpers normalize supported values', () => {
  assert.equal(timestampToEpochMs(1710000000.9), 1710000000900);
  assert.equal(timestampToIso(1710000000), '2024-03-09T16:00:00.000Z');
  assert.equal(timestampToEpochMs('2025-01-02T03:04:05.000Z'), 1735787045000);
  assert.equal(timestampToIso('2025-01-02T03:04:05.000Z'), '2025-01-02T03:04:05.000Z');
  assert.equal(timestampToEpochMs('not a date'), null);
  assert.equal(timestampToIso('not a date'), '');
});

test('getLatestMessageCreateTime picks the latest valid create_time', () => {
  assert.equal(
    getLatestMessageCreateTime([
      { create_time: 1700000000 },
      { create_time: '2025-01-02T03:04:05.000Z' },
      { create_time: 'invalid' },
    ]),
    '2025-01-02T03:04:05.000Z',
  );
  assert.equal(getLatestMessageCreateTime([{ create_time: null }]), '');
});

test('flattenMessages joins string parts and skips non-string or empty content', () => {
  assert.deepEqual(
    flattenMessages([
      {
        author: { role: 'user' },
        content: { parts: ['first', { ignored: true }, 'second'] },
      },
      {
        author: { role: 'assistant' },
        content: { parts: ['   '] },
      },
      {
        author: { role: 'assistant' },
        content: { parts: ['answer'] },
      },
    ]),
    [
      { role: 'user', text: 'first\n\nsecond' },
      { role: 'assistant', text: 'answer' },
    ],
  );
});

test('extractDocument keeps uploaded images in user part order', () => {
  const result = extractDocument([
    {
      author: { role: 'user' },
      content: {
        content_type: 'multimodal_text',
        parts: [
          {
            content_type: 'image_asset_pointer',
            asset_pointer: 'sediment://file_upload123',
            mime_type: 'image/jpeg',
            size_bytes: 12,
            width: 10,
            height: 20,
          },
          'describe this',
        ],
      },
    },
  ]);

  assert.deepEqual(result.turns, [
    {
      role: 'user',
      parts: [
        {
          type: 'image',
          assetId: 'file_upload123',
          alt: 'Uploaded image',
          generated: false,
        },
        { type: 'text', text: 'describe this' },
      ],
    },
  ]);
  assert.deepEqual(result.assets, [
    {
      id: 'file_upload123',
      pointer: 'sediment://file_upload123',
      mimeType: 'image/jpeg',
      sizeBytes: 12,
      width: 10,
      height: 20,
    },
  ]);
});

test('extractDocument creates one assistant turn for duplicate generated tool images', () => {
  const image = {
    content_type: 'image_asset_pointer',
    asset_pointer: 'sediment://file_generated123',
    mime_type: 'image/png',
    size_bytes: 10,
    width: 1254,
    height: 1254,
  };
  const result = extractDocument([
    { author: { role: 'user' }, content: { content_type: 'text', parts: ['make a dog'] } },
    {
      author: { role: 'tool' },
      content: { content_type: 'multimodal_text', parts: [image] },
      metadata: { image_gen_title: 'Happy dog' },
    },
    { author: { role: 'system' }, content: { content_type: 'text', parts: ['internal'] } },
    {
      author: { role: 'tool' },
      content: { content_type: 'multimodal_text', parts: [image, 'Model caption: private'] },
      metadata: { image_gen_title: 'Happy dog' },
    },
    { author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] } },
  ]);

  assert.deepEqual(result.turns, [
    { role: 'user', parts: [{ type: 'text', text: 'make a dog' }] },
    {
      role: 'assistant',
      parts: [
        {
          type: 'image',
          assetId: 'file_generated123',
          alt: 'Happy dog',
          generated: true,
        },
      ],
    },
  ]);
  assert.equal(result.assets.length, 1);
});

test('renderTurns uses local image paths and readable unresolved markers', () => {
  const turns = [
    {
      role: 'assistant',
      parts: [
        { type: 'image', assetId: 'file_a', alt: 'Dog [portrait]', generated: true },
        { type: 'image', assetId: 'file_b', alt: 'Reference', generated: false },
      ],
    },
  ];
  assert.equal(
    renderTurns(turns, { file_a: 'assets/conversation/file_a.png' }),
    '## Assistant\n\n![Dog \\[portrait\\]](assets/conversation/file_a.png)\n\n[Image: Reference]',
  );
});

test('asset pointer and download URL validation reject unsafe values', () => {
  assert.equal(parseAssetPointer('sediment://file_abc-123'), 'file_abc-123');
  assert.throws(() => parseAssetPointer('https://evil.example/file'), /Invalid/);
  assert.equal(
    validateAssetDownloadUrl('https://files.oaiusercontent.com/signed/path'),
    'https://files.oaiusercontent.com/signed/path',
  );
  assert.throws(
    () => validateAssetDownloadUrl('https://oaiusercontent.com.evil.example/path'),
    /Untrusted/,
  );
});

test('sanitize replaces unsafe characters and whitespace, then truncates to 80 chars', () => {
  assert.equal(sanitize('a/b\\c:d*e?f"g<h>i|j two\tspaces'), 'a_b_c_d_e_f_g_h_i_j_two_spaces');
  assert.equal(sanitize('x'.repeat(100)), 'x'.repeat(80));
});
