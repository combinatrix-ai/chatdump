# MCP Server Reference

chatdump can run as a stdio MCP server for local agents, reusing the app's
configured accounts and persisted login sessions. It does not open provider
login windows; re-login from the menu bar app if a session has expired.

For the plain command-line interface (`list`, `sync`), see [cli.md](cli.md).

- [Running the server](#running-the-server)
- [Tools](#tools)
- [Fetching a conversation or share link](#fetching-a-conversation-or-share-link)
- [Resources](#resources)

## Running the server

```sh
chatdump mcp
# or, without the PATH command:
/Applications/chatdump.app/Contents/MacOS/chatdump cli mcp
# or, from source:
npm run mcp
```

Project-scoped MCP client configuration:

```json
{
  "mcpServers": {
    "chatdump": {
      "command": "/Applications/chatdump.app/Contents/MacOS/chatdump",
      "args": ["cli", "mcp"]
    }
  }
}
```

If you have installed the `chatdump` PATH command, you can use
`"command": "chatdump", "args": ["cli", "mcp"]` instead of the full app path.

## Tools

| Tool | Description |
|---|---|
| `ask` | Ask a question through chatdump's persisted browser session. Currently supports ChatGPT. Returns `answer`, `conversationId`, `url`, `accountId`, `provider`. |
| `conversation` | Fetch a full conversation as Markdown. Accepts a conversation id, a `chatgpt.com/c/<id>` URL, or a public `chatgpt.com/share/<id>` link. |
| `accounts` | List configured accounts and their sync status. |
| `sync` | Sync selected accounts to their vault folders. |

### `conversation` arguments

| Argument | Required | Description |
|---|---|---|
| `conversationId` | yes* | A conversation id, a `chatgpt.com/c/<id>` URL, or a `chatgpt.com/share/<id>` link. |
| `shareId` | no | A bare share id, as an alternative to passing a full share URL in `conversationId`. |
| `accountId` | no | Which configured account to use (e.g. `openai:user@example.com`). |
| `provider` | no | Provider to select a default account from when `accountId` is omitted (defaults to `openai`). |
| `includeRaw` | no | When `true`, also return the provider's raw JSON. |
| `timeoutMs` | no | Request timeout in milliseconds. |

\* `conversationId` is optional only when `shareId` is supplied instead.

The response includes `shared: true` when the source was a share link.

## Fetching a conversation or share link

Ask a question and get back a `conversationId`:

```json
{
  "tool": "ask",
  "arguments": {
    "accountId": "openai:user@example.com",
    "prompt": "Review this design and point out the main risks.",
    "timeoutMs": 240000
  }
}
```

Fetch a full conversation by id:

```json
{
  "tool": "conversation",
  "arguments": {
    "accountId": "openai:user@example.com",
    "conversationId": "123e4567-e89b-42d3-a456-426614174002"
  }
}
```

Or fetch a shared conversation straight from its link — no id lookup needed:

```json
{
  "tool": "conversation",
  "arguments": {
    "conversationId": "https://chatgpt.com/share/123e4567-e89b-42d3-a456-426614174002"
  }
}
```

Share links are read through ChatGPT's **public** share endpoint
(`/backend-api/share/<id>`), so they resolve even for conversations the
signed-in account does not own — a valid session is still needed to clear
Cloudflare. If the owner has since revoked the link, the provider returns a
"shared conversation deleted" error, which chatdump surfaces verbatim.

## Resources

The MCP server also exposes the `chatdump://accounts` resource: the configured
accounts and their sync status as JSON.
