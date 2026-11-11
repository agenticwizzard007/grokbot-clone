# Use this Mac

Swarm for macOS can run its own local companion as your signed-in Mac user. Open **Swarm → Use this Mac…**, **Mac Control → Use this Mac…**, or the Swarm menu-bar icon. The controls use a native window and remain available when the web interface is offline or its window is closed. iOS does not include this feature.

Sign in to your server in Swarm, check the account and server shown in the native window, and explicitly approve terminal, files, browsers, and desktop access. Choose **Approve and start**. All four approvals are required because the companion offers the full desktop protocol. Nothing starts automatically on install, app launch, login, or returning to the app. Quitting and reopening Swarm requires another explicit Start. Closing its windows alone leaves the menu-bar app and any running control active.

The approved account’s bots can run commands, read/change/delete files your user can access, use Playwright, and interact with apps and browsers on the real desktop. The companion runs without privilege elevation. macOS permissions still apply. Screen contents, command results and files used by tasks can reach your Swarm server and configured AI providers.

## Permissions and status

The window and menu bar show **Stopped**, **Stopping…**, **Running · connecting**, or **Running · connected**. The window identifies the account by email or name and shows the server origin, connection errors and actual Accessibility/Screen Recording status. The account ID remains internal to the consent and token binding. Running describes the app-managed process; connected also requires the server to report its local connection.

The four access approvals belong to Swarm’s own control window; they do not grant Apple’s separate privacy permissions. Terminal and Playwright may start before desktop permissions are granted:

| Permission | Behavior |
| --- | --- |
| Accessibility | Native `AXIsProcessTrusted` status and `AXIsProcessTrustedWithOptions` request. Required for desktop input. |
| Screen Recording | Native `CGPreflightScreenCaptureAccess` status and `CGRequestScreenCaptureAccess` request. Required for desktop screenshots. |
| Full Disk Access | Opens the appropriate System Settings pane. macOS has no general public grant/status API; the app does not claim it is approved. Protected file access can fail until you approve it. |
| Automation | Opens System Settings. Apple Events consent is per target app and is requested by macOS when used. No global approved status is inferred. |

Allow Swarm, or the helper macOS identifies, in **System Settings → Privacy & Security**. macOS may require a quit/reopen after changes. No permission database is edited, no system prompts are bypassed, and no elevated command is used. Signed builds must be exercised on a Mac to verify permission attribution to the app and its child tools.

Withdrawing an already granted Accessibility/Screen Recording permission while running stops control and resets the native approvals when the status check detects it. The companion also relies on macOS enforcement for screen/input and Apple Events operations. Full Disk Access and Automation failures remain visible as task failures; they cannot be globally monitored through a public status API.

## Stop and Disconnect

**Stop** terminates the companion and its owned work. Your account’s local computer preference and accepted pairing remain; tasks stay local and offline until you explicitly start again. Swarm does not silently switch to a cloud computer when stopped or quit.

**Disconnect** stops the process, calls `DELETE /api/computer/local`, removes the local Keychain grant, and returns only this account to the server’s default computer. It revokes that account’s local-device tokens, leaving cloud tokens alone. A failed DELETE is reported explicitly; retry after restoring connectivity. Stopping or deleting the local token alone cannot confirm server-side revocation.

The app also stops on logout/session-cookie changes, an account or server change, clearing local website data, a failed periodic account/server verification, permission withdrawal where detectable, an unexpected child exit, and app quit. A native observer watches WebKit cookies; identity/status is rechecked every three seconds, and native permissions every second. Network verification has a ten-second timeout. There is no automatic restart after a failure.

The bundled native supervisor gives the companion up to two seconds to finish graceful cleanup on Stop or Quit. If the companion hangs or exits with work left over, the supervisor stops its observed descendants, including detached shell and MCP processes, after verifying each PID, OS user and process birth time. External browsers attached through CDP are not owned descendants and remain open. Native Quit waits for supervisors that are already stopping, with a four-second outer deadline before hard termination. Supervisor parent monitoring and the companion’s parent-PID check also trigger cleanup if the app exits unexpectedly. Completed effects cannot be undone; services deliberately launched outside the observed process tree remain subject to normal OS behavior.

