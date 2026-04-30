# Release guide (macOS)

This is the checklist for cutting a signed + notarized macOS build of Chativist
and shipping it as a DMG.

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
