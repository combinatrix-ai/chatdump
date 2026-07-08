# Provider API Reference

## Overview

chatdump fetches conversations from three AI chat providers. Each has a different internal API, authentication mechanism, and data structure. This document describes how each provider works, including deduplication and change detection logic.

---

## Claude (Anthropic)

### Authentication
- **Cookie**: `sessionKey` on `claude.ai`
- **Method**: Cookie is sent directly via Electron session. No additional tokens needed.

### Endpoints
| Purpose | Method | URL |
|---|---|---|
| Organizations | GET | `/api/organizations` |
| Account info | GET | `/api/bootstrap` |
| Conversation list | GET | `/api/organizations/{orgId}/chat_conversations` |
| Single conversation | GET | `/api/organizations/{orgId}/chat_conversations/{uuid}` |

### Deduplication
- **Unique key**: `conversation.uuid` (UUID v4, e.g. `123e4567-e89b-42d3-a456-426614174000`)
- **Stored in timestamps**: `{ [uuid]: updated_at }` where `updated_at` is an ISO 8601 string
- **Change detection**: Compare `conversation.updated_at` from the list API against stored value. If different, re-fetch the full conversation.
- **File naming**: `{YYYY-MM-DD}_{sanitized_title}_{uuid_first8}.md`

### Update Detection
- The list API returns `updated_at` for each conversation.
- When a new message is added, `updated_at` changes.
- On detection, the **entire conversation** is re-fetched and the Markdown file is **overwritten** (not appended).

### Rate Limiting
- 500ms delay between individual conversation fetches.
- No known aggressive rate limiting from Claude's web API.

### Conversation JSON Structure
```json
{
  "uuid": "...",
  "name": "conversation title",
  "created_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-02T00:00:00Z",
  "model": "claude-sonnet-4-6",
  "chat_messages": [
    {
      "sender": "human",
      "content": [{ "type": "text", "text": "..." }]
    },
    {
      "sender": "assistant",
      "content": [{ "type": "text", "text": "..." }]
    }
  ]
}
```

---

## ChatGPT (OpenAI)

### Authentication
- **Cookie**: `__Secure-next-auth.session-token` on `chatgpt.com`
  - Note: This cookie is **split** into `.0` and `.1` chunks when the JWT is too large.
- **Access token**: Required for `/backend-api/*` calls. Obtained from `/api/auth/session` → `accessToken` field.
- **Method**: Cookie authenticates the session endpoint; Bearer token authenticates all backend API calls.

### Endpoints
| Purpose | Method | URL |
|---|---|---|
| Session / token | GET | `/api/auth/session` |
| Account info | GET | `/backend-api/me` (with Bearer token) |
| Conversation list | GET | `/backend-api/conversations?offset={n}&limit=100` |
| Single conversation | GET | `/backend-api/conversation/{id}` (with Bearer token) |

### Deduplication
- **Unique key**: `conversation.id` (UUID v4, e.g. `123e4567-e89b-42d3-a456-426614174001`)
- **Stored in timestamps**: `{ [id]: update_time }`, normalized to ISO milliseconds.
- **Change detection**: Compare normalized `conversation.update_time` from the list API against stored value.
- **File naming**: `{YYYY-MM-DD}_{sanitized_title}_{id_first8}.md`

### Update Detection
- The list API returns `update_time` for each conversation.
- **Read-bumps-update_time**: Simply calling `GET /backend-api/conversation/{id}` (a read, no edits) bumps the server-side `update_time` for that conversation. As a side effect, the conversation moves to the top of the list returned by `/backend-api/conversations`, and the official ChatGPT UI re-orders accordingly. There is no known read-only variant.
- **Sync iteration order**: Regular sync reads the to-fetch list in **reverse list-API order** (oldest-touched first). Because each read bumps `update_time`, walking oldest→newest means the final touched conversation ends up topmost on the server, and the chatgpt.com sidebar settles back to `update_time` DESC after the sync finishes. The reordering is only visible while sync is running.
- After a full fetch, store the touched full-conversation `update_time` for future sync checks so the same conversation is not re-fetched every run.
- Do not use the full-conversation top-level `update_time` as Markdown `updated`; after fetch it can represent fetch/read time.
- Markdown `updated` is derived from the maximum `message.create_time` on the current visible conversation path.
- Full conversation JSON is still written to raw cache; Markdown is overwritten from the current path.