## Authentication and tokens

Native API requests read the existing HttpOnly `swarm_session` from `WKHTTPCookieStore`; no token is requested from web JavaScript. Requests accept only the configured origin, refuse redirects, do not use the shared URLSession cookie jar, and recheck the cookie after responses. `/api/auth/me` identifies the current account before pairing and again after a new grant. Native approval binds to origin, account ID, and the in-memory session fingerprint.

The remembered pairing grant and consent are stored together in Keychain, scoped by normalized origin and account ID, accessible only while this device is unlocked. They are never stored in UserDefaults, URLs, logs, or process arguments. A random directory with mode `0700` contains a single exclusive mode-`0600` token file for the child handoff. The child may unlink it after reading; the app removes it after connection, Stop, or exit. Clearing website data deletes the Mac-control Keychain entries as well. Context/session changes discard the currently scoped local grant. App quit preserves an accepted grant for a future explicitly approved Start.

`POST /api/computer/local/pair` sends `{ "desktop": true }` and explicitly selects local mode for the signed-in account. Unused grants expire after ten minutes; a grant accepted by a first companion connection remains valid until revoked. Pairing may return HTTP 409 while computer tasks are running; wait for them to finish. GET `/api/computer/local` provides the selected preference and connection/capability status. The companion receives `--desktop --local-device` and connects through `/api/companion/local`, separately from the cloud computer transport.

No generic JavaScript-to-native shell bridge or inbound remote-control listener is installed. Explicit CDP attachment uses the companion’s private loopback relay to pin its approved upstream endpoint. Only the native consent UI starts the companion. It receives an explicit environment with the real OS user’s HOME and login shell, its bundled Node in PATH, and no inherited Node/DYLD injection options or app credentials. Companion stdout/stderr are discarded so tokens and task data are not written to app logs; the native window reports exit status and recovery guidance.

## Browsers

For managed browser mode, install Google Chrome or Chromium in `/Applications` (Chrome may also be in `~/Applications`). The app checks this requirement before pairing; explicit CDP attachment does not require another local Chrome installation. Playwright uses a separate persistent managed Chrome profile; it does not copy cookies from your everyday profile or reopen it behind your back. Desktop permission and the native browser approval allow bots to interact with whatever browser you have visibly open, including signed-in websites.

The native **Advanced: attach Playwright to an existing browser** section accepts an optional CDP endpoint and requires a separate explicit approval for that browser and its signed-in tabs. An empty field keeps managed Chrome. The endpoint must use http(s) or ws(s) on literal `127.0.0.1`, `[::1]` or `localhost`, without credentials, query, fragment, whitespace or backslash. Native validation pins localhost to `127.0.0.1`; the companion validates the discovered WebSocket endpoint and refuses redirects. Native additionally rejects port zero and noncanonical loopback aliases.

Only an explicitly entered, approved endpoint is passed as `--browser-cdp`. Endpoint and attachment approval stay in memory and are cleared on account/session/server changes. Changing them stops in-flight control. The user must supply an already-running debuggable browser; Swarm does not enable debugging, start/restart that browser, or copy its profile. Stop detaches Playwright and leaves the external browser open. Keep debugging endpoints private because they expose browser control. Playwright dependencies are bundled, and no `npx` or dependency install occurs when a bot calls a browser tool.

## Build an installable Mac app

The `Swarm-macOS` target is an unsandboxed, hardened-runtime app for direct Developer ID distribution. It is not a Mac App Store sandbox build. The iOS target, entitlements, authentication, App Intent, and voice behavior remain unchanged.

Normal builds and policy tests stay offline:

