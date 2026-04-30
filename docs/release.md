# Release guide (macOS)

This is the checklist for cutting a signed + notarized macOS build of Chativist
and shipping it as a DMG.

There are two ways to release:

- **CI (recommended)** — push a `v*` tag, GitHub Actions builds, signs,
  notarizes, and attaches the DMG to a GitHub Release. See "CI release"
  below.
- **Local** — run `npm run dist:mac` on your Mac. See "Local release" below.

## CI release

The workflow lives at [`.github/workflows/release.yml`](../.github/workflows/release.yml).
It runs on `macos-14` (Apple Silicon), imports your Developer ID cert into a
temporary keychain, builds a universal binary, notarizes via notarytool,
staples, verifies, and uploads artifacts to a GitHub Release.

### One-time setup: GitHub secrets

You need to register six repository secrets at
`https://github.com/combinatrix-ai/chativist/settings/secrets/actions`.

#### 1. `MACOS_CERTIFICATE` and `MACOS_CERTIFICATE_PASSWORD`

Export your `Developer ID Application` cert + private key as a `.p12`:

1. Open `Keychain Access.app`.
2. In the sidebar choose `login` keychain → `My Certificates`.
3. Find `Developer ID Application: COMBINATRIX K.K. (3Y275A5TZ8)`.
4. **Expand the disclosure triangle** so the private key under it is visible.
5. Select **both** the certificate and its private key (cmd-click).
6. Right-click → `Export 2 items…` → save as `chativist-cert.p12`.
7. Set a password when prompted — this becomes `MACOS_CERTIFICATE_PASSWORD`.
8. Convert to base64:
   ```sh
   base64 -i chativist-cert.p12 | pbcopy
   ```
9. Paste into the `MACOS_CERTIFICATE` secret.
10. **Delete `chativist-cert.p12` from disk** when you're done.

#### 2. `KEYCHAIN_PASSWORD`

Any random string. Used by the workflow to lock/unlock the temporary keychain
it creates inside the runner. Generate one:

```sh
openssl rand -base64 24 | pbcopy
```

#### 3. `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

Same values as your local `.env`:

- `APPLE_ID` = `yotaro.katayama@combinatrix.ai`
- `APPLE_APP_SPECIFIC_PASSWORD` = the app-specific password you created
- `APPLE_TEAM_ID` = `3Y275A5TZ8`

You can register them all in one go from the CLI:

```sh
gh secret set MACOS_CERTIFICATE             < <(base64 -i chativist-cert.p12)
gh secret set MACOS_CERTIFICATE_PASSWORD    # paste the .p12 password
gh secret set KEYCHAIN_PASSWORD             # paste a random string
gh secret set APPLE_ID                      # paste apple id email
gh secret set APPLE_APP_SPECIFIC_PASSWORD   # paste app-specific password
gh secret set APPLE_TEAM_ID                 # paste 3Y275A5TZ8
```

### Cutting a release

```sh
# Bump the version in package.json first.
git commit -am "Release v1.0.1"
git tag v1.0.1
git push origin main v1.0.1
```

Watch the run at
`https://github.com/combinatrix-ai/chativist/actions`. When green, the DMG
and zip are attached to the auto-created Release.

You can also trigger a build without tagging by using the "Run workflow"
button on the Actions tab (`workflow_dispatch`) — useful for verifying CI
without publishing.

## Local release

## Prerequisites (one-time)

1. **Apple Developer Program** membership for team `3Y275A5TZ8`.
2. **`Developer ID Application` certificate** installed in your login keychain.
   - Verify with:
     ```sh
     security find-identity -v | grep "Developer ID Application"
     ```
   - If missing: developer.apple.com → Certificates → `+` → `Developer ID Application`.
     Use Keychain Access → Certificate Assistant → "Request a Certificate from
     a Certificate Authority" to generate the CSR.
3. **App-specific password** for notarization.
   - https://appleid.apple.com/ → Sign-In and Security → App-Specific Passwords.
   - Save the value somewhere safe; you cannot view it again.

## Per-release steps

1. Bump `version` in `package.json`.
2. Export notarization credentials. Easiest is a local `.env` file (already
   gitignored) and `set -a; source .env; set +a` before building, or just
   export them inline:
   ```sh
   export APPLE_ID=your.apple.id@example.com
   export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   export APPLE_TEAM_ID=3Y275A5TZ8
   ```
3. Build:
   ```sh
   npm run dist:mac
   ```
   This signs with the `Developer ID Application` cert from the keychain,
   submits to Apple notarytool, and staples the ticket to the DMG.

   The signed artifacts land in `dist-electron/`:
   - `Chativist-<version>-universal.dmg` (primary distributable)
   - `Chativist-<version>-universal-mac.zip` (used for auto-update later)

4. Verify the DMG passes Gatekeeper on a clean machine (or after clearing
   quarantine):
   ```sh
   spctl -a -vv -t install dist-electron/Chativist-*.dmg
   xcrun stapler validate dist-electron/Chativist-*.dmg
   ```

5. Upload the DMG to GitHub Releases (or wherever you host downloads).

## Replacing the placeholder icon

The current `build/icon.icns` is generated from the tray template glyph and is
a placeholder. To replace it:

1. Drop a 1024×1024 PNG at `build/icon.png`.
2. Regenerate `icon.icns`:
   ```sh
   mkdir -p build/icon.iconset
   for sz in 16 32 128 256 512; do
     sips -z $sz $sz build/icon.png --out build/icon.iconset/icon_${sz}x${sz}.png
     sips -z $((sz*2)) $((sz*2)) build/icon.png --out build/icon.iconset/icon_${sz}x${sz}@2x.png
   done
   sips -z 1024 1024 build/icon.png --out build/icon.iconset/icon_512x512@2x.png
   iconutil -c icns build/icon.iconset -o build/icon.icns
   rm -rf build/icon.iconset
   ```

## Troubleshooting

- **"You do not have permission to open the application"** — the build was
  signed but not notarized. Re-run with notarization env vars set.
- **`notarytool` reports `Invalid` status** — fetch the log:
  ```sh
  xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"
  ```
  Most common cause: an entitlement is missing or a binary inside the bundle
  was not signed with hardened runtime. Adjust `build/entitlements.mac.plist`.
- **Cert not found at sign time** — confirm `security find-identity -v` shows
  it, and that the keychain is unlocked.
