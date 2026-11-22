# Swarm master fix PRD

Prepared 22 Nov 2026, 15:00 (UTC+4, Dubai) for an autonomous coding coordinator and its agent team. This file is self-contained: every item below has a repro, the expected and actual results, a verified root cause with file:line, fix instructions, acceptance criteria and a suggested test. Implement every MF item, open one PR, merge it, deploy it and verify it live.

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Branch / commit tested | `main` @ `2a57860c821ee9bde96497507802d18cc4827f5d` (merge of PR #72, "ui/login-refinement-20261122") |
| Live app | https://swarm-team.fly.dev (Fly app `swarm-team`, `SWARM_ROLE=standalone`, `COMPUTER_PROVIDER=cloudvm`) |
| Live build | `GET /api/version` revision `2a57860...` built 22 Nov 2026 10:24 (UTC+4). The live app is exactly the tested commit. |
| Stack | `web/` React + Zustand SPA (no router), `server/` Hono + SQLite, SSE (`/api/events`), Composio for Google sign-in and apps, noVNC viewer |
| Static checks at baseline | `npm ci && npm run typecheck` passes with 0 errors (server and web) |

All line numbers are against the commit above. Line numbers may drift by one or two lines; search for the quoted code if a line does not match.

---

# 1. Summary

## 1.1 Scope

A full user-style QA pass of the live app, plus a code review of the repo, run on 22 Nov 2026 between about 12:30 and 14:55 (UTC+4):

1. Morning baseline walk of 33 surfaces (11 bugs, 8 decisions).
2. Feature map built from the code: 113 features across sign-in, shell, bots, chat, details, computer viewer, bot settings, tasks and work area, settings, connect apps and backend surfaces.
3. Live, user-style testing of those features in a real signed-in browser session (parts A, B, C1, C2), using throwaway bots `QA-Temp-1`, `QA-Temp-2` and group `QA-Temp-Group`.
4. Unauthenticated backend smoke tests with `curl` (health, version, scripts, SSE, voice, auth, headers, CORS, cache).
5. Code-level review: 26 defects (D-01 to D-26), of which 22 are confirmed, 2 are partially confirmed and 1 is mixed. Every live bug was traced to code by the author of this file.

## 1.2 Counts by severity (deduplicated)

| Severity | Meaning | Count |
|---|---|---|
| P0 | Security, privacy, data loss or data integrity | 9 |
| P1 | Broken core flow a normal user hits | 13 |
| P2 | Wrong behaviour with a workaround, or a confusing state | 22 |
| P3 | Polish, copy, docs, dead code | 22 |
| **Total** | | **66** |

Plus 12 product decisions in section 3, each with a recommended default the coordinator should implement unless told otherwise.

## 1.3 Test coverage

**Tested live in the browser (PASS unless an MF item says otherwise):** brand and Your bots page, sidebar collapse (button and Ctrl+B), search (Ctrl+K), Tasks island, primary tile, bot rows, usage meter, account menu, connect apps button, keyboard shortcuts, theme, create bot, import (disabled without a file), group chat create and send, group members, bot chat send, stop, new conversation (three entry points), model picker, effort, fast, dictation, live voice call, question card, connect card (Skip), approval card (deny), computer use through chat, exchanges, details panel (all tabs), setup tab, history, computer viewer (watch, take control, wake), bot settings (General, Skills add and archive, Memories, Routines, Learning, Analytics 7/30/90), Escape handling, Tasks tab, Team board, Goals (create without starting, stop, resume), Workflows (new form, cancel), Saved reports, Daily synopses, Routines (Quinn), Settings (General, Account, API keys, Computer, Messaging, Permissions, Connected apps, MCP, Models and access, Learning, Usage), Connect apps modal (Notion connect abandoned, Gmail disconnect then Cancel), `/join/<bogus>`, deep links `#settings/<x>` and `/?screen=<id>`, sign-in page (signed-out view).

**Tested by curl only (no session):** `/api/health`, `/api/version`, `/api/companion/script`, `/api/cli/script`, `/api/events` (401), `/api/voice/*` (401), `/api/auth/me`, malformed JSON on public endpoints, unknown routes, `/api/join/<bogus>`, `/build.json`, security headers, CORS preflight, cache headers, HEAD requests.

**Code review only (not reproduced live):** D-02 to D-10 input validation on authenticated routes (curl had no session by design), D-11 computer ensure errors, D-21 logout error path, D-22 localStorage scoping, D-24 MCP stdio on the shared host, B-02 slow Google consent sweep (needs an 11 minute wait on a real login), authenticated SSE `hello` and `ping` frames.

**Not tested, and why:**

| Feature | Reason |
|---|---|
| Log out and sign back in (F-011) | Ends the real owner session; deferred to the very end with approval |
| Delete account (F-016) | Permanent; only the confirmation dialog was opened |
| Phone SMS sign-in and text-first sign-in (F-002 to F-004) | Sends a real SMS; needs a test phone |
| Apple and OpenRouter sign-in (F-005, F-007) | Third-party accounts; only button visibility checked |
| Link Google or Apple (F-015) | Changes real sign-in methods |
| Activate a real coworker setup, Make primary on an active bot (F-103) | Changes the owner's real team |
| Deleting real bots (F-104 on non-test bots) | Destroys real data |
| Inkbox webhook (F-153) | Inbound texts; must not be called |
| Offline composer error (F-070) | Needs a network cut on the shared box |
| Approving the Slack send on QA-Temp-2 | Would post to a real external workspace |

## 1.4 Test data left in the account (do not delete real data; the coordinator may ignore these)

`QA-Temp-1`, `QA-Temp-2`, `QA-Temp-Group`, goal "QA goal" (stopped; cannot be deleted, see MF-044), archived skill "QA skill", an abandoned Notion connect attempt, a denied Slack approval on QA-Temp-2.

## 1.5 Evidence

Screenshots live on the QA box, not in the repo. They are named by id below. Folders: `/tmp/computer-use/sand-subagent-24cbefc2-*.webp` (part C2), `/tmp/computer-use/sand-subagent-b383ee9a-*.webp` (part C1), `/tmp/computer-use/sand-subagent-6b6d1a52-*.webp` (part B), part A screens (`sand-subagent-1f4c441e-*`) were lost in a box restart and are cited by id only. Morning walk screens: `/workspace/startup-qa-bot/runs/20261122/screens/<name>.webp`. Raw curl dumps: `/tmp/swarm-qa-backend/`.

---

# 2. Fix list

Format for each item: severity, area, user impact, repro, expected, actual (verbatim UI text where available), evidence, root cause (file:line), fix, acceptance criteria, suggested test.

## P0: security, privacy, data

### MF-001 Public `/api/health` discloses model, provider and key presence
- **Severity:** P0. **Area:** server, public API. **Source:** D-20, live curl.
- **User impact:** Anyone on the internet learns which LLM provider and model this deployment uses, whether a direct key and an OpenRouter key are configured, the computer provider and feature flags. The response is also cacheable.
- **Repro:** `curl -s https://swarm-team.fly.dev/api/health` with no cookies.
- **Expected:** `{"ok":true}` only, with `Cache-Control: no-store`.
- **Actual:** `{"ok":true,"provider":"openrouter","model":"x-ai/grok-4.7","computers":"cloudvm","desktop":false,"direct":false,"openrouter":true,"apps":true,"features":{"botCreation":true,"botSetupVersion":2,"guidedSetup":true,"messaging":true}}`, no `Cache-Control`.
- **Evidence:** `/tmp/swarm-qa-backend/` health dump; backend-results F-150.
- **Root cause:** `server/src/tenant-app.ts:73` returns env-derived config on an unauthenticated route.
- **Fix:** Public `GET /api/health` returns `{ ok: true }` and sets `Cache-Control: no-store`. If any client reads the extra fields, grep `web/src` and `companion/` for `/api/health` consumers; move the details to an authenticated route (for example `GET /api/health/details` behind `requireUser`) and update the consumers. Do not include key booleans in any response that a non-owner can read.
- **Acceptance:** Unauthenticated `GET /api/health` body is exactly `{"ok":true}` and has `cache-control: no-store`. The app still boots and every feature that used the old fields still works when signed in. `npm run verify:deployment` (if it reads health) still passes.
- **Test:** Add a server test that boots the Hono app and asserts the health body keys equal `["ok"]` and the header is present.

### MF-002 Missing baseline security headers on the HTML shell and public API
- **Severity:** P0 (hardening). **Area:** server. **Source:** backend-results section 3.
- **User impact:** The app can be framed (clickjacking), MIME sniffing is possible, no HSTS, no CSP, and `Server-Timing` leaks handler timing on public routes. `/api/auth/me` is cacheable.
- **Repro:** `curl -sI https://swarm-team.fly.dev/` and `curl -sI https://swarm-team.fly.dev/api/auth/me`.
- **Expected:** `Content-Security-Policy` (with `frame-ancestors 'none'` or `'self'`), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options`, and `Cache-Control: no-store` on every `/api/*` JSON response.
- **Actual:** All missing on `/`, unknown HTML paths, `/api/health`, `/api/auth/me`, `/api/version` and the scripts (only `/api/auth/native/exchange` has `Referrer-Policy`). `/api/health` and `/api/auth/me` have no `Cache-Control`.
- **Root cause:** `requestBoundary` in `server/src/security/request.ts:8-12` sets nosniff, referrer policy and no-store, but it is only applied via `requireUser` (`server/src/lib/auth.ts:100`) and platform routes, not in `server/src/tenant-app.ts` for public `/api/*` (`:66-90`) or the static HTML (`:114-125`). `Server-Timing` is added for all `/api/*` at `tenant-app.ts:66-70`.
- **Fix:**
  1. In `tenant-app.ts`, add a public header middleware on `/api/*` that sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` unless the handler already set a cache header. Do not add the cross-site 403 check to public GETs (scripts and health must stay fetchable).
  2. On HTML responses (`/` and the SPA fallback) set `Content-Security-Policy` with at least `default-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'` plus whatever `connect-src`, `img-src`, `style-src`, `font-src` and `frame-src` the app needs (noVNC uses WebSockets to the relay; Composio and OpenRouter use popups and redirects, not frames). Build the allowlist by checking `web/src` for external hosts. Start in `Content-Security-Policy-Report-Only` only if a strict policy breaks the viewer; the PR must ship an enforced `frame-ancestors` either way.
  3. Set `Strict-Transport-Security: max-age=31536000; includeSubDomains` on all responses in production.
  4. Only emit `Server-Timing` for authenticated requests.
- **Acceptance:** `curl -sI` on `/`, `/api/health`, `/api/auth/me`, `/api/version` shows the headers above. The signed-in app, the computer viewer, Google sign-in, app connect popups and live voice all still work on the deployed build.
- **Test:** Server test asserting the headers on `/`, `/api/health` and `/api/auth/me`.

### MF-003 `PATCH /api/bots/:id` accepts unvalidated fields and writes them non-atomically
- **Severity:** P0 (data integrity). **Area:** server API. **Source:** D-02, D-03 (confirmed in code).
- **User impact:** A buggy client or a crafted request can store an empty name, a 10 KB label, `mode:"admin"`, or a non-scalar (which makes SQLite throw a 500 halfway through). A failure in the middle leaves a half-applied edit. Create caps the label at 40 while edit allows 60.
- **Repro:** Signed in, `PATCH /api/bots/<id>` with `{"name":"","label":"<10000 chars>","mode":"admin"}`; then `{"name":"x","voice":{"a":1}}`.
- **Expected:** 400 with a field error; nothing written.
- **Actual (code):** All fields are written; an object value throws inside the loop after earlier fields were already updated.
- **Root cause:** `server/src/routes.ts:214-242`: only `model`, `effort`, `fast` and `expectedInstructions` are validated (`:218-231`); fields are updated one `UPDATE` at a time with no transaction (`:233-237`). `server/src/bots.ts:59-61` caps label at 40; `web/src/components/config/BotSettingsModal.tsx:176` lets the UI send 60.
- **Fix:** Create one zod schema (for example `botPatchSchema` in `server/src/bots.ts`) that is `.strict()` and covers every editable field with types, enums (`mode: 'personal'|'teammate'`, avatar shape and colour enums already used by create) and lengths (name 1..60 trimmed, label 0..40, description 0..300, instructions 0..8000, voiceSpeed numeric range). Reuse the same limits in `createBot`. Parse the body with the shared JSON helper from MF-014, return 400 on failure, then apply all updates plus the setup revision logic from MF-013 inside one `db.transaction`. Make the UI label cap match (40) in `BotSettingsModal.tsx:176`.
- **Acceptance:** Invalid payloads return 400 and the row is unchanged. Valid partial patches still work from the composer, voice settings and bot settings. Typecheck passes.
- **Test:** Server test: invalid name, oversize label, unknown mode, object value, unknown key, each returns 400 with no DB change; a valid patch returns 200.

### MF-004 Group chat replies leak to 1:1 chats and to an external app (Slack)
- **Severity:** P0 (data goes to the wrong place, including an attempted external send). **Area:** group chats, agent loop. **Source:** live part B, part C2.
- **User impact:** A message sent in a group is answered in each bot's private chat instead of the group. One bot tried to post the group reply to Slack, which would have sent content to an external workspace. The user sees an empty group.
- **Repro:**
  1. Create two new bots from the UI (they start in setup interview mode, see MF-010).
  2. Create group `QA-Temp-Group` with both.
  3. Send "QA ping" in the group.
- **Expected:** Each responding bot's reply appears in the group transcript, or the bot stays silent. Nothing is sent outside Swarm without an explicit request.
- **Actual:** QA-Temp-1 replied in its own 1:1 chat: "I'll answer the group ping briefly." QA-Temp-2 queued an approval card for Slack: tool `SLACK_SEND_MESSAGE`, arguments `{channel: "QA-Temp-Group", text: "QA-Temp-2 here."}`. The group stayed at "No messages yet" until reload.
- **Evidence:** C2 screen `4b3566b6` (Slack approval card), part B notes.
- **Root cause (verified):**
  1. `server/src/agent/rooms.ts:93-121` `dispatchRoomMessage` enqueues a `system` trigger on each member's own bot id and relies on the model calling `post_to_group`. Any plain assistant text is appended to the member's own transcript.
  2. Bots in setup interview mode do not get `post_to_group` or `stay_silent` at all: `server/src/agent/tools.ts:634-636` `allowedDuringSetup` only allows `ask_user`, `save_agent_setup`, `get_platform_state`, `list_app_connections`, `search_apps`, `request_app_connection`, `SWARM_APPS_SEARCH`, `SWARM_APPS_EXECUTE`. With no group tool available, the model reached for the Slack app tool through `SWARM_APPS_EXECUTE`.
  3. Rooms accept members that are still configuring: `server/src/routes-rooms.ts:29` and `:42` only exclude rooms and hidden bots.
- **Fix:**
  1. Carry the room id on the trigger (`trigger.roomId`) in `dispatchRoomMessage`. In the loop, when a turn with `roomId` ends with final assistant text and no `post_to_group` call, post that text to the room via `postToRoom` instead of the member's transcript (or append it to the room with the member as `from`). Mark the member-side row `audience: 'internal'` so it does not show in the 1:1 chat.
  2. Allow `post_to_group` and `stay_silent` during setup when the trigger has a `roomId`, or skip configuring members in `dispatchRoomMessage` and post a notice in the room: "<name> is still being set up and can't answer in groups yet."
  3. For room-triggered turns, deny external send tools (any `SWARM_APPS_EXECUTE` whose slug is not read-only) unless the user's group message explicitly asks for an external action. Simplest safe rule: room turns get read-only app access (`readOnlyApps: true`).
  4. In `routes-rooms.ts` create and member update, return 400 for bots whose setup is not active, with the message "Activate <name> before adding it to a group."
- **Acceptance:** In a group of two active bots, "ping" produces replies only in the group transcript. A configuring bot cannot be added (400 with the message above), or if already a member it does not reply privately. No approval card for an external app is created from a group turn that did not ask for one.
- **Test:** Server test with the mock provider (`tests/mock-provider.mjs`): mock model returns plain text for a room-triggered turn; assert the text lands in the room rows and not in the member rows. Second test: adding an interviewing bot to a room returns 400.

### MF-005 Approval card names an app account that is not connected
- **Severity:** P0 (misleading consent surface). **Area:** approvals, connected apps. **Source:** live part C2.
- **User impact:** The user is asked to approve a Slack send on an account the app says is not connected. Approving it either fails or uses an account the user does not see in Settings, so consent is not informed. Raw ids are shown instead of account names.
- **Repro:** Settings > Connected apps shows only Gmail; the Connect apps modal shows Slack with a "Connect" button. Trigger MF-004 on a setup-mode bot.
- **Expected:** No approval card for an app with no ACTIVE connection; the bot gets a tool error such as "Slack is not connected" and can show a connect card instead.
- **Actual:** Card body: "Account: ca_KIxihCKrE-D2 / Tool: SLACK_SEND_MESSAGE / {channel: QA-Temp-Group, text: QA-Temp-2 here.}".
- **Evidence:** C2 screen `4b3566b6`, `9e04a3d5` (Connected apps shows raw id `ca_pESfPrEqcgnN`).
- **Root cause (verified):** `server/src/agent/loop.ts:588-603` creates the approval card from the model-supplied `args` before checking that `args.connectionId` belongs to an ACTIVE connection of the user. `executionPolicyFor` (`server/src/agent/tools.ts:687-717`) only looks up the connection to decide read-only status; when it is not found it falls through to `'ask'`. `describeArgs` (`loop.ts:880-888`) prints the raw `connectionId`.
- **Fix:** Before creating an approval for `SWARM_APPS_EXECUTE`, resolve `args.connectionId` against `connectionsDetail(userId)` filtered to `status === 'ACTIVE' && !isDisabled` and matching the slug's toolkit. If it is missing, do not create a card; return a tool output "The <App> account in this request is not connected. Use request_app_connection to ask the user to connect it." In `describeArgs`, show the app name and the account's display label (email or workspace name if Composio provides it; else "Connected <App> account") instead of the raw id. Also hide the raw id in Settings > Connected apps (`web/src/components/config/AppSettings.tsx:844`), keep it in a tooltip or "Details" only.
- **Acceptance:** A tool call with a connection id that is not ACTIVE for this user never produces an approval card. Cards and Settings show no `ca_` ids in visible text.
- **Test:** Unit test on the loop policy branch with a fake `connectionsDetail` returning no Slack account; assert no `approvals` row is inserted and the tool output mentions "not connected".

### MF-006 Bots use their cloud computer (browser, shell as root) with no approval and no disclosure
- **Severity:** P0 (consent and transparency). **Area:** approvals, Settings > Computer, Permissions. **Source:** live part A (F-064), part C2.
- **User impact:** The user asked Quinn to open example.com and it did so with no approval card. Settings > Permissions says "Nothing here yet. When you choose "Always allow" on an approval, it shows up here." and Settings > Computer only talks about a Mac app, so the user has no idea a cloud computer exists or that it runs without asking.
- **Repro:** In Quinn's chat send "use your computer to open example.com and tell me the page title". Then open Settings > Permissions and Settings > Computer.
- **Expected:** Either an approval card before the first computer action, or clear disclosure that the bot's own cloud computer runs without approval, plus a control to require approval.
- **Actual:** The action ran with no card. Permissions: "Actions you've always allowed" is empty. Computer: "Use your Mac / Open Swarm on your Mac and go to Settings > Computer to approve and connect. / Mac app required".
- **Evidence:** Part A notes; C2 notes; screen ids in part A were lost.
- **Root cause (verified):** `server/src/agent/tools.ts:666`: `if (toolMap.has(toolName)) return { decision: 'allow', ... }`. Every built-in tool, including `computer_*`, `browser_*` and `shell` ("Run a bash command on your own Linux computer (as root)", `tools.ts:230`), is auto-allowed. This is by design for the sandboxed cloud VM (README line 302 says browser and shell actions are not covered by approvals), but the web UI never says so. `web/src/components/config/DeviceAccessSection.tsx:18-41` hard-codes Mac-only copy for every web user.
- **Fix:** Implement product decision PD-01 default:
  1. Settings > Computer on the web shows a "Cloud computer" card first: "Each Bot has its own cloud computer. Bots can browse and run commands there without asking. Connected app actions that change data still ask first." with the live computer state from `computers.state` and a link to watch it. Keep the Mac section below it, titled "Use your Mac (optional)".
  2. Add an account setting "Ask before Bots use their computer" (default off), stored in the existing settings store (`server/src/settings.ts`). When on, `policyFor` returns `'ask'` for `computer_*`, `browser_*` (except `browser_screenshot` style read tools) and `shell`, with the existing Allow / Always allow / Don't allow card and a policy key per tool family (`computer`, `browser`, `shell`) so "Always allow" appears in Permissions.
  3. Add a one-line notice in the chat the first time a bot uses its computer in a conversation: "Using its cloud computer" (this already exists as an activity label; make sure it is visible, see MF-011).
- **Acceptance:** Settings > Computer on the web describes the cloud computer. With the new setting on, the example.com request shows an approval card and "Always allow" adds a row to Permissions. With it off, behaviour is unchanged.
- **Test:** Unit test for `policyFor` with the setting on and off. UI test in `tests/device-access-ui.mjs` that the cloud card renders on web.

### MF-007 "New conversation" wipes the visible chat with no confirmation
- **Severity:** P0 (perceived data loss). **Area:** chat. **Source:** D-16, live part A.
- **User impact:** One click in the composer + menu or the bot-name header menu clears the whole visible conversation with no confirm. QA-Temp-1 now shows "No messages yet" while Analytics still counts 26 messages, so users believe their history is gone.
- **Repro:** In any chat, open the composer + menu and pick "New conversation". Repeat from the bot name dropdown in the header. Repeat from Bot settings > Start new.
- **Expected:** All three paths ask for confirmation ("Start a new conversation? The current chat will be cleared from view.") and then show the same toast. Old greeting rows from the previous generation are not shown.
- **Actual:** + menu: clears immediately, no confirm and no toast. Header menu: clears immediately, toast "Started a new conversation". Bot settings: confirm "Start fresh", but the old greeting with its old timestamp stayed visible.
- **Root cause:** `web/src/components/Composer.tsx:136,226` (no confirm, no toast); `web/src/components/ChatView.tsx:41-52,78` (no confirm, toast); `web/src/components/config/BotSettingsModal.tsx:212` (`ConfirmButton`). Server: `POST /bots/:id/fresh` (`server/src/routes.ts:319-325`) calls `clearConversation`.
- **Fix:** Create one shared hook, for example `web/src/lib/useFreshConversation.ts`, that shows a confirm dialog, calls `api.fresh`, and flashes a toast through a top-level toast portal (see MF-052). Use it from all three entry points. After success, drop all rows of older generations from the client transcript (the `cleared` SSE handler in `web/src/store.ts:197-203` already resets; make sure the Bot settings path also triggers it or reloads rows). Keep server behaviour (history stays in the DB and in memory/analytics) and mention that in the confirm text: "Past messages stay in memory and analytics but leave this view."
- **Acceptance:** Every entry point asks first; Cancel leaves the chat untouched; Confirm clears the view and shows the same toast; no stale greeting remains.
- **Test:** UI test (Playwright-style, like `tests/updated-ui.mjs`) clicking each entry point and asserting a dialog appears.

### MF-008 Any account can register stdio MCP servers on the shared host
- **Severity:** P0 (security review item). **Area:** MCP. **Source:** D-24 (mixed).
- **User impact:** On this shared standalone server any signed-in user can save an MCP server with `transport: 'stdio'` (a command line). Backend review found it should fail at connect because `SandboxMcpTransport` requires a tenant runner, but the save path is still open and the policy is implicit.
- **Root cause:** `server/src/mcp/routes.ts:37` hard-codes `canManage: true`; `server/src/mcp/store.ts:20-22,79-80` accept stdio; `server/src/mcp/client.ts:45-46` and `server/src/runtime/runner-client.ts:8-18` throw "Isolated tenant runner is unavailable. Local execution is disabled." when not a tenant.
- **Fix:** When `SWARM_ROLE=standalone` (no isolated runner), reject `transport: 'stdio'` on create and update with 400 "Command-based MCP servers need an isolated runner and are not available on this server. Use an HTTP MCP server." and hide the stdio option in `web/src/components/config/McpSettings.tsx`. Keep HTTP servers. Do not delete existing stdio rows; mark them disabled with that reason.
- **Acceptance:** On standalone, creating a stdio server returns 400; the UI does not offer stdio; existing HTTP servers still work.
- **Test:** Extend `tests/mcp.test.mts` with a standalone-role case.

### MF-009 No maximum message size on `POST /api/bots/:id/messages`
- **Severity:** P0 (cost and DoS on a shared server). **Area:** server API. **Source:** D-06.
- **Root cause:** `server/src/routes.ts:299-310` only checks non-empty.
- **Repro (code):** Post a 5 MB text body while signed in.
- **Expected:** 413 `{"error":"Message is too long (max 32,000 characters)."}`.
- **Fix:** Cap at 32,000 characters (match or stay under any existing composer limit; check `Composer.tsx`), return 413. Show the server error inline in the composer. Apply the same cap to room messages and card answers (`routes.ts:338-343` already caps answers at 100,000; lower it to the same value).
- **Acceptance:** Oversize posts return 413 and nothing is appended or enqueued. Normal messages work.
- **Test:** Server test for 32,001 characters returning 413 with no new row.

## P1: broken core flows

### MF-010 New bots are locked in a setup interview; normal chat and the draft card are unreachable
- **Severity:** P1. **Area:** bots, setup, chat. **Source:** live part A (F-044, F-067), confirmed on two fresh bots.
- **User impact:** Every bot created from the UI starts in "Setup interview" mode. Everything the user types, including normal tasks and answers to question cards, is treated as configuration. The bot rewrites its own description, saves answers as preferences and refuses ordinary work. The only exit is an "Activate agent" button the user has to find in the side panel. Many users will think the bot is broken.
- **Repro:**
  1. Create a bot "QA-Temp-2" from the UI.
  2. Ask: "Write me an unsent hello email draft."
  3. Separately, on another new bot, answer a question card with "blue".
- **Expected:** The user can chat with a new bot right away, or the setup state is obvious with a one-click way to finish or skip it. Answering a question card does not silently change the bot's role.
- **Actual:** QA-Temp-1 saved "blue" as a preference, rewrote its own description and replied "You asked for an unsent hello draft, not a send. I'll record that limit...". QA-Temp-2 never produced a draft card and ended with "Open Configuration in the side panel and select Activate agent. I cannot activate it myself."
- **Root cause (verified):**
  1. `server/src/routes.ts:145-152`: `POST /api/bots` calls `beginSetupInterview(bot.id)`; `server/src/bots.ts:74-77` saves every non-primary bot with status `'interviewing'`.
  2. `server/src/bot-setup.ts:233-236` `isConfiguring` is true until activation; `server/src/agent/tools.ts:634-641` removes every operational tool (drafts, send_to_bot, post_to_group, routines, computer) while configuring; `server/src/agent/loop.ts:563-570` denies them even if called.
  3. `server/src/agent/prompt.ts:36` instructs the model to keep the interview and send the user to "Configuration ... Activate agent".
  4. The chat header and composer show no setup state; activation lives only in `web/src/components/config/AgentConfiguration.tsx`.
- **Fix:** Implement PD-02 default:
  1. In the chat for a configuring bot, show a persistent banner above the composer: "<Name> is being set up. Answer a few questions, or start using it now." with two buttons: "Review and activate" (opens Details > Setup) and "Skip setup" (calls a new `POST /api/bots/:id/setup/skip` that saves the current brief with defaults for missing `workflows` and `action_boundaries` and activates it at the current revision, reusing `activateSetup` in `bot-setup.ts:355-370`).
  2. If the user's first message in a configuring bot is clearly a task, the bot must answer: "I'm still being set up. Tap Skip setup to start working now, or answer: <question>." Update `prompt.ts:36` accordingly, and never record a task request as an action boundary.
  3. Answers to question cards during setup are shown back to the user as "Saved to setup: ..." so changes are visible (an event row).
  4. Add the "Activate" action to the bot's own Setup tab for coordinator-created setups too (see PD-04).
- **Acceptance:** A new bot shows the banner. "Skip setup" activates it in one click and the next message "write an unsent hello email draft" produces a draft card. During setup, any change to the brief is shown as an event row.
- **Test:** `tests/bot-creation.test.mts`: create a bot, call skip, assert `onboarding_status='active'` and that `functionSchemas` includes operational tools.

### MF-011 Running indicator and stop button appear 20 to 40 seconds late; some replies only show after reload
- **Severity:** P1. **Area:** chat, agent queue, SSE. **Source:** live part A (F-033, F-055).
- **User impact:** After sending, nothing visible happens for up to 40 seconds, so users resend or think the app is frozen. Some replies only appeared after an unrelated action or F5 (2+ minutes).
- **Repro:** Send a message to QA-Temp-1 while Quinn or another bot of the same account is busy (or right after another bot finished a turn that triggers a learning review). Watch for the working avatar and the stop button.
- **Expected:** Within 1 second the chat shows "Queued" or "Working" and the stop button, and the reply streams in without reload.
- **Actual:** No indicator for 20 to 40 seconds; some replies only after reload.
- **Evidence:** Part A screens `98cad975` (reply only after reload), `7ea7acfb` (no running indicator after send).
- **Root cause (verified, plus one hypothesis):**
  1. `server/src/agent/loop.ts:156-176` `scheduleJob`: when no subscription CLI is selected, every job waits for `userQueues.get(userId)`, so all bots of one account run strictly one at a time, and each turn also awaits `beforeForegroundTurn` (`:171`). A message to bot B waits behind any turn of bot A.
  2. No live state is emitted while a job waits: `setLive(... isRunning: true ...)` happens only inside `runTurn` (`loop.ts:329`). The composer and avatar read only `live.isRunning` (`web/src/components/ChatView.tsx:27,64,89`, `Transcript.tsx:167`).
  3. Hypothesis for missing replies (verify): the SSE handler silently aborts a subscriber at 1000 queued events (`server/src/routes.ts:114`) and the client only resyncs rows on reconnect (`web/src/lib/events.ts:15-20,25-29`); a long stream of `rows`/`live` updates during streaming can hit that. Also check whether Fly's proxy buffers the SSE response (no `X-Accel-Buffering: no` / `Cache-Control: no-transform`).
- **Fix:**
  1. Emit a queued live state at enqueue time: in `enqueue` (`loop.ts:90-138`) after `acceptJob`, call `setLive(botId, { isRunning: true, activity: { kind: 'queued', since: now() }, startedAt: now() })` for user-facing triggers, and render "Queued behind <other bot>" or "Starting..." in the transcript with the stop button enabled (interrupt must cancel a queued job, see `interrupt` at `loop.ts:232-250`).
  2. Allow different bots of one account to run concurrently up to a small limit (for example 2 or 3 per account, configurable by env), keeping strict serial order per bot. If full concurrency is unsafe for usage accounting, at least let user-triggered turns bypass background turns (learning reviews, routines) in the user queue.
  3. In the SSE handler, raise the cap or drop stale `live` events for the same bot instead of aborting, set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, and on the client, when no event arrives for 45 seconds (pings are every 20 seconds), force a reconnect and resync.
  4. Client fallback: after sending, if no `rows` event for that bot arrives within 10 seconds, reload rows once.
- **Acceptance:** On the deployed app, sending a message shows "Starting..." or "Queued" plus the stop button within 1 second every time, and the reply appears without reload across 10 consecutive sends while another bot is busy.
- **Test:** Server test with the mock provider: enqueue on bot A (slow), then bot B; assert a `live` event for B with `isRunning: true` is emitted immediately. Client unit test for the 45 second watchdog in `tests/ui-store.test.mts`.

### MF-012 Tasks shows "You're all caught up" while items are waiting for the user
- **Severity:** P1. **Area:** Tasks. **Source:** morning walk B-01, live part B (F-023), part C1.
- **User impact:** The main "what needs me" view is wrong. Users miss setups to review, approvals and questions.
- **Repro:** Open the sidebar Tasks island. Then open Quinn's chat and QA-Temp-2.
- **Expected:** Tasks lists Quinn's two setup review cards (Lead Generation and LinkedIn Brand Manager, each "Needs your input") and QA-Temp-2's pending approval; the badge shows 3.
- **Actual:** "You're all caught up. No tasks are waiting for your input." All tasks 0, Pending 0, In progress 0, Done 0. Team board at the same time says "Waiting for your decision" and the sidebar says "Waiting for you: Slack".
- **Evidence:** `/workspace/startup-qa-bot/runs/20261122/screens/03-tasks.webp`; C1 screens.
- **Root cause (verified):** `web/src/components/config/TasksView.tsx:60-72` (`useTasks`), `:126-128` (counts), `:187-192` (`TasksIsland` badge) only read `GET /api/tasks`, which selects from the `tasks` table only (`server/src/routes.ts:423-426`). Setup reviews (`bot_setups.onboarding_status` in `interviewing` or `review`, rendered by `CoworkerSetupCards.tsx:71` only in the primary chat via `Transcript.tsx:225`), pending question, approval and connect cards in `rows`, and `live.awaiting` are never included.
- **Fix:** Add `GET /api/needs-you` (or extend `/api/tasks` with `include=attention`) that returns typed items: `setup_review` (from `bot_setups` where status is `review`, plus `interviewing` with a pending question), `approval` (pending `approvals` joined to bots), `question` and `connect` (pending cards in the current generation). Each item has `botId`, `title`, `createdAt` and a deep target (bot id plus row seq). Merge these into the `needs_input` bucket in `TasksView`, the island badge and `BotTasks`. Clicking an item opens that bot's chat scrolled to the card. Emit `tasks` hub events when cards and approvals change (approvals already emit at `loop.ts:601`; add it for card answer, setup status change and approval resolve).
- **Acceptance:** With the account state above, the badge reads 3 and the list shows the three items; resolving any one removes it within 2 seconds without reload.
- **Test:** Server test for the aggregate endpoint with one pending approval, one question card and one setup in review. UI check in `tests/tasks-layout.mjs`.

### MF-013 Any bot PATCH (model, effort, voice, pin) bumps the setup revision and breaks pending activations
- **Severity:** P1. **Area:** setup, bot settings. **Source:** D-05 (confirmed in code).
- **User impact:** Changing the effort with Ctrl+Shift+/ or pinning a bot invalidates an open coworker review: the card switches to "The configuration changed..." and activation by revision fails with 409.
- **Root cause:** `server/src/routes.ts:238-242` increments `bot_setups.revision`, rewrites setup files and emits `setup` on every successful PATCH. `CoworkerSetupCards.tsx:58,80` compares revisions.
- **Fix:** Only bump the revision and rewrite files when a brief-relevant field changed (`name`, `label`, `description`, `instructions`, `mode`), compared against the stored values. Do it inside the transaction from MF-003.
- **Acceptance:** Changing effort, model, fast, voice, voice speed, voice language or pin leaves `revision` unchanged and a pending review card stays valid; changing the name bumps it.
- **Test:** Server test asserting revision before and after each field type.

### MF-014 Malformed JSON on authenticated routes returns an unhandled 500
- **Severity:** P1. **Area:** server API. **Source:** D-04 (confirmed in code; curl could not reach it without a session).
- **Root cause:** `await c.req.json()` with no catch in `server/src/routes.ts:146` (POST /bots), `:217` (PATCH /bots/:id), `:302` (messages), `:329` (approvals), `:338` (card answer), `:388` (PATCH /routines/:id), `server/src/routes-rooms.ts:28,40`, and the workflow routes (`server/src/routes-workflows.ts` uses `c.req.json()` inside zod parse; a parse error throws before zod).
- **Fix:** Export one `readJson(c)` helper (model it on `body()` in `server/src/routes-knowledge.ts:17`) that returns 400 `{"error":"Invalid JSON body"}` on parse failure, and use it in every handler that reads JSON. Also add an `app.onError` in `tenant-app.ts` that maps `ZodError` to 400 with a short message and never leaks stack traces.
- **Acceptance:** Sending `{` to each listed route while signed in returns 400, not 500.
- **Test:** One parameterised server test over the listed routes.

### MF-015 First Google sign-in fails with Composio "Connected account ... not found" after a slow consent
- **Severity:** P1. **Area:** sign-in. **Source:** morning walk, B-02.
- **User impact:** A user who takes more than about 11 minutes on the Google consent screen (or has a second sign-in tab) lands on a Composio error page instead of Swarm. A retry works.
- **Repro:** Start "Continue with Google", wait 11+ minutes on the consent page (or start a second attempt in another tab), then approve.
- **Expected:** Signed in on the first approval, or a Swarm page "Your sign-in took too long. Start again." with a button.
- **Actual:** dashboard.composio.dev: "Connection failed: Connected account 'ca_C3RuAXUhO8IQ' not found (status=failed, appName=gmail)".
- **Evidence:** `/workspace/startup-qa-bot/runs/20261122/screens/33-composio-connection-failed.webp`.
- **Root cause:** `server/src/auth/google.ts:15` `TTL = 10 * 60_000`; the cleanup record expires at now + TTL + 60 s (`:133,140`). Every `/start` and a 5 minute interval run `sweepGoogleLoginAuthorizations()` (`:68-79,116-119,126`), which deletes the Composio connected account for any expired attempt (`releaseProvisional` to `deleteProvisionalAuthorizations`, `server/src/composio.ts:451-460`).
- **Fix:** Raise the TTL for the Composio branch to 30 minutes. In the sweep, skip attempts whose Composio account status is still `INITIATED` or `INITIALIZING` unless they are older than 60 minutes. Never sweep an attempt created by the same browser cookie in the last TTL window from a new `/start`. In the callback, map a missing or failed Composio account to `/?login=google_expired` with copy "Your Google sign-in timed out. Please try again." (add to `AUTH_ERRORS` in `web/src/components/SignIn.tsx`).
- **Acceptance:** A consent finished 15 minutes after start signs in. A second `/start` in another tab does not break the first.
- **Test:** Extend `tests/google-composio-auth.test.mts` with fake timers: start, advance 15 minutes, run sweep, complete callback, assert success.

### MF-016 Bot settings silently drops unsaved edits when switching tabs
- **Severity:** P1 (user data loss). **Area:** bot settings. **Source:** D-15, live part B.
- **Repro:** Open QA-Temp-1 settings > General, edit About, click Skills, click General.
- **Expected:** A prompt "Discard unsaved changes?" with Keep editing / Discard, or the draft is preserved.
- **Actual:** No warning; the edit is gone.
- **Root cause:** `web/src/components/config/BotSettingsModal.tsx:99` renders content with `key={tab}`, remounting `GeneralTab`, whose draft state lives inside it (`:131`).
- **Fix:** Lift the General draft state into the modal (or a small zustand slice keyed by bot id) so it survives tab switches, and show an "Unsaved changes" guard on Back, Escape and closing the page. Keep Save and Discard behaviour.
- **Acceptance:** Edit About, switch tabs and come back: text is still there. Press Escape with unsaved edits: guard appears.
- **Test:** UI test in `tests/bot-details-ui.mjs`.

### MF-017 Daily synopses and check-ins use UTC instead of the user's time zone
- **Severity:** P1. **Area:** proactive, reports. **Source:** B-06, live C1, D-25.
- **User impact:** A Dubai user's 09:00 synopsis runs at 13:00 local. Analytics days are UTC days.
- **Repro:** Tasks > Reports > Daily synopses.
- **Expected:** "09:00 · Asia/Dubai" (browser zone) with a way to change it.
- **Actual:** "Paused · 09:00 · UTC (UTC fallback: account timezone unavailable)".
- **Evidence:** `/workspace/startup-qa-bot/runs/20261122/screens/07-daily-synopses.webp`; C1 screens.
- **Root cause:** `server/src/proactive.ts:33-38` `defaultTimezone` reads `users.timezone`, which is only set by the agent tool `update_profile` (`server/src/agent/tools.ts:515-521` to `server/src/accounts.ts:145-147`). The web client never sends the browser time zone and Settings > Account has no time zone field. Copy from `web/src/components/config/SynopsesPanel.tsx:72`. Analytics hard-codes UTC: `web/src/components/config/BotAnalyticsTab.tsx:14,49,84,88`.
- **Fix:** On boot after `checkAuth` (`web/src/store.ts:101-108`), if `user.timezone` is null, send `Intl.DateTimeFormat().resolvedOptions().timeZone` to a new `PATCH /api/auth/me { timezone }` (validate with `Intl.DateTimeFormat` like `tools.ts:516`) and also update the proactivity row when its `timezone_source` is `utc_fallback`. Add a "Time zone" select in Settings > Account. Analytics buckets and labels use the account zone (server-side bucketing if the data is aggregated there; check `server/src/analytics.ts`).
- **Acceptance:** A fresh sign-in from a Dubai browser shows "09:00 · Asia/Dubai" with source "account"; changing the zone in Settings updates the synopsis line and analytics labels.
- **Test:** Server test for PATCH timezone validation and the proactivity update; extend `tests/native-synopsis.test.mts`.

### MF-018 Denied approval leaves "Waiting for you" in the sidebar and swaps the bot's avatar
- **Severity:** P1. **Area:** approvals, sidebar. **Source:** live part C2.
- **Repro:** On QA-Temp-2's Slack approval card click "Don't allow".
- **Expected:** Card shows "Not allowed"; sidebar preview and status clear; avatar unchanged.
- **Actual:** Card shows "× Not allowed", sidebar still "Waiting for you: Allow ...", chat header avatar switched from the orange bot icon to a Quinn-style icon.
- **Evidence:** C2 screen `5f636010`.
- **Root cause (verified):** Sidebar preview is computed from the last user-facing row, and for approval cards it is always "Waiting for you: <title>" regardless of status (`server/src/store.ts:19-24`). `resolveApproval` (`server/src/agent/loop.ts:891-906`) updates the card and enqueues a resume but does not clear `live.awaiting` or emit a `bot` update, so the stale state persists until the resume turn runs (which can be delayed by MF-011). The avatar swap needs investigation: check `BotAvatarFor` and `userFacingLive` in `ChatView.tsx:27,64` when `live` changes audience.
- **Fix:** In `store.ts` preview, only use "Waiting for you" for cards with `status === 'pending'`; for resolved approval cards use "Allowed: <title>" or "Not allowed: <title>". In `resolveApproval`, call `setLive(ap.bot_id, { awaiting: null, activity: null })` and `emitBot(ap.bot_id)` after the update. Fix the avatar so it always derives from the bot's own avatar fields.
- **Acceptance:** After Deny or Allow, the sidebar row updates within 1 second and the avatar does not change.
- **Test:** Server unit test for preview text by card status.

### MF-019 Computer wake errors are swallowed; the UI shows "Waking..." forever
- **Severity:** P1. **Area:** computer. **Source:** D-11.
- **Root cause:** `server/src/routes.ts:444-447` calls `computers.ensure(userId).catch(e => console.warn(...))` and returns immediately.
- **Fix:** On failure, store the error in the computer state and `hub.emit(userId, { type: 'computer', state })` so the UI renders `computer.error` (already supported at `web/src/components/config/AppSettings.tsx:492` and `AgentConfiguration.tsx:205`). Add a "Try again" button where the error shows.
- **Acceptance:** With a forced ensure failure (mock provider), the viewer and Settings > Computer show the error within 2 seconds.
- **Test:** Server test with a failing computer provider stub.

### MF-020 Permissions page shows "Nothing here yet" when loading fails
- **Severity:** P1 (users may think nothing is always allowed). **Area:** Settings > Permissions. **Source:** D-12.
- **Root cause:** `web/src/components/config/AppSettings.tsx:705-706` `.catch(() => setPolicies([]))`; MCP name lookup and "Ask again" also swallow errors (`:705,725`).
- **Fix:** Track `error` separately; show "Couldn't load permissions." with Retry; show an inline error when "Ask again" fails.
- **Acceptance:** With `/api/policies` returning 500, the page shows the error and Retry, never the empty state.
- **Test:** `tests/access-settings-ui.mjs` with a mocked failure.

### MF-021 `PATCH /routines/:id` treats the string "false" as enabled
- **Severity:** P1. **Area:** routines API. **Source:** D-07.
- **Root cause:** `server/src/routes.ts:388,393` `enabled ? 1 : 0` with no type check.
- **Fix:** Validate with `z.object({ enabled: z.boolean() }).strict()`; 400 otherwise.
- **Acceptance:** `{"enabled":"false"}` returns 400 and the routine is unchanged.
- **Test:** Server test.

### MF-022 Back after sign-in leaves the app for a stale Google/Composio consent page
- **Severity:** P1. **Area:** sign-in, navigation. **Source:** morning walk, B-03.
- **Repro:** Sign in with Google, use the app, press browser Back from Bots home.
- **Expected:** Back stays inside Swarm.
- **Actual:** "Composio wants access to your Google Account ... Composio already has some access."
- **Evidence:** `/workspace/startup-qa-bot/runs/20261122/screens/01-composio-google-consent.webp`.
- **Root cause:** Full-page redirect chain (`web/src/components/SignIn.tsx:80-83`, `server/src/auth/google.ts:186` redirects to `/`); the SPA never pushes desktop history entries (`web/src/store.ts:246-269` and `web/src/App.tsx:44-50` are phone-only).
- **Fix:** After a successful callback, redirect to `/?signed_in=1`; on boot, `history.replaceState` to `/` and push one in-app entry so the first Back stays in the app. The full fix comes with routes (MF-026, PD-05).
- **Acceptance:** After Google sign-in, the first browser Back does not leave swarm-team.fly.dev.
- **Test:** UI test that checks `history.length` handling after the callback redirect.

## P2: wrong behaviour, confusing state

### MF-023 Computer status disagrees between chat cards and Setup
- **Area:** setup, computer. **Source:** morning walk, B-07.
- **Repro:** Open Quinn's chat cards, then Details > Setup.
- **Actual:** Cards: "Computer ready. App access and approval rules still apply." Setup: banner "Computer preparation pending" with "Retry computer preparation".
- **Evidence:** `/workspace/startup-qa-bot/runs/20261122/screens/10-quinn-details-setup.webp`.
- **Root cause:** `bot_setups.computer_status` defaults to `'pending'` (`server/src/db.ts:85`) and is set to `'ready'` only by `provisionTeammate` (`server/src/agent/teammates.ts:43-71`), never for the primary or UI-created bots (`server/src/bots.ts:74`, `server/src/routes.ts:145-152`). `web/src/components/config/AgentConfiguration.tsx:203-207` shows that stale column; `CoworkerSetupCards.tsx:74` shows teammates' rows.
- **Fix:** Add one server helper `computerReadiness(userId, botId)` that derives status from the live computer and screen state (`computers.state`, `computers.screen`), use it in `setupView` and the coworker setup payloads, and have both components render the same field. Optionally backfill `computer_status='ready'` for bots whose screen exists.
- **Acceptance:** Both places show the same status for every bot.
- **Test:** Server test on the helper.

### MF-024 "Bot details panel" setting is not a setting
- **Source:** morning walk B-08, live C1.
- **Repro:** Settings > General: turn "Bot details panel" on, reload. Separately, open Details in any chat and return to General.
- **Actual:** On after toggling, Off after reload; and it turns On by itself after opening Details.
- **Evidence:** `/workspace/startup-qa-bot/runs/20261122/screens/34-general-bot-details-toggled-on.webp`.
- **Root cause:** `web/src/components/config/AppSettings.tsx:233,256-257` binds the switch to the transient `useStore.detailsOpen` (`web/src/store.ts:31,93`), not a stored preference.
- **Fix:** Implement PD-07 default: rename to "Open Bot details with each chat", persist it in `localStorage` keyed by user id (`swarm.<userId>.detailsDefault`), read it in `selectBot` (`store.ts:135`) to set `detailsOpen` on bot switch, and never write it when the panel is toggled from a chat.
- **Acceptance:** The switch value survives reload and does not change when the panel is opened or closed from a chat.

### MF-025 Group sidebar preview stays "No messages yet" until reload
- **Source:** live part B.
- **Root cause (verified):** `server/src/agent/rooms.ts:123-132` `postToRoom` appends the row and bumps `unread` but emits no `bot` or `roster` event; the user's own message in a room (`server/src/routes.ts:304-306`) also emits none. The sidebar preview comes from `lastPreview` in the bot list (`server/src/store.ts:19-24`, `web/src/components/Sidebar.tsx:32-35`), so it is stale.
- **Fix:** Call `emitBot(room.id)` after `appendRow` in `postToRoom` and after the user message in `POST /bots/:id/messages` (for all bots, not only rooms, if other previews lag too).
- **Acceptance:** Group preview updates within 1 second of a post.

### MF-026 Settings navigation does not update the URL; reload lands on the wrong section
- **Source:** D-13, live C2.
- **Repro:** Open `/#settings/keys`, click Permissions in the settings nav, reload.
- **Actual:** URL stays `#settings/keys`; reload opens API keys.
- **Root cause:** `web/src/configStore.ts:107` `openAppSettings` only sets state; `web/src/components/config/AppSettings.tsx:126` `pick` calls it. The hash is only read (`configStore.ts:42-51,126-129`) and cleared on close (`:109`).
- **Fix:** In `openAppSettings`, `history.replaceState(history.state, '', '#settings/' + section)` when the section is linkable. Keep the close behaviour. This is the minimal part of PD-05.
- **Acceptance:** Clicking any settings section updates the hash; reload reopens the same section; Back from Settings still works.
- **Test:** `tests/ui-store.test.mts` on `openAppSettings`.

### MF-027 Sidebar keeps a bot or Tasks highlighted on unrelated pages
- **Source:** morning walk, B-09.
- **Actual:** Tasks stays highlighted on Quinn's board, Goals, Saved reports, Routines, Daily synopses and Account settings reached via "Back to tasks"; the last bot stays highlighted on Usage and Create a bot.
- **Evidence:** `/workspace/startup-qa-bot/runs/20261122/screens/08-quinn-routines.webp`.
- **Root cause:** `web/src/components/Sidebar.tsx:59-60` only checks `view !== 'chat'`; Settings (`appSettings`), modals (`modal`) and Bot settings do not change `view`. `TasksView.tsx:191` marks the island active for `view === 'tasks'` even when Settings is open on top.
- **Fix:** `highlightedBot = view === 'chat' && !appSettings && !botSettings && !['create','group'].includes(modal)`; island active only when `view === 'tasks' && !appSettings`.
- **Acceptance:** Exactly one sidebar item (or none) is highlighted, matching the visible page.

### MF-028 Search only matches bots, while Settings says it searches chats
- **Source:** D-17, live part A.
- **Repro:** Ctrl+K, type a word from a chat message ("PONG").
- **Actual:** "No Bots match". Modal placeholder: "Search bot names, labels and descriptions". Settings shortcut list: "Search Bots and chats".
- **Root cause:** `web/src/components/modals/SearchModal.tsx:16-21,37` filters bots only; `web/src/components/config/AppSettings.tsx:239` label. `GET /bots/:id/conversation-search` exists (`server/src/routes-knowledge.ts:34`).
- **Fix:** Implement PD-08 default: add a "Messages" section to the search modal that calls conversation search across bots (add `GET /api/conversation-search?q=` that fans out per bot server-side, limit 20 results) and opens the chat at the matching row. If that is too large for this PR, change the Settings label to "Search Bots" instead; the PR must do one of the two.
- **Acceptance:** Search label and behaviour agree.

### MF-029 Keyboard shortcuts: Ctrl+N never fires, two shortcuts are undocumented, Mac glyphs on Linux
- **Source:** D-18, live part A.
- **Root cause:** `web/src/App.tsx:77-93` binds Cmd/Ctrl+N (reserved by browsers); `web/src/components/config/AppSettings.tsx:236-245` omits Cmd/Ctrl+Shift+/ (effort) and Cmd/Ctrl+Shift+F (fast) from `web/src/components/Composer.tsx:94-104`. Tooltips elsewhere show "⇧⌘," on Linux (search for hard-coded "⌘" in `web/src/components` outside `IS_MAC` checks).
- **Fix:** Rebind new bot to Alt+Shift+N (or Cmd/Ctrl+Alt+N); list every shortcut in Settings > General; use `IS_MAC` for every glyph.
- **Acceptance:** Every listed shortcut works in Chrome on Linux; every working shortcut is listed; no "⌘" on non-Mac.

### MF-030 Effort cycling order is confusing and the default label is wrong
- **Source:** live part A (F-062).
- **Actual:** Ctrl+Shift+/ cycles Medium > Low > Ultracode > Extra high with no toast; the effort menu says "High: The model's default" while Medium is the active default.
- **Root cause:** `web/src/components/ComposerModelMenu.tsx:41-46` cycles `effortsFor(m)`, which is ordered strongest first (`web/src/lib/models.ts:90`), so it goes down then wraps to Ultracode; no feedback. `ComposerModelMenu.tsx:219` labels `target.defaultEffort` as the model default while the bot's effective effort comes from `effectiveEffort(bot.effort, m)`.
- **Fix:** Cycle in ascending order (Low > Medium > High > Extra high > Max > Ultracode > Low), show a toast "Effort: <label>", and label as "Default" the same value that `effectiveEffort` uses when the bot has no explicit effort. Combined with MF-013, cycling must not bump the setup revision.
- **Acceptance:** Order is ascending, a toast shows each change, the menu's "default" matches the effective default.

### MF-031 Log out ignores server errors and reloads into a signed-in app
- **Source:** D-21.
- **Root cause:** `web/src/components/Sidebar.tsx:75` `await api.logout().catch(() => {}); location.reload();`.
- **Fix:** On failure show "Couldn't sign out. Check your connection and try again." and do not reload. On success, clear client state and reload.
- **Acceptance:** With `/api/auth/logout` failing, the user sees the error and stays on the page.

### MF-032 Approval decision and rows `limit` are not validated
- **Source:** D-08, D-09.
- **Root cause:** `server/src/routes.ts:328-331` maps an invalid `decision` to 404 "not found" (the guard in `server/src/agent/loop.ts:893-895` throws first, so nothing is resolved); `server/src/routes.ts:296` passes `Number(limit)` unchecked (NaN and negatives pass `Math.min` in `server/src/store.ts:149`).
- **Fix:** Validate `decision` in the route with zod and return 400; parse `limit` as an integer clamped to 1..500, default 200; 400 on non-numeric.
- **Acceptance:** `decision:"maybe"` returns 400; `limit=foo` returns 400; `limit=-5` is treated as 1.

### MF-033 Share button is a visible stub, and its toast is sometimes invisible
- **Source:** D-01, B-05, morning walk, live part B.
- **Actual:** Quinn: toast "Sharing isn't available in Swarm yet". QA TEST bot: no visible feedback.
- **Evidence:** `/workspace/startup-qa-bot/runs/20261122/screens/22-qa-test-bot-chat.webp`.
- **Root cause:** `web/src/components/ChatView.tsx:84` stub; the toast renders inside the chat `<main>` (`:90`) and is hidden when the Details pane covers the chat (`web/src/App.tsx:98,108`).
- **Fix:** Implement PD-03 default: hide Share until a real share feature exists (feature flag `features.share=false`). Move toasts to a top-level portal (MF-052).
- **Acceptance:** No Share button in any chat header.

### MF-034 Group members: remove is disabled with no reason; add list offers only some bots
- **Source:** live part B (F-043).
- **Root cause:** `web/src/components/MembersCard.tsx:47` `disabled={ids.length <= 2}` with no tooltip. Candidates are `bots.filter(b => b.kind !== 'room' && !ids.includes(b.id))` (`:26`), and with MF-004 configuring bots must be excluded too.
- **Fix:** Add a tooltip and helper text "A group needs at least 2 Bots." Show configuring bots as disabled options with "Activate first". Verify why only protected bots were offered live (check whether the `bots` list passed in is filtered elsewhere) and fix if wrong.
- **Acceptance:** The user can see why remove is disabled and which bots can be added.

### MF-035 Renaming a bot leaves the old name in its greeting
- **Source:** live part A.
- **Actual:** After renaming QA-Temp-1 from "QA", the greeting still reads "What job would you like QA to handle?".
- **Root cause:** The greeting is a stored message row written by `beginSetupInterview` (`server/src/bot-setup.ts:244-270`) with the name inlined.
- **Fix:** On rename (PATCH name), if the bot is still configuring and the greeting row is the latest assistant row of the current generation, rewrite it with the new name via `updateRow`. Otherwise leave history alone.
- **Acceptance:** Rename during setup updates the greeting.

### MF-036 Opening the computer viewer silently wakes the computer; viewer title is unreadable while loading
- **Source:** live part B (F-095 to F-097).
- **Fix:** Show "Waking <name>'s computer..." with progress in the viewer when the computer was asleep (it already calls ensure; surface it), and fix the title contrast in the loading state (see `web/src/components/ComputerViewer.tsx` header styles).
- **Acceptance:** Opening a sleeping computer shows the waking state; title passes WCAG AA contrast.

### MF-037 Add skill form: typing goes into the steps field; "Save resources" looks primary with nothing to save
- **Source:** live part B.
- **Fix:** Autofocus the name field when the Add skill form opens (`web/src/components/config/BotSettingsModal.tsx` SkillsTab or `KnowledgePanels.tsx`), and make "Save resources" secondary and disabled until something changes.
- **Acceptance:** Opening the form focuses Name; Save resources is disabled with no changes.

### MF-038 Sign-in error banner persists across reloads
- **Source:** D-14.
- **Root cause:** `web/src/components/SignIn.tsx:45-46` reads `?login=` and never strips it.
- **Fix:** After reading, `history.replaceState(null, '', location.pathname)`.
- **Acceptance:** `/?login=google_denied` shows the banner once; reload shows a clean page.

### MF-039 Settings navigation overlaps the sidebar and is cramped; no settings nav in compact mode
- **Source:** live part B, C1.
- **Fix:** In Settings, render the section nav as its own column (or replace the sidebar bot list while Settings is open), with normal row height and no inner scroll box; in compact sidebar mode show the section nav as a top segmented list or a drawer. Files: `web/src/components/config/AppSettings.tsx:150-165` and the related CSS in `web/src/styles`.
- **Acceptance:** At 1280x800 and 1024x768, every settings section is visible without overlap; compact mode has a visible section switcher.

### MF-040 Setup text shows literal escaped quotes
- **Source:** morning walk, B-10.
- **Actual:** "Autonomously reply exactly '\"OK\"' to test or acknowledgment messages in this chat..."
- **Evidence:** `/workspace/startup-qa-bot/runs/20261122/screens/23-qa-test-bot-setup.webp`.
- **Root cause:** Stored strings contain double-encoded escapes; no normalisation in `briefSchema` (`server/src/bot-setup.ts:50`), `clean()` (`server/src/bots.ts:42`) or `saveSetupDraft` (`server/src/bot-setup.ts:275-300`); UI prints verbatim (`AgentConfiguration.tsx:147,196-202`).
- **Fix:** Add a `normalizeModelText` helper that unescapes `\"` and `\\n` when a string has escapes but no real quotes or newlines; apply it in the brief schema transforms. Add a one-off, idempotent startup migration that normalises existing `bot_setups.brief` JSON (backward compatible, no data deleted).
- **Acceptance:** The QA TEST bot setup shows "OK" with plain quotes.
- **Test:** Unit test on the helper.

### MF-041 Models and access, API keys: contradictory states
- **Source:** live C2. **Evidence:** screens `6b9e658a`, `4f6a9fc5`, `7c2df03d`.
- **Actual:** Models & access says "Set up a plan below" while the Claude Code tab says "API providers selected", and the page opens on the Claude Code tab while "Run Bots on" is OpenRouter. API keys shows "Personal key: Not connected" next to "OpenRouter · Connected" with no explanation.
- **Root cause:** `web/src/components/config/SubscriptionSettings.tsx:317` status logic; `web/src/components/config/OpenRouterSettings.tsx:64-65`.
- **Fix:** Open on the tab that matches the active provider; only show "Set up a plan below" when no plan or provider is active; add a line on API keys: "Swarm's server key is in use. Add a personal key to bill your own OpenRouter account."
- **Acceptance:** No two status texts on these pages contradict each other.

### MF-042 Coworker setups can only be activated from the primary bot's chat
- **Source:** morning walk decision, root-cause table.
- **Root cause:** `web/src/components/CoworkerSetupCards.tsx` is mounted only for `bot.isPrimary` (`web/src/components/Transcript.tsx:225`); the bot's own Setup tab (`AgentConfiguration.tsx`) has no Activate for coordinator-created setups.
- **Fix:** Implement PD-04 default: add "Review and activate" to the bot's own Setup tab when status is `review`, calling the same activation API with the current revision; list these in Tasks (MF-012).
- **Acceptance:** Lead Generation can be activated from its own Details > Setup.

### MF-043 Routine toggle reads "Paused" next to an unchecked box
- **Source:** morning walk, B-04.
- **Evidence:** `/workspace/startup-qa-bot/runs/20261122/screens/08-quinn-routines.webp`.
- **Root cause:** `web/src/components/config/WorkRoutines.tsx:54-55`: description says "Paused · No next run until you resume." and the switch label also says "Paused" while unchecked, so it reads as an unchecked "Paused" option. Same pattern in `web/src/components/DetailsPanel.tsx:55-56` and `BotSettingsModal.tsx:440`.
- **Fix:** Constant label "Schedule on" for the switch in all three places; keep state only in the description.
- **Acceptance:** The switch label never changes with its state.

### MF-044 Goals cannot be deleted and their status text contradicts itself
- **Source:** live C1.
- **Actual:** After "Create without starting", title "QA goal · In progress", body "Goal status · Active ... No immediate run was requested", form text "saved as active, not as a draft". Only Resume and Stop exist; stopped goals stay forever.
- **Root cause:** `web/src/components/config/WorkflowsPanel.tsx:18` maps `active` to "In progress" in one place while `:126,200` print "Active"; no delete route in `server/src/routes-workflows.ts:18-34`.
- **Fix:** Use one status label everywhere ("Not started" when active with zero turns and no run requested; "In progress" when running; "Stopped"). Add `DELETE /api/workflows/goals/:id` allowed only for `cancelled` or completed goals, soft-deleting (set `archived_at`; add the column with a backward-compatible `ALTER TABLE ... ADD COLUMN`) and hiding archived goals from lists. Add "Delete goal" in GoalDetail for stopped goals with a confirm.
- **Acceptance:** "QA goal" can be deleted after Stop and disappears from Goals; status text is consistent.
- **Test:** Server test for delete on an active goal (409) and a stopped goal (200).

## P3: polish, copy, docs

### MF-045 Tab bars change width when the active tab changes
- **Source:** B-11. **Evidence:** `/workspace/startup-qa-bot/runs/20261122/screens/29-qa-test-bot-analytics.webp`.
- **Root cause:** Active tab font weight `web/src/styles/setup-paper.css:46` (600) and `web/src/styles/bot-details.css:23` (500); content-sized buttons (`setup-paper.css:44-45`).
- **Fix:** Keep weight constant and mark active with colour or underline, or reserve width with a hidden bold `::after{content:attr(data-label)}`.

### MF-046 History uses "Revision 4" and "Change 7" for the same thing
- **Root cause:** `web/src/components/config/AgentConfiguration.tsx:143` ("Revision") vs `web/src/components/config/AgentHistory.tsx:76` ("Change"). **Fix:** Use "Revision" for setup revisions and "Change" only for history entries, and label each clearly ("Change 7 · setup revision 4").

### MF-047 MCP page naming mismatch
- **Evidence:** screen `cbebdbe7`. **Root cause:** `AppSettings.tsx:129` "Custom MCP" vs `McpSettings.tsx:248` "Manage MCP servers", plus `ConnectAppsModal.tsx:277`. **Fix:** Use "MCP servers" everywhere.

### MF-048 Learning "Require approval for skill changes" helper only explains the Off state
- **Evidence:** screen `10b7d737`. **Root cause:** `web/src/components/config/LearningSettings.tsx:13`. **Fix:** "On: every skill change waits for your review. Off: ..." (keep the current Off text).

### MF-049 Connect apps modal: Gmail "Connected" label overlaps its description
- **Evidence:** screen `a04c3264`. **Fix:** Let the status badge wrap below the description at narrow widths (`web/src/components/modals/ConnectAppsModal.tsx` row CSS).

### MF-050 Sidebar previews show raw markdown
- **Actual:** Quinn's preview shows "**Example Domain**". **Root cause:** `server/src/store.ts:22-23` uses raw message text. **Fix:** Strip markdown (bold, italics, links, code fences, headings) before slicing to 140 characters.

### MF-051 Invite page shows "Sign in" to a signed-in user
- **Repro:** Signed in, open `/join/bogus123`. **Root cause:** `web/src/App.tsx:126-127`, `web/src/components/JoinPage.tsx`. **Fix:** When signed in, show "Back to Swarm" instead of "Sign in".

### MF-052 Toasts render inside the chat and can be hidden
- **Root cause:** `web/src/components/ChatView.tsx:40,90` and similar per-view toasts. **Fix:** One top-level toast portal in `App.tsx` with a `toast()` helper in the store; migrate ChatView, Composer and BotSettingsModal flashes to it.

### MF-053 Memories tab: two "Search sources" buttons; "0% full" bar shows a sliver
- **Fix:** Keep one button; render a 0 width bar at 0%. Files: `web/src/components/config/KnowledgePanels.tsx` / `KnowledgeManagement.tsx`.

### MF-054 Saved reports empty state is weak
- **Fix:** Empty state: "No saved reports yet. Ask <bot> for a report, or set up a daily synopsis." with a button to Daily synopses (`web/src/components/config/WorkReports.tsx`).

### MF-055 Goal acceptance checks are required but not marked
- **Root cause:** `WorkflowsPanel.tsx:164` relies on the browser `required` tooltip. **Fix:** Add "(required)" to the label and an inline error on submit.

### MF-056 Inconsistent "Bot" / "bot" capitalisation; sidebar order and avatars reshuffle while bots work
- **Fix:** Use "Bot" consistently in UI copy (grep `web/src` for " bot" in user-facing strings). Keep sidebar order stable while a bot is running (sort by last user activity, not by `updated_at` that changes on every row; see `listBots` ordering in `server/src/store.ts`).

### MF-057 Sidebar text wraps mid-collapse
- **Fix:** `white-space: nowrap; overflow: hidden` on sidebar labels during the collapse transition.

### MF-058 Dictation with silence gives no feedback
- **Repro:** + > Dictate, stay silent, "Use transcript". **Fix:** Show "Didn't catch anything. Try again." when the transcript is empty (`web/src/voice/` dictation flow).

### MF-059 Create bot accepts a click while the name is still being typed
- **Actual:** Clicking Create while typing produced the truncated name "QA". **Fix:** Read the name from the input at submit time (not a debounced state), and disable Create while an IME composition is active (`web/src/components/modals/CreateBotModal.tsx` or equivalent).

### MF-060 "Hide suggestion" is not scoped to the account
- **Source:** D-22. **Root cause:** `web/src/components/DetailsPanel.tsx:107,150` key `swarm.hideSuggested`. **Fix:** Key by user id.

### MF-061 Dead memory routes shadowed by the knowledge API
- **Source:** D-10. **Root cause:** `server/src/routes.ts:428-438` unreachable because `knowledgeApi` mounts first (`server/src/tenant-app.ts:100` vs `:105`). **Fix:** Delete the dead handlers.

### MF-062 README is out of date on MCP
- **Source:** D-23, D-24. **Fix:** `README.md:64` (secrets are sealed at rest via `sealPrivate`, `server/src/mcp/store.ts:58,100-101`) and `README.md:66` (OAuth is supported, `server/src/mcp/routes.ts:24-36`); document the stdio restriction from MF-008.

### MF-063 HEAD requests hang until timeout
- **Source:** backend-results section 3. `HEAD /api/health` and `HEAD` on a CSS asset send headers then hold the connection for 25 s. **Fix:** Verify Hono / node adapter HEAD handling (`server/src/index.ts`); end the response with no body. Low priority, but uptime monitors often use HEAD.

### MF-064 Details edit textarea inserts text at the wrong position
- **Source:** live part B. **Fix:** Preserve the caret position on controlled re-render in the Details edit textarea (`web/src/components/DetailsPanel.tsx` or `AgentConfiguration.tsx`); do not reset `value` from props while focused.

### MF-065 Tasks area naming is inconsistent
- **Source:** D-26, morning walk decision. **Root cause:** `web/src/components/config/TasksView.tsx:121` titles "Tasks", "<primary>'s board", "Goals and workflows", "Saved reports". **Fix:** Apply PD-06 default: tab labels and page titles match ("Tasks", "Team", "Goals", "Reports"), with the primary's name only in the subtitle.

### MF-066 Viewer and setup copy say "Mac" to every web user
- **Root cause:** `web/src/components/config/DeviceAccessSection.tsx:23-39`. **Fix:** Covered by MF-006 for the cloud card; additionally show the Mac section only on macOS browsers or the Mac app, and on other platforms show "The Mac app lets Bots use your own Mac. Available for macOS." (PD-09).

---

# 3. Product decisions needed (not code fixes)

Each decision has a **RECOMMENDED DEFAULT**. The coordinator implements the default in this PR unless the owner says otherwise. Items marked "implemented by" point to the MF item that carries the work.

| ID | Question | Options | RECOMMENDED DEFAULT (implement this) |
|---|---|---|---|
| PD-01 | Should bots ask before using their cloud computer (browser, shell)? | A. Keep auto-allow, disclose clearly. B. Ask by default. C. Per-account toggle. | **A + C: auto-allow stays the default, disclosed in Settings > Computer, with an opt-in "Ask before Bots use their computer" toggle.** Implemented by MF-006. |
| PD-02 | Should new bots be forced through a setup interview? | A. Keep forced interview. B. Optional interview with "Skip setup". C. No interview. | **B: interview offered with a visible banner and one-click "Skip setup".** Implemented by MF-010. |
| PD-03 | Share button | A. Hide until built. B. Share a read-only transcript link. C. Share a bot template. | **A: hide behind `features.share=false`.** Implemented by MF-033. |
| PD-04 | Where are coworker setups reviewed and activated? | A. Only in the primary chat. B. Also in the bot's own Setup tab and in Tasks. | **B.** Implemented by MF-042 and MF-012. |
| PD-05 | Real URLs and deep links | A. Keep state-only. B. Hash sync for Settings only. C. Full router (`/bots/:id`, `/bots/:id/settings/:tab`, `/tasks/:tab`, `/settings/:section`). | **B in this PR** (MF-026, MF-022); C as a follow-up PR, not in scope here. |
| PD-06 | Naming of the Tasks area and the Bots page | A. Keep. B. Tabs and titles match: Tasks, Team, Goals, Reports; add a "Bots" sidebar entry for the Your bots page. | **B.** Implemented by MF-065 (sidebar entry optional if it conflicts with layout; tab and title match is required). |
| PD-07 | "Bot details panel" setting | A. Remove. B. Persisted "Open Bot details with each chat". | **B.** Implemented by MF-024. |
| PD-08 | Search scope | A. Bots only, fix label. B. Bots and messages. | **B if it fits; otherwise A.** Implemented by MF-028. |
| PD-09 | Non-Mac computer story | A. Mac only, hide elsewhere. B. Add Windows/Linux companion. | **A for the device section; the cloud computer card (MF-006) covers everyone.** Implemented by MF-066. |
| PD-10 | Learning: skill changes auto-apply by default (`skillApproval:false`, `server/src/knowledge/settings.ts:5`) | A. Keep auto-apply. B. Require approval by default. | **Keep A (no code change), but fix the helper copy (MF-048).** Owner may flip to B later; changing the default would alter existing accounts. |
| PD-11 | API keys only in the account menu | A. Keep. B. Also list "API keys" in the Settings nav. | **B: add it to the Settings nav (it is already a linkable section `keys`).** Small change in `AppSettings.tsx` NAV; do it with MF-039. |
| PD-12 | File attach in the web composer | A. Not now. B. Add attach with an upload endpoint. | **A: out of scope for this PR.** No code change. |

---

# 4. Implementation plan for the coordinator

## 4.1 Work streams and file ownership

Use one integration branch, `qa/master-fix-20261122`. Each stream works on its own branch off it and merges back. A file is owned by exactly one stream; another stream that needs a change in that file asks the owner or waits for its merge.

| Stream | Owns files | MF items |
|---|---|---|
| **WS1 Server API and security** | `server/src/tenant-app.ts`, `server/src/security/request.ts`, `server/src/routes.ts`, `server/src/bots.ts`, `server/src/routes-workflows.ts`, `server/src/agent/workflows.ts`, `server/src/accounts.ts`, `server/src/mcp/*`, `server/src/index.ts`, new `server/src/lib/json.ts`, new `server/src/routes-attention.ts` | MF-001, 002, 003, 008, 009, 013, 014, 017 (server), 019, 021, 025 (routes part), 032, 044 (server), 061, 063, and the server endpoint for MF-012 |
| **WS2 Agent runtime** | `server/src/agent/loop.ts`, `server/src/agent/rooms.ts`, `server/src/routes-rooms.ts`, `server/src/agent/tools.ts`, `server/src/agent/prompt.ts`, `server/src/bot-setup.ts`, `server/src/store.ts`, `server/src/proactive.ts`, `server/src/settings.ts`, `server/src/agent/teammates.ts` | MF-004, 005, 006 (server), 010 (server, including `/setup/skip` handler logic in `bot-setup.ts`; WS1 adds the route line), 011 (server), 018 (server), 023, 025 (rooms part), 035, 040, 050 |
| **WS3 Web chat and shell** | `web/src/App.tsx`, `web/src/store.ts`, `web/src/lib/events.ts`, `web/src/lib/*` (new hooks), `web/src/components/ChatView.tsx`, `Composer.tsx`, `ComposerModelMenu.tsx`, `Transcript.tsx`, `Sidebar.tsx`, `MembersCard.tsx`, `ComputerViewer.tsx`, `JoinPage.tsx`, `web/src/components/modals/*`, `web/src/voice/*` | MF-007, 010 (banner), 011 (client), 018 (avatar), 027, 028, 029, 030, 031, 033, 034, 036, 049, 051, 052, 056, 057, 058, 059 |
| **WS4 Web settings and work area** | `web/src/configStore.ts`, `web/src/components/config/*`, `web/src/components/DetailsPanel.tsx`, `web/src/components/CoworkerSetupCards.tsx`, `web/src/styles/*` | MF-006 (UI), 012 (UI), 016, 017 (UI), 020, 024, 026, 037, 039, 041, 042, 043, 044 (UI), 045, 046, 047, 048, 053, 054, 055, 060, 064, 065, 066, PD-11 |
| **WS5 Sign-in** | `server/src/auth/google.ts`, `server/src/composio.ts` (sweep and login functions only), `web/src/components/SignIn.tsx` | MF-015, 022, 038 |
| **WS6 Docs and tests** | `README.md`, `docs/*`, `tests/*` (new files; each stream may add its own test files too) | MF-062, test wiring in `package.json` scripts if needed |

Shared touch points to coordinate:
- `server/src/routes.ts` (WS1) gets route lines for WS2 handlers (`/setup/skip`) and the MF-012 endpoint mount.
- `web/src/store.ts` (WS3) gets the toast helper (MF-052) that WS4 consumes, and the timezone call (MF-017) that WS4's Account select uses.
- `server/src/store.ts` (WS2) preview changes (MF-018, MF-050) and `emitBot` usage by WS1 (MF-025).
- MF-047 renames a label in `web/src/components/modals/ConnectAppsModal.tsx` (WS3 file); WS4 sends that one-line change to WS3.

## 4.2 Order

1. **First (blocking):** WS1 lands `readJson` helper (MF-014) and `botPatchSchema` (MF-003). WS3 lands the toast portal (MF-052). These are small; merge to the integration branch within the first pass.
2. **Parallel:** all streams implement their P0 items, then P1, then P2, then P3.
3. **Integration:** rebase streams on the integration branch, run full checks, fix conflicts.
4. **PR, merge, deploy, verify** (definition of done below).

## 4.3 Definition of done

1. `npm ci` then `npm run typecheck` passes (server and web).
2. Existing tests that ran green on the baseline still pass. At minimum run: `npm run test:bots`, `test:onboarding`, `test:google-auth`, `test:mcp` (unit parts), `test:usage`, `test:models`, `test:native-auth`, and `node --import tsx --test tests/ui-store.test.mts`. Record any test that was already failing at baseline in the PR body rather than skipping it silently.
3. New tests added where cheap (each MF item lists one); at least the server tests for MF-001, 003, 004, 005, 009, 011, 012, 013, 014, 015, 021, 032, 044.
4. One PR to `main` titled **`QA master fix: 2026-11-22`**, whose body contains a checklist with every MF ID (MF-001 to MF-066), each checked with a one-line note, or unchecked with the reason. Product decisions applied are listed with their PD IDs.
5. PR merged to `main` (squash or merge commit; note which).
6. Deployed to Fly app `swarm-team` from the merge commit, for example: `fly deploy -a swarm-team --build-arg SWARM_BUILD_REVISION=$(git rev-parse HEAD)` run on a checkout of the merge commit (the release manifest needs the exact 40-hex revision; see `scripts/write-release-manifest.mjs:16-25` and `Dockerfile:21-22`).
7. Live verification:
   - `curl -s https://swarm-team.fly.dev/api/version` shows `revision` equal to the merge commit SHA.
   - `node scripts/verify-deployment.mjs https://swarm-team.fly.dev server/dist/release-manifest.json` passes.
   - `curl -s https://swarm-team.fly.dev/api/health` is exactly `{"ok":true}`; `curl -sI https://swarm-team.fly.dev/` shows CSP, HSTS, nosniff, frame protection.
   - A signed-in smoke check (by the owner or a QA agent) of: create a bot and Skip setup, send a message and see "Starting..." within 1 second, group reply lands in the group, Tasks shows pending items, Settings hash updates, daily synopsis shows the local zone.

---

# 5. Guardrails

1. **No secrets** in code, tests, fixtures, logs, commit messages or the PR body. Do not print env values. Use existing env names only.
2. **Do not delete user data.** No destructive migrations, no table drops, no row deletes outside explicit user actions (goal delete is a soft delete). Do not touch the QA test data in the live account.
3. **Migrations must be backward compatible:** additive `ALTER TABLE ... ADD COLUMN` with defaults, idempotent startup migrations (follow the `addColumn` pattern in `server/src/db.ts:192`), and code that works if the old rows are unchanged. A rollback to the previous image must still boot on the migrated DB.
4. **Remove model, provider and key disclosure from public `/api/health`** (MF-001). No new public endpoint may expose provider, model, key presence or feature internals.
5. Keep approvals at least as strict as today: no change may turn an `ask` into an `allow` by default.
6. Do not send any real external message (email, Slack, SMS) while testing; use the mock provider and fake Composio clients in tests.
7. Do not change billing, plan limits or usage accounting except where MF-011 changes queue concurrency; in that case keep per-bot ordering and usage attribution intact (`withUsage` wrapping in `server/src/agent/loop.ts:170-172`).
8. Plain technical copy in UI strings; no em dashes or en dashes in new copy.