```sh
scripts/apple.sh macos
scripts/apple.sh ios
scripts/apple.sh test
```

Those development builds need no staged payload. If the complete runtime is absent, **Approve and start** reports an actionable missing-runtime error; chat, authentication and voice remain usable.

Packaging requires a build machine with Node 22+, npm, Xcode and its command-line tools. XcodeGen is optional when using the checked-in project. Run from the repository root:

```sh
# Explicit network step; supports --arch arm64 or --arch x64 too.
scripts/package-apple-mac.sh stage --arch universal

# Later staging may reuse both downloaded runtime archives and npm’s cache.
scripts/package-apple-mac.sh stage --arch universal --offline

# This step uses the staged payload and does not download dependencies.
scripts/package-apple-mac.sh build universal
```

`apple/MacControl/node-runtimes.json` pins official Node 22.23.4 Darwin archives and their SHA-256 checksums for Apple silicon and Intel. The staging script downloads only from `https://nodejs.org/dist`, refuses redirects, and verifies the committed checksum before extraction, including on cache reuse. Review official SHASUMS and update both pins deliberately when upgrading Node. `apple/MacControl/package-lock.json` pins `@playwright/mcp` 0.0.85 and its dependency integrity hashes. Staging uses `npm ci --ignore-scripts`; browser downloads are disabled. No dev toolchain is required on the installed Mac.

The payload goes under the gitignored `apple/build/MacControlPayload`, and the resulting app is `apple/build-distribution/Build/Products/Release/Swarm.app`. `build` checks runtime/source/lockfile consistency, copies the payload into app resources, and compiles a small supervisor for each architecture that launches the companion and performs bounded cleanup of its observed descendants. Missing cache, checksum mismatch, npm failure, stale source, missing browser, runtime launch failure and backend/API incompatibility are reported explicitly.

For a review build, an Apple Development identity can sign the known Node/launcher executables and the main app with the same entitlements; that build is only for local development. The production signing command deliberately requires Developer ID. Before distributing, sign the complete app with your own Developer ID identity:

```sh
scripts/package-apple-mac.sh sign \
  apple/build-distribution/Build/Products/Release/Swarm.app \
  'Developer ID Application: Your Organization (TEAMID)'
```

The script signs the bundled Node binaries with JIT entitlements, signs the launcher, signs/seals the main hardened app, verifies signatures, and produces a zip. The main app retains Apple sign-in and microphone entitlements and declares Apple Events usage. Supply any provisioning profile needed by your Apple sign-in configuration. Credentials and profiles are not included.

Submit the zip with your own `xcrun notarytool submit --keychain-profile ... --wait`, staple the accepted app with `xcrun stapler staple`, and recreate the final zip with `ditto -c -k --keepParent`. Validate Gatekeeper with `spctl --assess --type execute --verbose=2`. Run the installed signed app from Applications and validate its privacy prompts. No signing, notarization, installation or publication occurs automatically.

## Validation

Native policy tests cover all four consent gates, explicit CDP attachment approval and endpoint rejection, origin/account/session boundaries, pairing-origin rejection, local-only child flags and token-file handoff, invalid tokens, private directory/file modes, and cleanup. Packaging can be checked without downloads using:

```sh
node --check scripts/stage-apple-mac.mjs
bash -n scripts/apple.sh scripts/package-apple-mac.sh
node scripts/stage-apple-mac.mjs --check --arch universal
```

Before release, run both platform builds and Mac policy tests, then test a signed packaged app: terminal/Playwright before desktop approval, each OS privacy prompt, screenshot/click/typing, managed browser persistence, explicit attachment to a separately started loopback browser and detach without closing it, Stop during a running command, Disconnect, logout, account switch, server switch, clear data, permission withdrawal, network loss and quit. Also repeat Apple/Google/phone sign-in and voice on Mac and the existing iPhone Action Button flow on device. Cloud static checks cannot establish macOS TCC behavior, Xcode compilation or notarization.