### Sidebar Re-ordering Modes
Two opt-in modes touch every conversation in a chosen order to permanently re-sort the chatgpt.com sidebar:
- `full-sync:created_at` — sorts ascending by `create_time`, so after the run the sidebar is ordered newest-created at the top.
- `full-sync:last_message_at` — sorts ascending by the latest `message.create_time` on the current path, so the sidebar reflects last-actual-activity order.
These are exposed under the per-account *Full sync* menu and are intended as one-shot operations.

### Rate Limiting
- ChatGPT's backend-api rate limits **aggressively** (HTTP 429).
- Base delay: 10 seconds between requests, with adaptive bounds from 8 to 30 seconds.
- Exponential backoff on 429: 5s → 10s → 20s → 40s → 80s → 120s (up to 5 retries per conversation).
- Adaptive delay: increases on 429, gradually decreases on success.
- After 10 consecutive 429s: 5-minute cooldown pause.
- Access token is refreshed every 100 items and after long pauses.

### Account Info (Fallback)
Primary method: parse `oai-client-auth-info` cookie (contains `user.email`, `user.name`).
Fallback: `/api/auth/session` → `user.email`, `account.planType`.

### Conversation JSON Structure
ChatGPT uses a **tree structure** with a `mapping` object:
```json
{
  "title": "...",
  "create_time": 1700000000.0,
  "update_time": 1700001000.0,
  "current_node": "node-id-2",
  "default_model_slug": "gpt-4o",
  "conversation_id": "...",
  "mapping": {
    "node-id-1": {
      "id": "node-id-1",
      "parent": null,
      "children": ["node-id-2"],
      "message": {
        "author": { "role": "user" },
        "create_time": 1700000000.0,
        "update_time": null,
        "content": { "parts": ["user message text"] }
      }
    },
    "node-id-2": {
      "id": "node-id-2",
      "parent": "node-id-1",
      "children": [],
      "message": {
        "author": { "role": "assistant" },
        "create_time": 1700001000.0,
        "update_time": null,
        "content": { "parts": ["assistant response text"] }
      }
    }
  }
}
```
Messages are flattened by walking backward from `current_node` through `parent` links, then reversing the path. This matches the branch currently visible in the ChatGPT UI. Edited prompts create sibling branches in `mapping`; old branches remain in raw cache but are not included in Markdown unless they are on the current path.

`message.update_time` exists in the response shape, but observed messages normally have `null` there, including edited messages. Edited messages are represented as new message nodes with new `create_time` values.

---

## Gemini (Google)

### Authentication
- **Cookie**: `__Secure-1PSID` on `.google.com` (plus various other Google auth cookies: `SID`, `HSID`, `SSID`, `SAPISID`, etc.)
- **Page tokens**: Extracted from the HTML of `https://gemini.google.com/app` via regex:
  - `SNlM0e` → AT token (CSRF, sent as `at` parameter in POST body)
  - `cfb2h` → Build label (sent as `bl` query parameter)
  - `FdrFJe` → Session ID (sent as `f.sid` query parameter)
- **Method**: Cookies + page tokens. No Bearer token. All API calls use the Google WIZ framework's `batchexecute` endpoint.

### Endpoints
| Purpose | Method | URL |
|---|---|---|
| Page tokens + account info | GET | `https://gemini.google.com/app` (HTML page) |
| All RPC calls | POST | `https://gemini.google.com/_/BardChatUi/data/batchexecute` |

### RPC IDs (batchexecute)
| RPC ID | Purpose |
|---|---|
| `MaZiqc` | List conversations |
| `hNvQHb` | Read individual conversation messages |
| `otAQ7b` | User status / model list |
| `ESY5D` | Settings |

