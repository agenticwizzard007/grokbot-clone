# Swarm for iOS and macOS

The Apple apps share a SwiftUI shell and load the existing Swarm interface in WebKit. They connect to a hosted Swarm server; model keys, SQLite, routines, computers, and bot execution stay on that server. Closing the app does not stop server-side work. These are development apps, not App Store or notarized releases.

Supported platforms: **iOS/iPadOS 17+** and **macOS 14+**. No Electron, Capacitor, CocoaPods, or third-party Swift packages are required. XcodeGen generates two app targets and two policy-test targets from `apple/project.yml`.

## Run in Xcode

On a Mac with Xcode 15 or newer and its command-line tools selected:

```sh
npm run apple:open
```

The generated `apple/Swarm.xcodeproj` is checked in and can also be opened directly. Install `xcodegen` with Homebrew if you edit `apple/project.yml`; the scripts regenerate the project whenever XcodeGen is available.

Select **Swarm-iOS** and an iPhone/iPad simulator, or **Swarm-macOS** and My Mac, then Run. Set your Apple development team in Signing & Capabilities before running on a physical iPhone. The iOS bundle ID is `so.swarms.app`; the Mac bundle ID is `so.swarms.app.macos`. Change them if your organization uses different identifiers. Keep the callback scheme `so.swarms.app` aligned with `server/src/native-auth.ts`, `SignInAttempt.swift`, and both Info plists if you change it.

From a terminal:

```sh
npm run apple:macos   # compile a development Mac app
npm run apple:ios     # compile for the iOS simulator
npm run apple:test    # run the native URL/authentication policy tests on Mac
```

The scripts use unsigned builds so CI needs no developer credentials. For a runnable sandboxed Mac development build, run through Xcode with local development/ad-hoc signing. The resulting apps are under `apple/build/Build/Products/Debug/Swarm.app` (Mac) and `Debug-iphonesimulator/Swarm.app` (simulator). Simulator apps cannot be installed on a physical phone.

The `Apple apps` GitHub Actions workflow builds both platforms and runs native policy tests on a Mac runner. Its artifacts are development builds, not distribution packages.

## Server configuration

The app defaults to `https://swarm-team.fly.dev`. Use the native **… → Server settings** menu to point at your own server. It requires an HTTPS origin with no path, query, or embedded credentials. Debug builds additionally accept `http://localhost:8787` (and loopback IPs). Localhost on a physical iPhone is the phone itself; use an HTTPS server reachable from the device.

Build and deploy **this version of the server and web app together** before using native Google sign-in or the new phone layout. Set `APP_URL` and `SERVER_URL` to that same public origin. A production server should have `DEV_LOGIN=0`. Keep the usual model and Composio keys on the server, never in the Apple project. The apps require connectivity; they do not bundle or start the Node server or desktop companion.

For local development, run `npm run build`, start the API, and connect the Debug app to `http://localhost:8787`. The API serves the built web interface. When developing Google authentication, use one publicly reachable HTTPS origin for both app and API so browser cookies and callbacks stay on the same host.

## Authentication and connected apps

Apple, Google, and phone are supported across all clients. [Configure Sign in with Apple](apple-sign-in.md) for the native Apple sheet, web authorization, account linking, and deletion/revocation. The confirmed signing team is `A77YW376ZH`.


Phone-code sign-in runs inside WebKit and retains its HttpOnly session cookie in WebKit's persistent data store. Google sign-in uses `ASWebAuthenticationSession`, avoiding embedded-browser OAuth restrictions:

1. The native app creates a random verifier and state, keeping both in memory, and sends an SHA-256 challenge to `/api/auth/native/start`.
2. The server binds that attempt to the system browser using an HttpOnly cookie. Google's existing browser-bound callback verifies the account.
3. The browser returns `so.swarms.app://auth` with a one-use code and matching state. The code expires in 60 seconds. No session token is placed in a callback URL.
4. The native app validates the callback and sends the code and verifier to `/api/auth/native/exchange`. The server verifies PKCE, consumes the code, and sets the HttpOnly session cookie. The app copies that cookie into WebKit and loads Swarm.

Pending attempts expire after ten minutes. Expired, reused, malformed, mismatched, or unverified codes cannot establish a session. Arbitrary app deep links cannot sign in: authentication callbacks are accepted only by the live system-browser session. Browser login continues to work as before.

Connected-app authorization opens in the default browser. Native requests receive a signed callback bound to the account, app, bot, transcript card, and a fifteen-minute expiry. This allows a callback to confirm the right connection even if the browser is signed in to another Swarm account. The browser shows a **Return to Swarm** link; the app refreshes connections and messages on return. No native login session is created by that callback.

**Clear local sign-in data** removes this app's WebKit cookies and local website settings for every server. It does not delete accounts, bots, or conversations on the server. Use the web app's Log out action to revoke the active server session.

## Native behavior

- The Mac uses a native window and menu commands; the iPhone and iPad use native navigation and respect safe areas and the keyboard.
- The shared interface has a phone drawer for bots, full-width chat/details, and scrollable settings and dialogs.
- Navigation stays within the configured server origin. External links open in the system browser; the app exposes no JavaScript-to-native bridge.
- Microphone requests from the server's main frame prompt for permission. Camera and foreign-frame capture are denied. Voice calls need the app in the foreground; no background-audio entitlement is requested.
- Downloads use the Mac save panel or the iOS share sheet. File uploads use WebKit's picker (with an explicit open panel on Mac).
- Native connection errors offer retry and server settings. Returning from the background resynchronizes messages and connected apps without discarding drafts.
- The Mac is sandboxed with outbound networking, microphone, and user-selected file access. No arbitrary local shell access is granted to web content. The existing computer companion remains a separate, explicit pairing flow.

## Validation

```sh
npm run typecheck
npm run build
npm run test:native-auth
npm run test:mobile
npm run apple:ios
npm run apple:macos
npm run apple:test
```

The server authentication tests use an isolated temporary database and a simulated already-verified Google callback, with no provider calls. The browser tests serve the built frontend and mock API responses and exercise phone navigation, details, creation dialogs, settings, and draft-preserving resume at 320, 390, 844, and 1440 pixels. They use installed Chrome (`CHROME_PATH` can override its path). Native policy tests cover URL boundaries and authentication callback validation.

Before shipping, also exercise real Google sign-in (success/cancellation), phone sign-in, app connections, microphone permission and voice, authenticated downloads/uploads, switching servers, offline recovery, and background/resume on a physical iPhone and a signed Mac build. Automated code-exchange tests do not establish that a particular production Google/Composio project is correctly configured.

## Distribution

Choose your Apple development team, signing identities and provisioning profiles, then archive the appropriate app target in Xcode. Use TestFlight/App Store Connect for iOS; use Developer ID signing and notarization for direct Mac distribution, or prepare a Mac App Store submission. This repository does not include signing credentials, a paid Apple Developer account, or an automatic update service.

The privacy manifest declares the app's local UserDefaults use and the account, conversation, attachment, audio, and usage data the hosted product can process for app functionality. Review those declarations and the App Store privacy answers against your deployed providers and retention policy. Supply your privacy policy, support URL, screenshots, reviewer access, and any required sign-in options before submission. Apple still reviews the complete product, including minimum functionality and account-deletion requirements; building the app is not App Store approval. Push notifications, offline chat, and background voice are not implemented.
