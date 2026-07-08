# Mac App Store release guide

This is the checklist for preparing a Mac App Store build of chatdump.

The MAS build is different from the direct DMG release:

- It must use App Sandbox.
- It is signed with Mac App Store certificates, not a Developer ID certificate.
- It is uploaded as a `.pkg` to App Store Connect.
- It is not notarized by this project; the App Store distribution flow handles that.

## Current project status

The project already has these MAS-specific pieces:

- `npm run dist:mas`
- `npm run dist:mas-dev`
- `build/entitlements.mas.plist`
- `build/entitlements.mas.inherit.plist`
- security-scoped bookmarks for persisted vault folder access

The important runtime behavior is that users must choose their destination folder
from the app menu. In MAS builds, chatdump stores the security-scoped bookmark
returned by the folder picker and activates it while writing Markdown/cache
files. A raw saved path is not enough for persistent access outside the sandbox.

## One-time Apple setup

1. Register or confirm the explicit App ID:
   - Bundle ID: `ai.combinatrix.chatdump`
   - Team ID: `3Y275A5TZ8`
   - Capability: App Sandbox
   - App Group: `3Y275A5TZ8.ai.combinatrix.chatdump`

2. Create the App Store Connect app record:
   - Platform: macOS
   - Name: `chatdump`
   - Bundle ID: `ai.combinatrix.chatdump`
   - SKU: choose a stable internal value, for example `chatdump-macos`

3. Create signing assets:
   - `Mac App Distribution` certificate for the MAS app bundle.
   - `Mac Installer Distribution` certificate for the submitted installer pkg.
   - `Mac App Store Connect` provisioning profile for `ai.combinatrix.chatdump`.
   - Regenerate the profile after enabling the app group so the profile includes
     every entitlement in `build/entitlements.mas.plist`.

4. Optional but recommended for local sandbox testing:
   - Apple Development certificate.
   - macOS development provisioning profile for the same App ID.

Install certificates in Keychain Access and install provisioning profiles by
opening the downloaded `.provisionprofile` files. If electron-builder cannot
auto-discover the profile, add an explicit `provisioningProfile` path under
`build.mas` or `build.masDev` in `package.json`.

## Local MAS sandbox test

Run:

```sh
npm run dist:mas-dev
```

Then launch the generated app from `dist-electron/mas-dev/`, add at least one
account, select a vault folder from the menu, quit, reopen, and sync again. The
second sync is the key test because it proves the stored security-scoped
bookmark works after relaunch.

## Store build

Before building:

1. Bump `version` in `package.json`.
2. Make sure the `Mac App Distribution` and `Mac Installer Distribution`
   certificates are available in the keychain.
3. Make sure the Mac App Store provisioning profile for
   `ai.combinatrix.chatdump` is installed.

Build:

```sh
npm run dist:mas
```

The output should include a `.pkg` under `dist-electron/`. Upload that package
with Transporter or `xcrun altool`.

Example validation/upload with `altool`:

```sh
xcrun altool --validate-app -f dist-electron/*.pkg -t macos -u "$APPLE_ID" -p "$APPLE_APP_SPECIFIC_PASSWORD"
xcrun altool --upload-app -f dist-electron/*.pkg -t macos -u "$APPLE_ID" -p "$APPLE_APP_SPECIFIC_PASSWORD"
```

After upload, wait for App Store Connect processing, select the processed build,
complete metadata, and submit for review.

## Review notes to prepare

chatdump is a menu bar app, so include clear reviewer notes:

- The app runs from the macOS menu bar and hides the Dock icon.
- To test, open the menu bar icon, choose `Add Account...`, sign in to a
  supported provider, choose `Set Default Vault...`, then run `Sync Now`.
- The app writes Markdown files only into the user-selected vault folder.
- Network access is used to fetch the user's own chat history from configured
  AI providers.
- No background server or separate update mechanism is used for MAS builds.

Also prepare App Store privacy metadata and a privacy policy URL that accurately
describes provider login/cookie use, local Markdown output, local logs, and any
data that leaves the device.

## Common rejection/build risks

- **Vault writes fail after relaunch**: rebuild and retest the security-scoped
  bookmark flow with `dist:mas-dev`; the user must reselect the vault if a path
  was saved before bookmark support existed.
- **Signing fails because entitlements do not match the profile**: regenerate the
  provisioning profile after changing capabilities.
- **The app cannot be found by the reviewer**: mention that it is menu-bar only
  and hides the Dock icon.
- **Provider login or scraping concerns**: reviewer notes and privacy metadata
  should be explicit that users authenticate to their own accounts and the app
  exports their own conversations to local Markdown.
