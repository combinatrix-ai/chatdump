# Chativist

Archive your AI chat conversations (Claude, ChatGPT, Gemini) to an Obsidian
vault as Markdown. Runs as a tray-only macOS app.

## Develop

```sh
npm install
npm start
```

`electron-store` is pinned to 8.x because 9+ is ESM-only and this codebase is
CommonJS.

## MCP Server

Chativist can run as a stdio MCP server for local agents:

```sh
npm run mcp
```

Project-scoped MCP client example:

```json
{
  "mcpServers": {
    "chativist": {
      "command": "npm",
      "args": ["run", "mcp"]
    }
  }
}
```

The server exposes four tools:

- `ask` — ask a question through Chativist's persisted browser session. It
  currently supports ChatGPT accounts and returns `answer`, `conversationId`,
  `url`, `accountId`, and `provider`.
- `conversation` — fetch a full conversation by provider conversation id. It
  returns Markdown by default, and returns the provider raw JSON too when
  `includeRaw` is `true`.
- `accounts` — list configured accounts and sync status.
- `sync` — sync selected accounts to their configured Obsidian vaults.

It also exposes the `chativist://accounts` resource for configured accounts as
JSON.

Typical MCP flow:

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

Then pass the returned `conversationId` to fetch the full transcript:

```json
{
  "tool": "conversation",
  "arguments": {
    "accountId": "openai:user@example.com",
    "conversationId": "6a447140-bf20-83e8-a387-fa355c5f31c1"
  }
}
```

It reuses the Electron app's configured accounts and persisted login sessions.
It does not open provider login windows; re-login from the menu bar app if auth
expired.

## Release (macOS)

Tag a version and CI handles the rest:

```sh
git tag v1.0.1
git push origin v1.0.1
```

GitHub Actions builds a universal binary, signs with the Developer ID cert,
notarizes via Apple, staples, and attaches the DMG + zip to a GitHub Release.

For local builds, the one-time CI setup, or troubleshooting see
[docs/release.md](docs/release.md).

For Mac App Store packaging and submission, see
[docs/mas-release.md](docs/mas-release.md).

## License

MIT — see [LICENSE](LICENSE).
