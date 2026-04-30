# Chativist

Archive your AI chat conversations (Claude, ChatGPT, Gemini) to an Obsidian
vault as Markdown. Runs as a tray-only macOS app.

## Develop

```sh
npm install
npm start
```

## Release (macOS)

See [docs/release.md](docs/release.md) for the full signed + notarized build
flow. TL;DR:

```sh
cp .env.example .env  # fill in APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD
set -a; source .env; set +a
npm run dist:mac
```

Signed, notarized, stapled DMG drops in `dist-electron/`.

## License

MIT — see [LICENSE](LICENSE).
