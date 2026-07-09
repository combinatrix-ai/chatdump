# CLI & MCP Reference

chatdump ships as a tray-only macOS app, but the same binary doubles as a
command-line tool and a stdio MCP server. Both reuse the app's configured
accounts and persisted login sessions — they never open provider login
windows, so if a session has expired, re-login from the menu bar app first.

- [Invoking the CLI](#invoking-the-cli)
- [Commands](#commands)
- [MCP server](#mcp-server)
- [MCP tools](#mcp-tools)
- [Fetching a conversation or share link](#fetching-a-conversation-or-share-link)
- [Resources](#resources)

## Invoking the CLI

chatdump offers to install a `chatdump` command onto your `PATH` the first time
you launch it, and you can trigger the same install any time from the menu bar
(**Install Command Line Tool…**). Once installed:

```sh
chatdump <command> [options]
```

MCP clients can then use `"command": "chatdump", "args": ["cli", "mcp"]`
instead of the full app path.

If you'd rather not install it (or you are on the Mac App Store build, where
this is unavailable), call the binary inside the app bundle directly:

```sh
/Applications/chatdump.app/Contents/MacOS/chatdump cli <command> [options]
```

When running from source, use `npm run cli -- <command> [options]`.

> The examples below use the bare `chatdump <command>` form. If you have not
> installed the PATH command, prefix them with
> `/Applications/chatdump.app/Contents/MacOS/chatdump cli`.

## Commands

| Command | Description |
|---|---|
| `help` | Print usage. |
| `list` (alias `accounts`) | List configured accounts and their sync status. |
| `sync` | Sync selected accounts to their configured vault folders. |
| `mcp` | Start the stdio MCP server. |

### `list`

```sh
chatdump list [--json]
```

- `--json` — machine-readable output.

### `sync`

```sh
chatdump sync [options]
```

| Option | Description |
|---|---|
| `--all` | Sync every enabled account. |
| `--include-disabled` | Also sync accounts with auto-sync turned off. |
| `--account <id>` | Sync a specific account (repeatable), e.g. `openai:user@example.com`. |
| `--provider <name>` | Limit to one provider (`openai`, `claude`, `gemini`). |
| `--since-days <days>` | Only consider conversations updated within the window. |
| `--full-sync <created_at\|last_message_at>` | Re-touch every conversation to reorder the provider sidebar by the chosen key. |
| `--json` | Machine-readable output. |

Examples:

```sh
chatdump list
chatdump sync --all
chatdump sync --account openai:user@example.com --since-days 7
chatdump sync --provider claude --full-sync last_message_at
```

## MCP server

chatdump can run as a stdio MCP server for local agents, reusing the app's
configured accounts and sessions.

Start it:

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

## MCP tools

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

## Privacy

All work happens on your machine against each provider's own web API, using the
session cookies you signed in with — there is no chatdump backend. See the main
[README](../README.md#privacy--how-it-works) for details.
