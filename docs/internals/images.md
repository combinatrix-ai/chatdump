# Image Archiving Design

## Goal

Archive images referenced by a conversation alongside its Markdown so the
archive remains useful offline. The first implementation targets ChatGPT user
uploads and generated images. The storage and rendering contracts are
provider-neutral so Claude and Gemini can add extractors later.

This is archival support, not just remote-image embedding: expiring provider
URLs must never be written to Markdown.

## Observed ChatGPT Shape

The reference conversation `6a51cc31-45a4-83ee-80a5-3ea777eff9b7` contains a
generated PNG with this shape on the current conversation path:

```json
{
  "author": { "role": "tool" },
  "content": {
    "content_type": "multimodal_text",
    "parts": [
      {
        "content_type": "image_asset_pointer",
        "asset_pointer": "sediment://file_...",
        "mime_type": "image/png",
        "size_bytes": 2175004,
        "width": 1254,
        "height": 1254
      }
    ]
  },
  "metadata": {
    "image_gen_title": "..."
  }
}
```

The same asset pointer occurs more than once in the path. The final assistant
text is empty, while the browser displays the tool-produced image as the
assistant response. User uploads can instead occur directly in a user's
multimodal content. Consequences:

- media extraction must inspect structured parts on every path message;
- asset identity is the provider asset id, not the message id;
- generated tool media belongs to the assistant turn;
- an otherwise empty turn is retained when it contains media;
- model captions, tool output paths, and reasoning are not archived as visible
  chat text.

## Output Layout

Store assets under a stable, conversation-id-based directory beneath the
account directory:

```text
Vault/chatgpt/account/
├── 2026-07-11_New_chat_6a51cc31.md
└── assets/
    └── 6a51cc31-45a4-83ee-80a5-3ea777eff9b7/
        └── file_000000001bb8720bbfbe8e70c86df68d.png
```

The Markdown uses a relative path:

```markdown
## Assistant

![Spring park portrait of a golden retriever](assets/6a51cc31-45a4-83ee-80a5-3ea777eff9b7/file_000000001bb8720bbfbe8e70c86df68d.png)
```

Conversation titles and Markdown filenames can change, so assets must not be
stored in a directory derived from the title. Use only sanitized provider and
conversation asset ids for paths. Never use a provider-supplied filename or
URL path directly.

## Normalized Model

Split provider parsing from file materialization. A provider returns a pure
normalized document:

```js
{
  turns: [
    {
      role: 'user' | 'assistant',
      parts: [
        { type: 'text', text: '...' },
        { type: 'image', assetId: 'file_...', alt: '...', mimeType: 'image/png' }
      ]
    }
  ],
  assets: [
    {
      id: 'file_...',
      pointer: 'sediment://file_...',
      mimeType: 'image/png',
      sizeBytes: 2175004,
      width: 1254,
      height: 1254
    }
  ]
}
```

`assets` is deduplicated by `id`. Turn parts may reference the same asset, but
the ChatGPT extractor suppresses repeated generated-image tool copies within
one semantic assistant turn.

### ChatGPT turn attribution

Walk only `getCurrentPathMessages(...)`, in order:

1. A user message starts a user turn. Its text and media parts belong there.
2. An assistant message starts or continues an assistant turn.
3. An `image_asset_pointer` on a tool message belongs to the current assistant
   response. If no assistant turn exists after the preceding user turn, create
   one.
4. Merge later empty assistant messages into that pending assistant turn.
5. Ignore system messages, tool prose, code-tool scaffolding, reasoning, and
   model captions unless they are already part of visible user/assistant text.
6. Keep a turn when it has text or media; drop it only when both are empty.

For generated-image alt text, prefer `message.metadata.image_gen_title`, then a
provider caption explicitly marked safe for display, then `Generated image`.
Do not use the often very long model caption as alt text.

## Materialization Pipeline

The sync callback must become asynchronous, and every provider loop must await
it. The pipeline for one conversation is:

```text
fetch conversation
  -> write raw JSON cache
  -> normalize turns + assets
  -> resolve and download missing assets
  -> atomically write each asset
  -> render Markdown using only successful local asset paths
  -> atomically write Markdown
  -> record the conversation timestamp
```

Timestamp advancement happens only after all required assets and Markdown are
written. If an asset fails, preserve the previous Markdown, report the
conversation failure, and do not advance its timestamp; the next sync retries
it.

Existing assets are reused when the path exists and its byte count matches a
nonzero `sizeBytes`. A mismatched or partial file is replaced through a
temporary file plus rename. The first version does not delete unreferenced
assets; deletion can be a separate, explicit garbage-collection feature.

