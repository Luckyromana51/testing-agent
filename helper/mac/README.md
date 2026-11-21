# GLV Mac helper

The testing server runs on Linux, which has no Safari, no VoiceOver and no iOS Simulator. This small program runs on a Mac and does those tests for it:

| Test | What the Mac does | What comes back |
| --- | --- | --- |
| Safari (Mac, iPhone, iPad) | Opens each page in real Safari through `safaridriver`, on the Mac and in the iOS Simulator | Screenshots, what loaded and what did not, page width, broken images |
| VoiceOver | Starts VoiceOver, opens the page in Safari and moves through it item by item | What VoiceOver said for each item |
| iOS app | Installs the app in the iOS Simulator (or on a connected test iPhone), opens it, runs Apple's accessibility audit on each tab | Crash reports, audit results, screenshots in light, dark and large text |

The Mac only reports what it saw. The server turns that into findings, so the rules are the same for every Mac.

The helper asks the server for work over HTTPS, so nothing has to be opened on the Mac's network. It uses only programs that come with macOS and Xcode: no extra packages, no outside services.

## Set up (once)

1. Install Node.js 22 or newer (`node -v` shows the version).
2. Unzip this folder anywhere, for example in your home folder.
3. **Safari:** run `safaridriver --enable` in Terminal. It asks for the Mac's password.
4. **VoiceOver:** open VoiceOver Utility > General and tick **Allow VoiceOver to be controlled with AppleScript**. On the first VoiceOver test, macOS asks to let Terminal control VoiceOver and Safari: allow it. (It is in System Settings > Privacy & Security > Automation if you said no.)
5. **iOS apps:** install Xcode from the App Store, open it once, and add an iOS 17 or newer Simulator in Xcode > Settings > Components. If `xcodebuild -version` fails, run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.

## Pair it with the server

In the dashboard, open **Owner panel > Mac helpers**, give the Mac a name and press **Make a pairing token**. Then in Terminal, in this folder:

```sh
node glv-helper.mjs pair https://testing.example.com glvh_...
caffeinate -i node glv-helper.mjs
```

`caffeinate -i` keeps the Mac awake while the helper runs. Stop it with Ctrl+C. The Mac shows as online in the owner panel within a few seconds.

The token is saved in `~/.glv-helper/config.json`, readable only by your Mac account. It lets the Mac pick up tests and send back results; it cannot sign in to the dashboard. To stop a Mac from getting tests, press **Unpair** in the owner panel.

## Commands

| Command | What it does |
| --- | --- |
| `node glv-helper.mjs pair <server> <token>` | Saves the server and token, after checking that the server knows the token |
| `node glv-helper.mjs` | Waits for tests and runs them, one at a time |
| `node glv-helper.mjs check` | Shows what this Mac can test, and the step that fixes anything missing |
| `node glv-helper.mjs devices on` | Also uses iPhones and iPads connected by cable, for Development and Ad Hoc builds. The app is installed on that phone, so use a test phone. `devices off` stops it. |

## Which iOS builds work

- **Simulator build:** in Xcode, build for a Simulator, then zip the `.app` from the build folder. The accessibility audit runs on these.
- **Development or Ad Hoc IPA:** exported from Xcode with the test iPhone in its profile. It runs on that iPhone when `devices on` is set; Apple's audit needs the Simulator, so on a phone only the install, launch and crash checks run.
- **App Store IPA:** these are encrypted for the App Store and install only from the App Store or TestFlight, so they cannot be run here. The static iOS engine still checks them.

The app runs on the Mac. Only test apps from clients you trust.

## The audit runner

`GLVRunner/` is a small Xcode project with one UI test, `AuditTests.swift`. It opens the client's app by its bundle ID and calls `performAccessibilityAudit` (iOS 17+, Xcode 15+), the same audit as Xcode's Accessibility Inspector, on the first screen and on up to 5 tabs. Every issue is collected and none fails the test. The helper builds it the first time an app is tested, in `~/.glv-helper/DerivedData`.

## Settings

| Variable | Default | Use |
| --- | --- | --- |
| `GLV_HELPER_HOME` | `~/.glv-helper` | Where the settings, downloads and build folder go |
| `GLV_SERVER`, `GLV_HELPER_TOKEN` | from `pair` | Use instead of the saved settings |
| `GLV_HELPER_ONCE` | off | Run one test, then quit |
