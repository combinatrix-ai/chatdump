# Sync Internals

> Contributor reference. This is the provider-agnostic half of syncing — the
> shared loop that each provider in [providers.md](providers.md) feeds into.

## Sync Flow (all providers)
```
1. Authenticate (cookie / token)
2. Fetch conversation list
3. Compare each conversation's timestamp against stored timestamps
4. For changed/new conversations: fetch full conversation
5. Convert to Markdown (with YAML frontmatter)
6. Write to {vault}/{provider}/{email}/{date}_{title}_{id}.md
   Raw API response cached to {vault}/.chatdump/cache/{provider}/{email}/{id}.json
7. Update stored timestamps
```

## File Writing
- **Writer** (`writer.js`) compares file content before writing — only overwrites if content has changed.
- **Streaming**: Conversations are written **immediately** as they're fetched (via `onConversation` callback), not after all fetches complete.
- **Progress saving**: Timestamps are persisted every 25 items, so progress survives crashes.

## Markdown Format
```markdown
---
title: "Conversation Title"
created: 2026-01-01T00:00:00Z
updated: 2026-01-02T00:00:00Z
model: claude-sonnet-4-6
source: claude
id: "uuid-here"
parser_version: 1
---

## Human

User message...

## Assistant

AI response...
```

## File Naming
`{YYYY-MM-DD}_{sanitized_title}_{id_first_8_chars}.md`

- Date: conversation creation date
- Title: sanitized (special chars → `_`, spaces → `_`, max 80 chars)
- ID suffix: first 8 characters of conversation ID to prevent collisions