## Authenticated Download

Add a binary request primitive beside `makeRequest` rather than decoding image
bytes as UTF-8. It must:

- use the account's Electron session and the current ChatGPT bearer token;
- accept only provider-constructed HTTPS URLs and allowlisted hosts;
- enforce an upper bound (proposed default: 50 MiB per asset);
- stream to a temporary file or return a bounded `Buffer`;
- follow only safe redirects;
- expose status, content type, content length, and final URL to the provider;
- never log response bytes, cookies, bearer tokens, or signed URLs.

For `sediment://file_<id>`, the ChatGPT provider extracts and validates the
asset id, then resolves it through ChatGPT's authenticated file/estuary
endpoint. Endpoint resolution stays behind `resolveAsset(...)` because this is
an internal API and may change independently of message parsing. Before
implementation is considered complete, verify both generated images and user
uploads against the persisted app session; they may use different resolver
routes.

Validate downloaded content using all available signals:

- HTTP success;
- an allowed image MIME type (`image/png`, `image/jpeg`, `image/webp`, or
  `image/gif` for the first version);
- MIME-to-extension mapping controlled by chatdump;
- optional expected size match;
- magic bytes matching the declared format.

SVG is excluded initially because embedding provider-controlled active content
has a different security profile.

## Existing Archive Migration

A parser-version bump alone is insufficient: old raw caches contain asset
pointers, but the current synchronous reparser has no authenticated download
step.

Change reparse to an asynchronous materialization pass. For Markdown with an
older parser version:

1. read its raw cache;
2. normalize it with the provider;
3. download missing assets using the active account session;
4. regenerate Markdown only after successful downloads;
5. bump the parser version in the rewritten file.

This runs before normal incremental fetching, so existing image conversations
are backfilled without requiring their remote update timestamp to change. A
failed backfill leaves the old Markdown and parser version untouched, making it
retryable on the next sync.

## CLI and MCP Behavior

Normal account sync materializes images into the vault. The `conversation`
MCP tool and `fetch` CLI command are currently read operations and should not
silently write files.

For the first release:

- returned Markdown includes a local image link only when that asset already
  exists in the account vault;
- otherwise it renders a readable marker such as `[Generated image: title]`;
- `includeRaw: true` continues to expose the original pointer metadata.

A later explicit `materializeAssets` option can opt these commands into writes.
Do not return expiring signed URLs as an archival substitute.

## Failure and Privacy Rules

- Asset download errors are per-conversation failures, not whole-sync crashes.
- Logs include provider, conversation id, asset id, and status, but no signed
  URL or authentication material.
- Raw cache remains the source of truth and is written even if media download
  fails.
- Never send local files or cached provider media to another service.
- Cancellation aborts active downloads and removes temporary files.
- The account's vault security scope wraps both Markdown and `assets` writes.

## Test Plan

### Unit tests

- user text only remains unchanged;
- user multimodal text preserves text and image order;
- generated tool image creates an assistant media-only turn;
- duplicate pointers render once and download once;
- empty assistant text with an image is retained;
- tool captions/reasoning/internal paths are excluded;
- unsafe pointers and asset ids are rejected;
- MIME mapping, size limit, and magic-byte checks reject invalid data;
- existing valid files are reused and partial files are replaced;
- Markdown paths are relative and deterministic;
- a failed materialization does not rewrite Markdown or advance timestamps;
- outdated raw-cache conversations are backfilled and parser versions update
  only after success.

### Integration fixtures

Keep redacted raw fixtures for:

1. a generated ChatGPT PNG (the observed 1254 x 1254 shape);
2. a user-uploaded JPEG plus prompt text;
3. multiple images in one turn;
4. an edited branch where only current-path media is rendered;
5. an expired/unauthorized asset response.

One opt-in real-API test should use the configured account and `gpt-5.4-nano`,
assert that the downloaded image opens and matches declared dimensions, then
clean up its temporary vault. Reuse a pre-existing generated-image conversation
rather than generating a new image solely for the test.

## Implementation Order

1. Add normalized turn/asset extraction and fixture tests.
2. Add bounded authenticated binary download plus atomic asset writer.
3. Await async conversation callbacks in all providers.
4. Materialize ChatGPT assets during normal sync and render local links.
5. Add asynchronous raw-cache backfill and bump the ChatGPT parser version.
6. Add generated-image and upload integration coverage.
7. Document the user-visible `assets` layout in the README.
