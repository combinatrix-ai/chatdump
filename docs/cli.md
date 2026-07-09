# CLI Reference

chatdump ships as a tray-only macOS app, but the same binary doubles as a
command-line tool. It reuses the app's configured accounts and persisted login
sessions — it never opens provider login windows, so if a session has expired,
re-login from the menu bar app first.

For the MCP server (the `mcp` command), see [mcp.md](mcp.md).

- [Invoking the CLI](#invoking-the-cli)
- [Commands](#commands)

## Invoking the CLI

chatdump offers to install a `chatdump` command onto your `PATH` the first time
you launch it, and you can trigger the same install any time from the menu bar
(**Install Command Line Tool…**). Once installed:

```sh
chatdump <command> [options]
```

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
| `fetch` | Fetch one conversation or shared ChatGPT link and print Markdown. |
| `mcp` | Start the stdio MCP server — see [mcp.md](mcp.md). |

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

### `fetch`

```sh
chatdump fetch <url-or-id> [--account <id>] [--provider <name>] [--json]
```

Fetches a provider conversation id, a `chatgpt.com/c/<id>` URL, or a public
`chatgpt.com/share/<id>` link. By default, it prints only the converted Markdown
body, so the output can be piped or redirected directly.

| Option | Description |
|---|---|
| `--account <id>` | Fetch using a specific account, e.g. `openai:user@example.com`. |
| `--provider <name>` | Select the provider when no account is specified. |
| `--json` | Print the full structured result without the raw provider payload. |

Example:

```sh
chatdump fetch https://chatgpt.com/share/abc123 > shared-chat.md
```

### `mcp`

Starts the stdio MCP server. See [mcp.md](mcp.md) for configuration, tools, and
examples.

## Privacy

All work happens on your machine against each provider's own web API, using the
session cookies you signed in with — there is no chatdump backend. See the main
[README](../README.md#privacy--how-it-works) for details.
