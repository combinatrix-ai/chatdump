# chatdump docs

Documentation for [chatdump](../README.md) — a tray-only macOS app that archives
your Claude, ChatGPT, and Gemini conversations as plain Markdown.

## Using it

- [cli.md](cli.md) — the `chatdump` command-line tool (`list`, `sync`, `fetch`, `mcp`).
- [mcp.md](mcp.md) — the stdio MCP server: tools, client config, and fetching a
  conversation by id or share link.

## Internals (contributors)

- [internals/providers.md](internals/providers.md) — each provider's web API:
  authentication, endpoints, deduplication, and JSON shapes.
- [internals/sync.md](internals/sync.md) — the shared sync loop, file writing,
  and Markdown format all providers feed into.
- [internals/images.md](internals/images.md) — offline image storage, ChatGPT
  turn attribution, authenticated downloads, and archive migration.

## Releasing (maintainers)

- [release.md](release.md) — signed/notarized macOS (DMG) release.
- [mas-release.md](mas-release.md) — Mac App Store release.
