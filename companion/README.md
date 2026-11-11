# Local desktop browser control

`swarm-companion.mjs` is still a self-contained Node.js 22+ script. Legacy browser-only installs and Linux `--multi` VMs continue to use `/api/companion`. The native Mac app launches its bundled Node through the native supervisor:

```sh
/path/to/bundled/control-host \
  /path/to/bundled/node /path/to/swarm-companion.mjs \
  --desktop --local-device \
  --server https://your-swarm-server.example \
  --token-file /path/to/private-token-file \
  --parent-pid 12345 \
  --playwright-mcp /path/to/playwright/node_modules/@playwright/mcp/cli.js
```

The token file should be owned by the signed-in user and mode `0600`. The companion reads it once; native may remove it after successful connection. Native owns account consent, token scope, and revocation. No token belongs in command arguments or logs.

`--local-device` requires `--desktop` and refuses `--multi`. It selects `/api/companion/local`, allowing the same account's cloud companion to stay connected independently. Desktop shell commands run as the signed-in user, in that user's home folder.

## Bundled dependencies

Bundle Node 22+, the companion script, and the complete pinned `@playwright/mcp@0.0.85` dependency tree. Run MCP with the same `process.execPath` that runs the companion; no external Node lookup, npm install, or `npx` runs during an action. For managed browser mode, Chrome or Chromium must already be installed; `--chrome` or `CHROME_PATH` can choose its executable. Explicit CDP attachment uses an existing browser endpoint and does not require another local Chrome installation.

MCP lookup uses `--playwright-mcp`, then `PLAYWRIGHT_MCP_CLI`, then adjacent `node_modules`, the running Node's resource directory, `playwright/node_modules` in that directory, and the existing Linux global locations. An explicit missing path disables browser capability and returns an actionable error; desktop and shell remain available. Standard native layout works with Node at `MacControl/<arch>/node`, the script at `MacControl/companion/swarm-companion.mjs`, and MCP at `MacControl/playwright/node_modules/@playwright/mcp/cli.js`.

Inherited `PLAYWRIGHT_MCP_*` settings are removed from the MCP child's environment. They cannot silently enable existing-browser attachment, select another profile, make the browser headless, or expose an HTTP listener. The CLI path is resolved before this sanitization.

## Browser behavior

Structured `browser_*` tools launch a separate headed Chrome per Bot, with a persistent profile under `<data-dir>/desktop-browser-profiles/<botId>`. The default data directory is `~/.swarm-companion`. Chrome uses a private debugging pipe. Reset, idle cleanup, and shutdown retain the profile for later sessions. Profiles and MCP output can contain private browsing data and should stay in the app's local data directory.

The supported tool names and arguments match `server/src/computers/browser-tools.ts` and the cloud VM RPC contract, including snapshots, form filling, tabs, uploads, dialogs, screenshots, evaluation, and console messages. Desktop approval includes local filesystem access, so uploads can use the same files as the shell. Page-changing actions return the associated accessibility snapshot inline. `open` continues to open a URL in the everyday default browser; approved desktop click/type can interact with that browser.

Existing-browser attachment requires the explicit `--browser-cdp URL` flag. In the native **Use this Mac** window, the advanced endpoint field and a separate attachment approval supply this flag; leaving the field empty keeps managed Chrome. All four native access approvals still apply. Environment settings never enable attachment. The supplied endpoint must already exist and use `http`, `https`, `ws`, or `wss` on `127.0.0.1`, `localhost` (pinned to `127.0.0.1`), or `[::1]`, without credentials, query, or fragment. HTTP discovery and advertised WebSocket URLs are validated; HTTP and WebSocket redirects are refused. A temporary relay listens only on loopback behind an unguessable path while attached. The companion never relaunches the default browser with debugging, imports cookies, or copies an existing profile. It does not enable the Playwright extension automatically.

Close/reset disconnects an external browser client without sending a browser-close command or terminating the user's browser. Explicit page actions, such as closing a tab, still act on the attached browser.

## Wire contract

Hello includes the existing `mode: "desktop"`, `desktop: true`, `headless: false`, and:

```json
{ "capabilities": { "shell": true, "browser": true } }
```

`browser` is false when the pinned MCP CLI cannot be found. The server should select the local route using its account preference and token scope, and expose browser tools only when advertised.

Browser requests and replies use the existing cloud naming:

```json
{ "id": 1, "method": "browser", "params": { "botId": "bot-id", "tool": "browser_navigate", "args": { "url": "https://example.com" } } }
{ "id": 1, "result": { "content": [], "isError": false, "captcha": null } }
```

`captcha` returns `{ "captcha": null | { "kind", "url", "title" } }`. It does not launch a browser when none is open. `close` stops that Bot's local commands and closes its managed browser or detaches its external browser. Tool/RPC errors use the existing `{ "id", "error": "message" }` envelope.

## Permissions and lifecycle

Enable **Swarm** in System Settings → Privacy & Security → **Accessibility** and **Screen & System Audio Recording** (Screen Recording on older macOS). Quit and reopen Swarm after granting Screen Recording. A manually launched companion instead needs permissions attributed to its launching app, such as Terminal. The native control window displays their status and provides request buttons; companion preflights them and reports the corresponding guidance. Preflight failures and denied permissions never block shell/browser startup. Screen capture explicitly binds the CoreGraphics preflight symbol through JXA and fails closed unless permission is confirmed. The companion does not try to grant permissions itself.

Mac click/key input uses CoreGraphics via JXA. Text uses clipboard paste, restoring the previous clipboard text in a `finally` block, so Unicode and non-US keyboard layouts work without adding an Automation permission for System Events. Non-text clipboard formats are not preserved. Other shell-driven app automation can independently require Automation or Full Disk Access, which macOS enforces.

Disconnect invalidates pending desktop input and queued commands, kills active local shell/desktop process groups, and closes managed browser/MCP descendants. Replies from a revoked connection are suppressed. Temporary network loss reconnects only after browser cleanup; token rejection/revocation exits. The `--local-device` parent check runs every 500 ms. The native app also stops control on Stop, account changes, detected withdrawal of a previously granted Accessibility or Screen Recording permission, and Quit. Closing its windows alone does not quit the menu-bar app.

The packaged native supervisor gives the companion up to two seconds for graceful cleanup. If it hangs or exits with work left over, the supervisor stops observed descendants, including detached shell and MCP processes, after checking their PID, OS user and process birth time. The app waits for cleanup on Quit, including an earlier Stop still in progress, with a four-second outer deadline before hard termination. External CDP browsers are not owned descendants and remain open. Completed effects cannot be undone; services deliberately launched outside the observed process tree remain subject to normal OS behavior.

## Verification

From the repository root:

```sh
node --check companion/swarm-companion.mjs
node --test companion/tests/*.test.mjs
node tests/vm-performance.mjs
# On macOS, read-only JXA binding and permission probes:
node companion/tests/mac-permissions.mjs
```

Focused unit checks run without Mac permissions. Linux integration uses the installed pinned MCP, real Chrome, Xvfb, xdotool, and ImageMagick. It tests managed browser persistence, local file upload, explicit external attachment, revocation, reset, parent death, reconnect, and legacy standalone/browser/cloud routes. Actual macOS TCC attribution, screen capture, keyboard input, and native packaged runtime launch require validation in the signed Mac app.
