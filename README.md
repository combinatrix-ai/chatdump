# Chativist

Archive your AI chat conversations (Claude, ChatGPT, Gemini) to an Obsidian
vault as Markdown. Runs as a tray-only macOS app.

## Develop

```sh
npm install
npm start
```

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