### batchexecute Request Format
```
POST /_/BardChatUi/data/batchexecute?rpcids={rpcId}&source-path=/app&bl={bl}&f.sid={sid}&hl=en&_reqid={random}&rt=c

Content-Type: application/x-www-form-urlencoded
Headers: Origin, Referer, X-Same-Domain: 1, Cookie

Body: f.req=[[["rpcId", "payload_json_string", null, "generic"]]]&at={SNlM0e_token}
```

### batchexecute Response Format
```
)]}'

{length_in_chars}
[["wrb.fr","rpcId","{escaped_json_string}",null,null,null,"generic"]]
{length}
[["di",303],["af.httprm",302,"-1234567890",18]]
{length}
[["e",4,null,null,{total_bytes}]]
```
- Starts with XSSI prefix `)]}'`
- Length-prefixed frames (length in characters, not bytes)
- Main data is in the `wrb.fr` frame at index `[2]` as a JSON string that needs a second parse

### Deduplication
- **Unique key**: `conversation.id` (e.g. `c_1540750472593ab8`)
- **Stored in timestamps**: `{ [id]: timestamp }` where `timestamp` is milliseconds (derived from `[seconds, nanos]` in the RPC response)
- **Change detection**: Compare conversation timestamp from `MaZiqc` list against stored value.
- **File naming**: `{YYYY-MM-DD}_{sanitized_title}_{id_no_prefix_first8}.md`

### Update Detection
- `MaZiqc` RPC returns a timestamp `[seconds, nanos]` per conversation.
- Unclear if this timestamp updates on every new message or only on certain events.
- Full conversation is re-fetched via `hNvQHb` and Markdown is overwritten.

### Account Info
- **Email**: Extracted from page HTML via regex (looks for email patterns, excludes `@google.com`).
- **Plan**: Checks for `"PRO"` or `"gemini_advanced"` in page HTML.

### Conversation List Response (MaZiqc)
Payload: `[13, pageToken, [0, null, 1]]` (13 conversations per page, 0 = not pinned)
```json
[
  null,
  "encrypted_token",
  [
    ["c_abc123", "Conversation Title", null, null, null, [1772582293, 666327000], null, null, null, 2],
    ...
  ]
]
```
- Top-level `data[1]` = continuation token for the next page, reused as `pageToken`
- Conversation item `[0]` = conversation ID
- Conversation item `[1]` = title
- Conversation item `[5]` = `[seconds, nanos]` timestamp

### Conversation Messages Response (hNvQHb)
Payload: `[conversationId, limit, null, 1, [1], [4], null, 1]`
The client requests `limit = 200` messages per conversation.
```
[
  [
    [
      ["conv_id", "response_id"],
      null,
      [["user message text"], 2, ...],          // [2][0][0] = user text
      [
        [
          ["candidate_id", ["model response text"], ...],  // [3][0][0][1][0] = model text
          ...
        ],
        ...
      ],
      ...
    ],
    ...
  ]
]
```

### Stability Warning
Gemini's API is reverse-engineered from Google's internal WIZ framework. RPC IDs (`MaZiqc`, `hNvQHb`) and response structures are **not stable** and can change without notice. The [`gemini-webapi`](https://pypi.org/project/gemini-webapi/) Python package (AGPL-3.0) maintains up-to-date RPC mappings and was used as reference.

---

## Common Sync Logic

### Sync Flow (all providers)
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

### File Writing
- **Writer** (`writer.js`) compares file content before writing — only overwrites if content has changed.
- **Streaming**: Conversations are written **immediately** as they're fetched (via `onConversation` callback), not after all fetches complete.
- **Progress saving**: Timestamps are persisted every 25 items, so progress survives crashes.

### Markdown Format
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

### File Naming
`{YYYY-MM-DD}_{sanitized_title}_{id_first_8_chars}.md`

- Date: conversation creation date
- Title: sanitized (special chars → `_`, spaces → `_`, max 80 chars)
- ID suffix: first 8 characters of conversation ID to prevent collisions
