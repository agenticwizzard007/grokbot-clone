# Swarm master fix PRD, round 2

Prepared 22 Nov 2026, 19:30 (UTC+4, Dubai) for an autonomous coding coordinator and its agent team. This file is self-contained. Every item has an id (R2F-001 and up), the round 1 MF id where one applies, a priority, the observed behavior with UI text quoted from the live re-QA, repro steps, the expected behavior, the likely root cause with real file paths and functions found in the repo, acceptance criteria and a test to add. Root causes are "likely": they were found by reading the code at the commit below, not by running a debugger. Verify each one before you change code and correct it if the code says otherwise.

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Commit tested | `main` @ `275708627f5259b456666d562edccf68e6eb748c` (merge of PR #73, "QA master fix: 2026-11-22") |
| Live app | https://swarm-team.fly.dev (Fly app `swarm-team`) |
| Live build | `GET /api/version` revision `2757086...`, builtAt 22 Nov 2026 16:10:34 (UTC+4). The live app is exactly the tested commit. |
| Deploy | GitHub workflow "Deploy Fly staging" (`.github/workflows/staging.yml`) deploys on merge to `main`. |
| Stack | `web/` React + Zustand SPA, `server/` Hono + SQLite, SSE (`/api/events`), Composio for apps, noVNC viewer, optional Claude Code / Codex runner (`server/src/cli/*`) |
| Static checks at this commit | `npm run typecheck` PASS. Unit tests 730/730 PASS. UI scripts 18/19 PASS (`tests/viewer-wake.mjs` fails, see R2F-020). |

Line numbers are against the commit above and may drift by a line or two. Search for the quoted code if a line does not match.

---

# 1. Summary

## 1.1 Scope

Round 2 is a full re-QA of the app after PR #73 (which closed 65 of 66 round 1 items and left MF-064 partial). It ran on 22 Nov 2026 between 16:55 and 19:08 (UTC+4):

1. Code review of the PR #73 diff (`2a57860..2757086`, 120 files) against every round 1 MF item. Verdicts: 11 verified by code plus curl or tests, 48 needing a UI check, 7 suspicious (MF-009, 016, 017, 019, 035, 056, 064).
2. Unauthenticated backend smoke tests with curl (health, version, headers, CSP, HEAD, auth, SSE, new MF routes). All pass.
3. Typecheck, unit tests and UI scripts on a fresh clone.
4. A 92 check live verify plan (R2-001 to R2-092) run in 8 batches in a real signed-in browser, using only test Bots (`QA-Temp-1`, `QA-Temp-2`, `QA-Temp-3b`, `QA-Temp-4`, `QA-Temp-5`, group `QA-Temp-Group`).

This PRD lists every FAIL and every PARTIAL that showed a defect, including minor ones, plus the code review suspects that the live run did not disprove.

## 1.2 Counts by priority

| Priority | Meaning | Count |
|---|---|---|
| P0 | Security, privacy, data going to the wrong place, consent | 2 |
| P1 | Broken core flow a normal user hits | 5 |
| P2 | Wrong behavior with a workaround, confusing state, test gaps | 14 |
| P3 | Polish, copy, small layout issues, hardening | 17 |
| **Total** | | **38** |

Plus 7 product decisions in section 3, each with a recommended default.

## 1.3 P0 at a glance

- **R2F-001 (MF-004, regressed or incomplete):** a group chat turn leaks into a member Bot's 1:1 chat and is not read-only. QA-Temp-2's own chat shows the group-turn chatter and a Slack send approval card for the group text.
- **R2F-002 (MF-005 class):** raw internal ids are visible to the user in review cards and agent exchanges: `ca_...` connected-account ids in Quinn's "Review QA-Temp-1 configuration" card and a `req_...` coordination request id in Quinn's chat.

## 1.4 Test coverage

**Live UI, PASS (see section 4 for the full list):** sign-in copy and hash handling, CSP and security headers in the browser, sidebar collapse, search palette, Tasks island and badge, usage meter, account menu, theme, shortcuts (Alt+Shift+N, Ctrl+,), setup banner, Skip setup, setup-mode reply, import with duplicate name error, group remove guard, Share hidden, running state and replies without reload, Stop, 32,000 character cap, new conversation dialog, model picker, effort, fast, cloud computer approval toggle, approvals, Permissions Always allow and Ask again, connect card and Skip, Needs you items, goals delete and acceptance checks, Daily synopses zone, hide suggestion, take control, voice, the Details edit caret (MF-064 now fixed), Bot settings caps and save, skills, memory sources, Learning copy, Analytics zone, Settings hashes and reload, time zone change, offline permissions, MCP servers form, Computer note on Linux, Connect apps catalog, cleanup.

**Blocked or not verified:** R2-006 (Google sign-in redirect, needs a real sign-in), R2-036 ("Queued behind" state never observed because of tool latency), R2-010 and R2-080 (skipped by plan), R2-092 (Log out and Delete account, never run without the owner's confirmation), the 2 MB import limit, cancel of a queued message, the Waking and Try again viewer state (the computer was already awake).

## 1.5 Test data left in the account

`QA-Temp-1` (still in setup), `QA-Temp-2`, `QA-Temp-Group`. `QA-Temp-3b`, `QA-Temp-4`, `QA-Temp-5` and `QA-Temp-Import` were deleted. The routine "Daily hi" on QA-Temp-3b was removed with that Bot. Do not touch real Bots or real data.

## 1.6 Evidence

Screenshots live on the QA box under `/tmp/computer-use/sand-subagent-*.webp` and are cited by file name per item. Raw curl dumps: `/tmp/r2/`. Test logs: `/workspace/swarm-qa/round2/tests/`. Live results: `/workspace/swarm-qa/round2/ui-results.md`. Code review: `/workspace/swarm-qa/round2/backend-results.md`.

---

# 2. Fix list

Format for each item: priority, area, old MF id, observed (verbatim UI text where available), repro, expected, likely root cause (file and function), fix direction, acceptance criteria, test to add.

## P0: security, privacy, consent

### R2F-001 Group chat turn leaks into a member's 1:1 chat and is not read-only
- **Priority:** P0. **Area:** group chats, agent loop, approvals. **Old id:** MF-004 (and MF-005 for the card). **Checks:** R2-033 FAIL, R2-034 PARTIAL.
- **User impact:** A message the user sends in a group chat produces activity in a member Bot's private chat, including an approval card asking to post the group text to Slack. A group turn also checks external apps although the product promise is that group turns only read. The user cannot tell what was sent where, and one wrong click would post to an external workspace.
- **Observed:**
  - In `QA-Temp-Group` the user sent "ping, reply with one word". The group got the reply "pong" (correct).
  - QA-Temp-2's own 1:1 chat then contained group-turn chatter: "The ping is for the group, not Gmail. Posting a short reply." and "That inbox message is unrelated to the ping...". So the group turn also read the mailbox.
  - The same 1:1 chat showed an approval card "Allow QA-Temp-2 to send message?" with `SLACK_SEND_MESSAGE`, channel "QA-Temp-Group", text "QA-Temp-2 here.", state "Not allowed", followed by "Slack send was declined. I'll reply in the group chat instead."
  - The group also showed "QA-Temp-1 is still being set up and can't answer in groups yet." (correct notice).
  - R2-034, "post hello in Slack" in the group: QA-Temp-2 replied in the group "Slack is expired. I won't send anything there." No card appeared, but the turn inspected Slack instead of saying group turns cannot act outside Swarm.
  - QA-Temp-1's 1:1 chat stayed clean.
- **Important evidence caveat:** the card text and arguments are identical to the round 1 MF-004 card (round 1 left "a denied Slack approval on QA-Temp-2" as test data). The first job is to find out whether these rows are new. Run a read-only query on the live DB or a copy: `SELECT seq, kind, created_at, json_extract(body,'$.audience') FROM rows WHERE bot_id=<QA-Temp-2 id> AND generation=<current> ORDER BY seq DESC LIMIT 40;` and compare `created_at` with the deploy time 22 Nov 2026 12:10:34 UTC. Fix the code gaps below either way. Old rows that predate the fix may stay, but state the finding in the PR body.
- **Repro:**
  1. Have two active Bots (QA-Temp-2 is active) in a group with one Bot still in setup (QA-Temp-1).
  2. In the group send "ping, reply with one word". Then send "post hello in Slack".
  3. Open each member's 1:1 chat.
- **Expected:** Replies appear only in the group. No new rows of any kind (messages, tool rows, cards, notices) in a member's 1:1 chat from a group turn. No approval card is created from a group turn for any tool. A group turn that is asked to act outside Swarm answers in the group with a fixed refusal such as "Group chats can't send to other apps. Ask me in my own chat." and does not call app discovery or execution tools to decide that.
- **Likely root cause:**
  1. `server/src/agent/loop.ts` `processCalls` (about line 647 to 660): the group refusal `if (ctx.roomId && !pol.readOnlyApps)` runs only when `c.name === 'SWARM_APPS_EXECUTE'`. Every other tool whose policy is `ask` (MCP tools `mcp_*`, computer and browser tools when "Ask before Bots use their computer" is on, `deliver_artifact`, `send_to_bot` and others) reaches the `decision === 'ask'` branch (about line 677) and creates an approval card with `appendRow(botId, 'card', ...)` in the member's own chat.
  2. `server/src/store.ts` `appendRow` and `updateRow` (lines 130 and 154) force `audience: 'user'` on every card (`body.type === 'card' ? 'user' : ...`). A card created during an internal group turn is therefore always visible in the member's 1:1 chat.
  3. Tool rows and assistant text of a group turn are written to the member's own transcript (`appendRow(botId, 'tool-call', ...)` in `runTurn`, about lines 480 and 515) and rely on `executionAudience(botId)` (`server/src/usage-context.ts:41`) to mark them internal. That reads an AsyncLocalStorage store set by `withUsage` (`loop.ts:234`). Hypothesis to verify: rows written from the Claude Code / Codex runner callbacks (`withNativeTools` in `server/src/cli/native-tools.ts`, `server/src/cli/tool-callback.ts`) or streamed assistant messages may run outside that store, so `executionAudience` falls back to `'user'` and the chatter shows in the 1:1 chat. The account uses the Claude Code provider (Models and access opens on the Claude Code tab).
  4. `server/src/agent/rooms.ts` `dispatchRoomMessage` (lines 45 to 81) only tells the model in prose that apps are read-only. Read tools (`list_app_connections`, `SWARM_APPS_SEARCH`, Gmail reads) stay available, so the Bot reads mail and checks Slack during a group turn.
- **Fix direction:**
  1. In `processCalls`, for any call in a turn with `ctx.roomId`, never create an approval card. Treat `decision === 'ask'` as a refusal with the tool output "Group chat turns can't ask for approval. Nothing was done. Answer in the group, or ask the user to request this in your own chat." Mark the tool row denied. Keep the existing `SWARM_APPS_EXECUTE` read-only rule.
  2. In `runTurn`, pass an explicit audience for every row written during a room turn (`audience: 'internal'` on tool rows, notices and assistant messages written to the member's transcript), instead of relying on AsyncLocalStorage. Make `appendRow` keep `internal` for cards when the caller passes it explicitly, or simply guarantee no card is written in room turns (step 1).
  3. Decide the group app scope (PD-R2-05). Recommended default: in room turns remove app discovery and execution tools (`SWARM_APPS_SEARCH`, `SWARM_APPS_EXECUTE`, `list_app_connections`, `request_app_connection`, `mcp_*`) from `ctx.availableTools`, so the Bot answers from the group context only. Update the prompt text in `dispatchRoomMessage` to match.
  4. Add a server-side guard in `appendRow` (or a wrapper used by `runTurn`) that refuses to write a `card` row for a job whose trigger has `roomId`, and logs it.
- **Acceptance:**
  - In a group of two active Bots, "ping" and "post hello in Slack" produce rows only in the group transcript. The member transcripts get zero new user-visible rows (check via `GET /api/bots/:id/rows` filtered as the web client does).
  - No `approvals` row and no `card` row is created for any tool call in a room turn, for both the built-in model loop and the Claude Code / Codex runner path.
  - "post hello in Slack" in a group gets the fixed refusal in the group and makes no app tool call.
- **Test to add:** server tests with the mock provider (`tests/mock-provider.mjs`), extending `tests/qa-ws2-runtime.test.mts`: (a) a room turn whose model output calls an `ask` MCP tool and an `ask` SWARM_APPS_EXECUTE write: assert no `approvals` row, no card row, tool rows denied; (b) a room turn with plain text plus a tool call: assert every row written to the member's transcript has `audience='internal'`; (c) the same through the native runner fake (`tests/cli-native-tools.test.mts` pattern).

### R2F-002 Raw internal ids shown to the user in review cards and agent exchanges
- **Priority:** P0 (privacy and consent surface). **Area:** coworker setup review, agent exchanges. **Old id:** MF-005 (fixed for approval cards and Settings, regressed in another surface). **Check:** R2-053 FAIL.
- **Observed:** In Quinn's chat, the coworker card "Review QA-Temp-1 configuration", sections Resources and Context, show raw connected-account ids: "Slack account ca_KIxihCKrE-D2..." and "Gmail account ca_pESfPrEqcgnN". Quinn's chat also shows a raw request id "req_11ev-EvIvCvn". (R2-050 and R2-051 PASS: approval and connect cards and Settings > Connected apps no longer show `ca_` ids.)
- **Repro:** Open the primary Bot's chat. Find the coworker setup card for QA-Temp-1 and click "Review QA-Temp-1 configuration". Read Resources and Context. Expand the agent exchange rows ("N messages with N Bots").
- **Expected:** No `ca_...`, `req_...`, `apr_...`, Bot id or other internal id appears in visible text anywhere in chat. Accounts are named "Connected Slack account" (or the account label). Requests are named by their text or "Request from QA-Temp-1".
- **Likely root cause:**
  1. `server/src/agent/app-connections.ts` `publicConnection` (line 50) returns `id: connection.id` to the model. The model copies those ids into the free-text brief fields `shared_resources` and `context_summary` (schema in `server/src/bot-setup.ts:74-75`), which `web/src/components/CoworkerSetupCards.tsx` renders verbatim (line 78: `brief.shared_resources.join('; ')`, `brief.context_summary`). The same card also prints `{ref.botId}` (a raw Bot id) under "Original user answers".
  2. `server/src/coordination/requests.ts` `settle` (line 225) writes the result message text as `[Internal result for request ${r.id}; ...]`. `web/src/components/AgentExchangeGroup.tsx` (line 53) renders `message.text` as is, so the `req_...` id is shown. `web/src/components/config/TeamBoard.tsx:183` also prints "Request {record.id} · Correlation {record.correlationId}" in visible text.
- **Fix direction:**
  1. Add a shared server helper `redactInternalIds(text)` that replaces `ca_[A-Za-z0-9_-]+` with "connected account", `req_`/`apr_`/`cli_` style ids and Bot ids with neutral labels. Apply it when saving a brief (`save_agent_setup`, `prepare_teammate_setup` in `server/src/agent/teammates.ts` and `server/src/bot-setup.ts`) and when building the setup view. Also instruct in the brief schema descriptions: "Never include connection or account ids; name the app instead."
  2. Keep the machine header for the receiving model but store a separate display text, or strip the `[Internal result for request ...]` prefix in `AgentExchangeGroup` before render and show "Result" as a chip instead.
  3. In `CoworkerSetupCards.tsx`, show the Bot name instead of `ref.botId`. In `TeamBoard.tsx`, move request and correlation ids into a `title` tooltip or a "Details" disclosure.
  4. Add a web safety net: a small `stripInternalIds` used by `Markdown.tsx` for assistant text is optional; do not rely on it alone.
- **Acceptance:** Searching the rendered DOM of the primary chat, coworker review card, agent exchange panel and Team board for `/\b(ca|req|apr)_[A-Za-z0-9_-]{6,}/` finds nothing. Existing stored briefs with ids render redacted.
- **Test to add:** unit test for `redactInternalIds`; server test that `setupView` and the exchange API output contain no `ca_` or `req_` ids after saving a brief with them; UI script assertion in `tests/central-setup-ui.mjs` and `tests/agent-exchanges-ui.mjs`.

## P1: broken core flows

### R2F-003 Routine Delete confirm is unreliable and sits next to Run now
- **Priority:** P1. **Area:** Bot settings > Routines. **Old id:** none (F-107). **Check:** R2-077 FAIL.
- **Observed:** Clicking the trash icon turned it into a red "Delete" button. Clicking red Delete did not delete; the button reverted to the trash icon. Twice the click landed on the adjacent play button ("Run now"), so "Daily hi" ran twice on QA-Temp-3b and posted "Hi." twice. History still read "No recorded runs yet." after both runs (see R2F-016).
- **Repro:** Bot settings > Routines on a test Bot with one routine. Click the trash icon, wait about 3 to 5 seconds (normal for a slow machine or a screen reader user), then click where the red Delete is.
- **Expected:** Delete asks for a clear confirmation that does not time out silently and does not move other buttons. A destructive confirm is never next to an instant, side-effecting action. Run now asks for confirmation or is visually separated.
- **Likely root cause:**
  1. `web/src/components/config/ui.tsx` `ConfirmButton` (lines 36 to 55) reverts `asking` to false after 4000 ms (`setTimeout(() => setAsking(false), 4000)`), so a slower click lands on the old icon or on whatever moved under the pointer.
  2. The confirm state swaps a 28 px icon button for a wider text button (`cfg-btn cfg-btn--danger`), which reflows the row actions in `web/src/components/config/BotSettingsModal.tsx` `RoutineItem` (lines 451 to 476). The play button `title="Run now"` sits immediately before it and runs with no confirm: `onClick={() => configApi.runRoutine(r.id)...}` (line 468).
  3. `ConfirmButton` has no `catch`: a failed delete throws an unhandled rejection and shows nothing.
- **Fix direction:** Replace the inline auto-reverting confirm for routines with the shared confirm dialog used for New conversation (`web/src/lib/confirmDialog.tsx`, `ConfirmPortal`), text "Delete Daily hi? Future runs stop. Past runs and reports stay." with Delete and Cancel. Or reuse the `WorkRoutines.tsx` pattern (lines 57 and 58, an inline panel with "Delete routine" and Cancel). Remove the 4 s timeout. Keep icon positions fixed. Put Run now behind a confirm ("Run Daily hi now?") or move it into a menu. Show an error toast on failure and refresh the list on success.
- **Acceptance:** Delete works on the first confirm regardless of delay. No layout shift of other actions when confirm opens. Run now never fires from a click intended for Delete. Failure shows an error.
- **Test to add:** UI script (extend `tests/updated-ui.mjs` or a new `tests/routines-ui.mjs`): open confirm, wait 6 s, confirm, assert routine gone and `POST /routines/:id/run` never called; assert the Run now button bounding box does not move when confirm opens.

### R2F-004 Unsaved Bot settings edit is lost on sidebar Bot switch and Create a Bot
- **Priority:** P1. **Area:** Bot settings. **Old id:** MF-016 (gap confirmed). **Check:** R2-073 FAIL. (R2-071 and R2-072 PASS: tab switch keeps the edit; Escape, Back and X show "Discard unsaved changes? Your edits on General have not been saved.")
- **Observed:** With an unsaved About edit, clicking another Bot in the sidebar, or clicking "Create a Bot", drops the edit with no warning. Shot `/tmp/computer-use/sand-subagent-f4ab568b-03af-290d-d061-bf2d49cf08bb.ec707017-7b96-4697-b648-3ec716a40b86.webp`.
- **Repro:** Bot settings > General for a test Bot, change About, do not save. Click another Bot in the sidebar. Come back. Repeat with "Create a Bot", then Cancel.
- **Expected:** The same "Discard unsaved changes?" guard appears for every navigation away from Bot settings (sidebar Bot, Create a Bot, brand button, search result, Tasks island, Settings, keyboard shortcuts), or the draft is kept and restored.
- **Likely root cause:** `web/src/components/config/BotSettingsModal.tsx` guards only its own `onClose` (line 62) and `beforeunload` (lines 63 to 67). The sidebar calls `useConfigUI.getState().closeBotSettings()` directly: `createBot` and `showBots` in `web/src/components/Sidebar.tsx` (lines 76 to 78), and `openConversation` in `web/src/configStore.ts` (lines 174 to 181) used by the sidebar, search and Tasks. `closeBotSettings` (`configStore.ts:106`) just sets `botSettings: null`. The guard also only tracks the General tab (`generalDirty`).
- **Fix direction:** Move the dirty flag and guard into `configStore` (for example `botSettingsDirty` plus `requestLeaveBotSettings(next: () => void)`). Make `closeBotSettings`, `openConversation`, `openAppSettings` and the Sidebar actions go through it, showing the existing dialog and running `next` only on Discard. Cover all tabs with editable drafts (General, Skills add form, Memories).
- **Acceptance:** Every navigation listed above shows the guard when a draft is dirty; Cancel keeps the user on Bot settings with the draft intact; Discard navigates. No guard when nothing changed.
- **Test to add:** extend `tests/bot-details-ui.mjs`: edit About, click a sidebar Bot, assert the dialog; Cancel, assert text kept; repeat for Create a Bot and Ctrl+K search result.

### R2F-005 Create a Bot: name truncated on fast Create, keystrokes spill into chat, caret jumps
- **Priority:** P1. **Area:** create Bot. **Old id:** MF-059 (not fixed). **Check:** R2-023 FAIL.
- **Observed:**
  - First pass: typed "QA-Temp-3" then clicked Create quickly. The Bot was created as "QA" and "-Temp-3" landed in the new Bot's chat composer. Shot `/tmp/computer-use/sand-subagent-b11b1f57-92e7-b9db-951e-2ec667b7c360.ad062718-674b-4520-b55f-74108371313a.webp`.
  - Retry: fast type plus Enter "QA-Temp-5" and one-go "QA-Temp-4" were created correctly. Chunked typing produced "-4empQA-T": the caret jumped to the start of the field between chunks.
  - "Input lag: typed text in name fields shows late."
- **Repro:** Sidebar "Create a Bot". Type a name in two or three bursts with short pauses, then click Create immediately after the last keystroke.
- **Expected:** The Bot gets exactly the typed name. The caret never moves on its own. No keystroke typed into the create form ends up in another field.
- **Likely root cause (not fully confirmed, see section 5):**
  1. `web/src/components/modals/CreateBotModal.tsx` `submit` (line 86) reads `nameInput.current.value` at click time, which fixes the stale React state case from round 1 but not lag: if the main thread is busy, the DOM value at click time can still be partial while later keystrokes are queued. On success it calls `openConversation(bot.id)` (line 103) and the chat composer autofocuses, so the queued keystrokes land in the composer.
  2. The form re-renders on every `bots` store change (`useStore(s => s.bots)`, line 24) and on SSE updates; together with the lazy `Suspense` boundary in `web/src/App.tsx` (lines 109 to 115) a remount of the input is the most likely cause of the caret reset: a newly mounted `autoFocus` input in Chrome places the caret at the start while the value is restored from state.
- **Fix direction:** Profile typing in the create form (React Profiler) and remove the expensive re-renders (select only what is needed, for example a memoized duplicate check; avoid re-creating the form subtree). Make sure the input is never remounted while open (stable keys, no conditional wrapper swap). Disable Create until the input has been idle for about 150 ms after the last `input` event, or read the value in a `requestAnimationFrame` after the click. After creation, do not autofocus the composer for about 300 ms, or focus it only after the user clicks.
- **Acceptance:** A scripted test that types "QA-Temp-9" in three chunks with 200 ms pauses and clicks Create 10 ms after the last chunk creates "QA-Temp-9", leaves the composer empty and never reports a caret position other than the end during typing.
- **Test to add:** new `tests/create-bot-ui.mjs` (Playwright, `page.keyboard.type` with delays, CPU throttling 4x via CDP `Emulation.setCPUThrottlingRate`).

### R2F-006 Email draft request returns plain text, never a draft card
- **Priority:** P1. **Area:** chat cards. **Old id:** F-067 under MF-010. **Check:** R2-028 FAIL.
- **Observed:** After Skip setup (banner cleared in one click, Setup "Active configuration Revision 5"), "write an unsent hello email draft" returned plain text: "Unsent draft only. Nothing was sent. To: [name] ...". No draft card, no Copy draft button.
- **Repro:** On an active test Bot, ask "write an unsent hello email draft".
- **Expected:** A draft card (channel Email, To, Subject, body) with Copy draft, and nothing sent.
- **Likely root cause:** the draft card exists only in the client. `server/src/types.ts` (lines 174 to 183) defines `card: 'draft'` and `web/src/components/cards/Cards.tsx` `DraftCard` (lines 150 to 180) renders it with "Copy draft", but no server code ever writes a `card: 'draft'` row (searching `server/src` for `card: 'draft'` finds only the type). No tool lets the model produce it, so the model can only answer in text.
- **Fix direction:** Add a `present_draft` tool in `server/src/agent/tools.ts` (args: `channel` email|slack|message, `to`, `subject?`, `text`) that appends a `card: 'draft'` row with `status: 'pending'` and no approval id, and returns "Draft shown to the user. Nothing was sent." Allow it during normal turns, not during setup. Add a prompt line in `server/src/agent/prompt.ts`: "When the user asks for a draft they will send themselves, call present_draft instead of pasting it." Discard and Copy work client side. (PD-R2-04.)
- **Acceptance:** The request above shows a draft card with Copy draft; nothing is sent; the card survives reload; voice summary (`server/src/voice.ts:139,345`) still reads "A draft to review".
- **Test to add:** server test with the mock provider calling `present_draft`: one card row of type draft, no `approvals` row, no app call. UI script asserting the Copy draft button.

### R2F-007 Phone layout: "Back to Bots" goes to Goals instead of the Bot list
- **Priority:** P1. **Area:** mobile navigation. **Old id:** MF-039 area (F-032). **Check:** R2-021 FAIL.
- **Observed:** DevTools iPhone 16 preset (393x852): "Back to Bots" went to Goals instead of the Bot list. (The tester also noted the device toolbar W and H fields rejected typing; that part is a tool issue.)
- **Repro:** Desktop: open Tasks > Goals, then open a Bot chat. Switch DevTools to a phone preset. Tap the back control in the chat header.
- **Expected:** Back always shows the Bot list on a phone.
- **Likely root cause (to confirm):** `web/src/store.ts` `backToList` (lines 311 to 315) calls `history.back()` whenever `history.state?.swarmPane === 'chat'`. That walks to whatever entry is before it in browser history (for example a Goals or Settings state), not to the list. Also `web/src/App.tsx` (line 105) forces `pane-chat` while `view === 'tasks'`, so if `view` is still `tasks` the Tasks/Goals page stays on screen. The visible label "Back to Bots" means `mobile` was false when rendered (`ChatView.tsx:43-44` shows "All Bots" on phones), so the `matchMedia(PHONE_QUERY)` listener in `App.tsx:43` may not have updated after the emulation switch.
- **Fix direction:** Make `backToList` set `mobilePane: 'list'` and `view: 'chat'` explicitly and only call `history.back()` when the previous entry is known to be the list (store a marker). Re-evaluate `mobile` on `resize` as well as on the media query change.
- **Acceptance:** On 390x844 and 393x852, from any page (chat, Tasks, Goals, Reports, Bot settings, create), back shows the Bot list; browser Back behaves the same.
- **Test to add:** extend `tests/mobile-layout.mjs`: visit Goals, open a chat, tap back, assert the list is visible.

## P2: wrong behavior with a workaround, confusing state, test gaps

### R2F-008 New group chat picker allows Bots that are still in setup
- **Priority:** P2. **Old id:** MF-034. **Check:** R2-031 FAIL (R2-032 PASS for the members card).
- **Observed:** The New group chat member picker lets setup-state Bots (QA-Temp-1, LinkedIn Brand Manager, Lead Generation) be selected, with no "Activate first". The members card Add list does show "Activate first". QA-Temp-1 is in setup yet already a member of QA-Temp-Group.
- **Expected:** Setup Bots are listed disabled with "Activate first" in the picker, matching the members card. Existing memberships of setup Bots are shown with a "Still in setup" note.
- **Likely root cause:** `web/src/components/modals/CreateGroupModal.tsx` (lines 75 to 80) renders every Bot as an enabled checkbox; it has no `configuring` check. `web/src/components/MembersCard.tsx` (line 28) has the check. The server rejects later in `server/src/routes-rooms.ts` (lines 16 and 17, "Activate ... before adding it to a group."), so the user only learns after Create. The pre-existing membership predates the round 1 rule.
- **Fix direction:** Share the `configuring(bot)` helper from `MembersCard.tsx` and disable those rows in the picker with "Activate first". Show the server message inline if it still happens.
- **Acceptance:** Setup Bots cannot be checked in the picker. Creating a group with two active Bots still works.
- **Test to add:** UI script for the picker (extend `tests/updated-ui.mjs`).

### R2F-009 Rename leaves the old name in the setup greeting and later messages
- **Priority:** P2. **Old id:** MF-035 (partial). **Check:** R2-026 FAIL.
- **Observed:** QA-Temp-3 (created as "QA", see R2F-005) renamed to "QA-Temp-3b" in setup. The sidebar updated, but the chat opening question and later messages still say "What job would you like QA to handle?". Rename of QA-Temp-1 updated sidebar, header, sender labels and the Instructions helper (PASS for those).
- **Expected:** After a rename, the greeting and any Bot-authored setup text that names the Bot use the new name, and the Bot uses the new name in new replies.
- **Likely root cause:** `server/src/bot-setup.ts` `renameSetupGreeting` (lines 496 to 507) rewrites only when the Bot is still configuring, only the latest assistant message, and only for two exact prefixes. Here a later assistant reply existed (R2-025 setup reply), so nothing was rewritten. The model history (`appendHistory`) also keeps the old name, so new replies can repeat it.
- **Fix direction:** Rewrite the first assistant greeting of the current generation regardless of position (match by an explicit `greeting: true` marker on the row body instead of the text prefix). Add a system note to history on rename: "Your name is now <new>." Apply to active Bots too.
- **Acceptance:** Renaming a setup Bot and an active Bot updates the greeting row and the next reply uses the new name.
- **Test to add:** extend the qa-ws2 rename test with a later assistant row present.

### R2F-010 Details "See all tasks" opens Tasks for All Bots, not this Bot
- **Priority:** P2. **Old id:** F-083. **Check:** R2-061 FAIL.
- **Observed:** Details "See all tasks" opens Tasks with Filter by Bot "All Bots". The Goals link is scoped correctly.
- **Likely root cause:** `web/src/components/config/TasksView.tsx` `BotTasks` (line 276): `onClick={() => openWorkspace('Tasks')}` omits the Bot id, while Goals passes it (`openWorkspace('Goals', bot.id)`, line 279).
- **Fix direction:** Pass `bot.id`. Show a "Showing tasks for <Bot>" chip with a clear filter control.
- **Acceptance:** See all tasks opens Tasks filtered to that Bot.
- **Test to add:** `tests/tasks-layout.mjs` assertion on the filter value.

### R2F-011 No "Computer settings" link in the viewer or the Details Computer row
- **Priority:** P2. **Old id:** F-095, F-097. **Check:** R2-064 PARTIAL/FAIL.
- **Observed:** The viewer streams, but there is no "Computer settings" link in the viewer or the Details Computer row. Shot `/tmp/computer-use/sand-subagent-43bf5aa6-5dc3-dd9a-c0dd-d0c45832a24d.5cf92c91-45c4-4147-b810-4437672c7cba.webp`.
- **Likely root cause:** `web/src/components/ComputerViewer.tsx` renders the Computer settings button only in the asleep overlay when `computer?.provider === 'local'` (line 143). The cloud computer path and the streaming state have no link. `web/src/components/DetailsPanel.tsx` (lines 74 to 80) has only "Open computer".
- **Fix direction:** Add a "Computer settings" button to the viewer header for all providers and a secondary link in the Details Computer section, both calling `useConfigUI.getState().openAppSettings('computer')`.
- **Acceptance:** From the streaming viewer and from Details, one click opens Settings > Computer.
- **Test to add:** `tests/device-access-ui.mjs` or the fixed `tests/viewer-wake.mjs` (R2F-020).

### R2F-012 History rows lack the source revision; header naming differs
- **Priority:** P2. **Old id:** MF-046. **Check:** R2-067 FAIL.
- **Observed:** History rows read "Change 9 · profile · updated", "Change 2 · setup · created", no "revision M". Header "Agent history" vs "Setup".
- **Likely root cause:** `web/src/components/config/AgentHistory.tsx` (line 76) appends "revision M" only when `entry.sourceRevision !== null`. The evolution triggers for `profile` (table `bots`) and `setup` (table `bot_setups`) in `server/src/knowledge/evolution-schema.ts` (lines 71 to 82) build `values(...)` without a `revision`, so `source_revision` is always NULL for these kinds, although `bot_setups.revision` exists.
- **Fix direction:** Pass `revision:'NEW.revision'` for the `setup` trigger and the Bot's brief revision for `profile` (or the matching `bot_setups.revision` via subquery). For rows that truly have no revision, show "no revision" consistently. Align the header: the tab is "History" and the page title "<Bot> · History" (`AgentConfiguration.tsx:141`, `AgentHistory.tsx:52`).
- **Acceptance:** New setup and profile changes show "Change N · setup · updated · setup revision M". Header text matches the tab label.
- **Test to add:** extend `tests/agent-evolution.test.mts` and `tests/agent-history-ui.mjs`.

### R2F-013 Search hit opens the chat but does not visibly highlight the message
- **Priority:** P2. **Old id:** MF-028. **Check:** R2-015 PARTIAL.
- **Observed:** A message hit opens QA-Temp-1 but there is no visible highlight of the target message. Shot `/tmp/computer-use/sand-subagent-63e0e0b4-c4ca-c453-2791-54f13b248f7b.8b529500-f279-4c46-90de-7aedcbc4bae9.webp`.
- **Likely root cause:** `web/src/lib/scrollToRow.ts` adds the class `is-search-hit` (line 13) but no stylesheet defines it (searching `web/src` for `is-search-hit` finds only that file).
- **Fix direction:** Add a CSS rule (for example a 1.6 s background pulse on `.bubble-wrap.is-search-hit` and `.notice.is-search-hit`) respecting `prefers-reduced-motion`.
- **Acceptance:** The target row scrolls to center and visibly highlights.
- **Test to add:** UI script asserting the computed background of the hit row changes.

### R2F-014 The primary Bot's name appears outside the Team subtitle
- **Priority:** P2. **Old id:** MF-065. **Check:** R2-056 FAIL.
- **Observed:** "Saved reports · Quinn" subtitle, "Report Bot: Quinn" dropdown, Daily synopses "Quinn's scheduled summaries", page title "Quinn · Routines". Shot `/tmp/computer-use/sand-subagent-afb04d5e-bdff-7e7e-51cd-1a61ed030bb0.dc124141-a017-4aed-b586-f6a165048eac.webp`.
- **Likely root cause:** `web/src/components/config/WorkReports.tsx` (lines 24, 25 and 28) builds titles and subtitles from `${name}`; `TasksView.tsx` (lines 173 and 176) puts `scopeLabel` (the selected Bot name) into every subtitle.
- **Fix direction:** Titles are fixed: "Reports", "Daily synopses", "Routines". Name the Bot only where a Bot is selected by the user (a "Bot" filter control), and keep the primary's name only in the Team subtitle per PD-06.
- **Acceptance:** Tab labels and titles read Tasks, Team, Goals, Reports and their sub pages without a Bot name unless filtered.
- **Test to add:** `tests/tasks-layout.mjs` text assertions.

### R2F-015 "Open Bot details with each chat" does not apply after reload
- **Priority:** P2. **Old id:** MF-024. **Check:** R2-069 PARTIAL.
- **Observed:** The setting persists and closing the panel does not flip it, but after reload the restored chat does not auto-open details (only on Bot switch).
- **Likely root cause:** `web/src/store.ts` restores the selected Bot with `get().selectBot(selectedBotId, { open: false })` (line 132), which skips `readDetailsDefault` (line 139).
- **Fix direction:** On restore, open details when `readDetailsDefault(user.id)` is true and not on mobile.
- **Acceptance:** With the setting on, a reload shows details open on the restored chat.
- **Test to add:** `tests/ui-store.test.mts` case for restore.

### R2F-016 Routine run history does not refresh after runs
- **Priority:** P2. **Old id:** F-107. **Check:** R2-077 (suspect).
- **Observed:** "History 'No recorded runs yet.' with Refresh run history (even after 2 runs: suspect)."
- **Likely root cause:** runs are recorded (`server/src/routines.ts` `runRoutine` calls `reserveRoutineRun`, `server/src/deliverables/runs.ts:30`), but `web/src/components/config/RoutineHistory.tsx` `RunHistory` reloads only when `revision` changes (manual Refresh) and does not listen for `routines` SSE events emitted by `server/src/routes.ts` routine routes.
- **Fix direction:** Bump the reload key on `routines` events for the Bot (`useVersion('routines:<botId>')` or the existing store `loadRoutines` hook in `web/src/store.ts:227`) and after a successful Run now.
- **Acceptance:** After Run now, the history shows the run within 2 s without Refresh.
- **Test to add:** UI script with a mocked run.

### R2F-017 Time zone: synopsis line stale until Refresh; schedules may keep the first zone
- **Priority:** P2. **Old id:** MF-017. **Check:** R2-082 PASS with note, R2-058, code review.
- **Observed:** Changing Settings > Account > Time zone to Europe/London moved the synopsis to "09:00 · Europe/London" and restoring Asia/Dubai worked, but the Tasks synopsis line stayed stale until "Refresh synopses" was clicked.
- **Likely root cause:**
  1. `web/src/components/config/SynopsesPanel.tsx` reloads only on its own `revision` state (Refresh button, line 82); nothing bumps it when the account zone changes.
  2. Code review suspect not disproved: `server/src/proactive.ts` `adoptAccountTimezone` (lines 159 to 167) updates only rows `WHERE timezone_source='utc_fallback'`, so a second change through `PATCH /api/auth/me` (`server/src/routes.ts:67-68`) does not update `proactivity.timezone`. The display may read `users.timezone` while the scheduler keeps the first zone. `routines.timezone` still defaults to `'UTC'` (`server/src/db.ts:133`) and is not touched.
- **Fix direction:** Make `adoptAccountTimezone` update `proactivity` rows whose source is `utc_fallback` or `account` (never `explicit` user overrides), and recompute pending slots. Default new routines to the account zone. Emit an SSE event on zone change and refresh SynopsesPanel on it.
- **Acceptance:** Two consecutive zone changes both move the next synopsis slot (check `proactive_due_slots`), the line updates without Refresh, and a new routine uses the account zone.
- **Test to add:** extend the qa-ws1 MF-017 test with a second change; UI assertion in `tests/synopsis-ui.mjs`.

### R2F-018 Wake errors live only in memory and show raw provider text
- **Priority:** P2. **Old id:** MF-019 (code review). **Check:** R2-063 could not reach the error state live.
- **Likely root cause:** `server/src/routes.ts` `ensureErrors` is a module `Map` (line 538), lost on restart. `wakeComputer` (lines 544 to 553) stores `String(e.message).slice(0, 300)` and `ComputerViewer.tsx:151` shows it verbatim, which can expose provider internals.
- **Fix direction:** Map known errors to user copy ("The computer could not start. Try again in a minute."), log the raw text server side only, persist the last error with timestamp in a small table or `computers` state so it survives restart, clear it on success.
- **Acceptance:** A forced ensure failure shows the generic text and Try again; raw text never reaches the client; error survives a server restart until the next attempt.
- **Test to add:** qa-ws1 test with a failing fake provider asserting the response body has no raw message.

### R2F-019 Message size cap applies after full JSON parse; no byte limit
- **Priority:** P2. **Old id:** MF-009 (code review). **Check:** R2-039 PASS for the UI cap.
- **Likely root cause:** `server/src/routes.ts` checks `text.length > MAX_MESSAGE_CHARS` (lines 190, 400 and 442) after `readJson` has read and parsed the whole body. `hono/body-limit` is used only in `server/src/auth/apple.ts:71`, `server/src/native-auth.ts:66` and the Composio gateway.
- **Fix direction:** Add `bodyLimit({ maxSize: 256 * 1024 })` on `/api/bots/*`, `/api/rooms/*` and card answer routes, returning 413 with the same error text.
- **Acceptance:** A 5 MB body is rejected with 413 before parsing; normal messages work.
- **Test to add:** qa-ws1 test posting 300 KB.

### R2F-020 UI test `tests/viewer-wake.mjs` fails on a stale selector
- **Priority:** P2 (test gap hides MF-036 regressions). **Old id:** MF-036. **Check:** backend-results section 3.
- **Observed:** The script times out waiting for `.panel-row--computer` (`tests/viewer-wake.mjs:110`). No component renders that class.
- **Root cause:** the Details Computer row is now `button.bot-detail-link[aria-label="Open computer"]` in `web/src/components/DetailsPanel.tsx:77`.
- **Fix direction:** Use `page.getByRole('button', { name: 'Open computer' })`. Keep the "Waking Quinn's computer..." assertions (lines 161 to 176) or derive the name from the fixture. Add it to a CI gate script.
- **Acceptance:** `node tests/viewer-wake.mjs` passes against `vite preview`.
- **Test to add:** the fixed script itself.

### R2F-021 Computer status wording differs between the coworker card, Activity and Setup
- **Priority:** P2. **Old id:** MF-023. **Check:** R2-054 INCONCLUSIVE.
- **Observed:** Coworker card "Computer ready" vs Activity "Bot's computer · Awake"; the Setup tab has no computer status line.
- **Likely root cause:** `web/src/components/CoworkerSetupCards.tsx:74` uses `setup.computer.status === 'ready'` with its own copy; `DetailsPanel.tsx` `computerStatusText` (lines 23 to 31) uses "Awake"/"Asleep"; `AgentConfiguration.tsx` shows a computer section only when `data.computer.status === 'pending'` (line 203).
- **Fix direction:** One helper for computer readiness copy used in all three places, and a one-line status on the Setup tab in every state.
- **Acceptance:** The same state reads the same words in the card, Activity and Setup.
- **Test to add:** `tests/central-setup-ui.mjs` assertion.

## P3: polish, copy, small layout issues, hardening

### R2F-022 Tab bars shift when the active tab changes
- **Old id:** MF-045. **Checks:** R2-022 FAIL, R2-059, R2-056 note.
- **Observed:** Tasks page tab bar shifts about 65 px horizontally (Tasks x229 to x294 when Team active) and about 14 px down on Goals where the header wraps; "Tasks area tab bar y shifts 162 vs 177 between pages". Bot details tabs shift 1 to 7 px when the panel scrollbar appears or disappears; the close X moves from 1250 to 1257. Shots `/tmp/computer-use/sand-subagent-b47979d1-de9d-620d-ec92-cb43698a5d89.e06d07a6-7e0a-44c2-b5e8-c6007fd72dc3.webp`, `...57690a5c-64bf-4527-9f6a-c34be7e97e17.webp`.
- **Likely root cause:** `web/src/styles/tasks.css:3-4`: `.tasks-view__inner` is 720 px wide but `.is-board` (Tasks tab, `TasksView.tsx:197`) is 1000 px, so the centered tab bar moves. The heading above the tabs (`TasksView.tsx:198-200`) is a one-line sync chip on Tasks but a wrapping subtitle paragraph elsewhere. The Details panel scroll container has no `scrollbar-gutter: stable`.
- **Fix:** Keep the tab bar at a fixed width and position (render tabs above the heading or give the heading block a fixed min-height; apply the board width only to the board content). Add `scrollbar-gutter: stable` to the Details and Tasks scroll containers.
- **Acceptance:** Tab buttons keep the same bounding boxes across tabs (within 1 px). **Test:** extend `tests/tasks-layout.mjs` and `tests/bot-details-ui.mjs` with bounding box checks.

### R2F-023 Layout at about 1014x759: composer expands and layout looks off
- **Check:** R2-021. **Observed:** "At ~1014x759 composer expands and layout looks off." **Fix:** reproduce at 1024x768 with Settings open and closed, compare with the MF-039 compact mode rules in `web/src/components/config/AppSettings.tsx` and `Sidebar.tsx`, fix the composer max-height. **Test:** screenshot check in `tests/mobile-layout.mjs` at 1024x768.

### R2F-024 Sidebar has no visible "Your Bots" heading or primary marker
- **Check:** R2-011 FAIL/PARTIAL. **Observed:** no "Your Bots" sidebar heading, no "Your primary Bot" label on the Quinn row, no status dots or unread badges visible (shot `/tmp/computer-use/sand-subagent-63e0e0b4-c4ca-c453-2791-54f13b248f7b.880510cb-8354-442d-b899-c07d589e330d.webp`). **Root cause:** `web/src/components/Sidebar.tsx` uses "Your Bots" only as `aria-label` (lines 95 and 97); the primary row shows `primary.label || 'Your primary Bot'` (line 126), so a labelled primary never says it is primary. Status dots render only when running, awaiting or unread (line 49), which is by design. **Fix:** add a visible "Your Bots" section label and a small "Primary" tag on the pinned row. **Test:** UI text assertion.

### R2F-025 Copy inconsistencies
- **Check:** batch 1 notes. **Observed:** Details panel "Bot's computer" (`web/src/components/DetailsPanel.tsx:78`) vs Settings "Bots' computer" (`AppSettings.tsx:491`, `MessagingSettings.tsx:491`). Home button "Create bot" (`web/src/components/BotsView.tsx:15`) vs sidebar "Create a Bot". **Fix:** "Bot's computer" in per-Bot surfaces, "Your Bots' computer" in account surfaces is fine if intended; at minimum change "Create bot" to "Create a Bot". **Test:** text assertion.

### R2F-026 Expired app rows show lowercase slugs ("notion", "slack")
- **Check:** R2-051 note. **Root cause:** `web/src/components/config/AppSettings.tsx` `accountDetails` (about line 898): `const name = app?.name ?? c.toolkit;` falls back to the raw slug when the catalog has no entry. **Fix:** fall back to a title-cased name (reuse the server `appName` mapping or a client copy). **Test:** unit test of the fallback.

### R2F-027 Offline permissions error shows raw "Failed to fetch"
- **Check:** R2-085 PASS with minor. **Observed:** "Couldn't load permissions. Failed to fetch" + Retry. **Root cause:** `AppSettings.tsx:773` appends `{loadError}` (the browser error text). **Fix:** map network errors to "Check your connection." **Test:** `tests/access-settings-ui.mjs`.

### R2F-028 Deep links and Back: General has no hash, Bot settings not linkable, Alt+Left jumps
- **Checks:** R2-081 minor, batch 7 extra. **Observed:** "General has no hash". "Ctrl+R on a settings page returns to chat (settings not deep-linked)" for Bot settings. "Alt+Left from Settings > Learning went to Settings > Computer." **Root cause:** `web/src/configStore.ts` `openAppSettings` (lines 107 to 110) writes a hash only for `SECTIONS_LINKABLE`; `openBotSettings` (line 105) writes nothing. History entries from earlier pushes remain, so Back lands on an older section. **Fix:** add `general` to linkable sections; add `#bot/<id>/settings/<tab>` with the same replaceState pattern; keep one history entry per Settings visit. Full router stays a follow-up (PD-R2-07). **Test:** extend qa-ws4 hash tests.

### R2F-029 Tasks header "Back to chat" text is not clickable
- **Check:** batch 6 minor. **Observed:** "Tasks 'Back to chat' text not clickable on first click, arrow works." **Root cause:** `web/src/components/config/TasksView.tsx` (about lines 191 to 193): the label `<span>{... 'Back to chat'}</span>` is a sibling of the icon button, not inside it. **Fix:** put the label inside the button. **Test:** click on the text in `tests/tasks-layout.mjs`.

### R2F-030 Escape in the model picker needs two presses
- **Check:** batch 4 minor. **Observed:** "Escape in model picker first moves focus to Effort row instead of closing popup; needs second Escape." **Root cause:** `web/src/components/ComposerModelMenu.tsx` (lines 136 to 140) closes only when `view === 'main'`; check whether focus on the Effort row sets `view` to effort. **Fix:** Escape closes the picker from the main view regardless of focused row. **Test:** keyboard test in `tests/updated-ui.mjs`.

### R2F-031 Composer loses focus after answering an approval card
- **Check:** batch 5 minor. **Observed:** "after an approval card, composer loses focus; first typing goes nowhere." **Fix:** after an approval or question card resolves, return focus to the composer (`web/src/components/Composer.tsx` ref, called from `web/src/components/cards/Cards.tsx` handlers). **Test:** UI script.

### R2F-032 Import: file input says "No file chosen"; imported Bot has empty About and Instructions
- **Check:** R2-030 PASS with notes. **Observed:** "File input still shows 'No file chosen' while page says 'Selected: bot-setup.json'." "About and Instructions empty after import." **Root cause:** `web/src/components/modals/CreateBotModal.tsx:136` clears the input (`event.target.value = ''`) after reading. For the empty fields, check whether the exported manifest carries `description` and `instructions` and whether `importTeammate` (`server/src/agent/teammates.ts:140`, `createBot(userId, { ...m.bot, ... })`) maps them; the source Bot was also in setup, so it may have had none. **Fix:** hide the native input after selection and show the file name with a "Choose another file" button; carry About and Instructions through import if present. **Test:** round trip test in `tests/bot-creation.test.mts`.

### R2F-033 First click after closing a modal is sometimes ignored (unconfirmed)
- **Check:** batch 1. **Observed:** "first click after closing Connect apps modal or search palette sometimes ignored." **Fix:** check `web/src/components/modals/Modal.tsx` close path for a lingering backdrop or focus trap during the exit animation; make the backdrop `pointer-events: none` once closing starts. **Test:** UI script that closes and immediately clicks a sidebar row.

### R2F-034 Tasks island scrolls out of view in small windows
- **Check:** batch 2 note. **Root cause:** `<TasksIsland />` is rendered inside the scrolling Bot list (`web/src/components/Sidebar.tsx:118`). **Fix:** make it sticky at the top or bottom of the sidebar. **Test:** layout assertion at 1024x600.

### R2F-035 Analytics cumulative chart peaks before the last bucket
- **Check:** R2-079 minor. **Observed:** "7-day cumulative chart peaks before last bucket." A cumulative series cannot decrease. **Fix:** check the cumulative computation in `web/src/components/config/BotAnalyticsTab.tsx` and `server/src/analytics.ts` (local day buckets added in MF-017) for a bucket ordering or zone boundary bug. **Test:** unit test that the cumulative series is non-decreasing.

### R2F-036 Daily synopsis line does not name its source account
- **Old id:** MF-054 / MF-017. **Check:** R2-058. **Observed:** "Daily synopses 'Paused · 09:00 · Asia/Dubai' ... No source account on synopsis line." The verify plan expected the source account. **Fix:** add the source (for example "from Gmail") to the line in `web/src/components/config/SynopsesPanel.tsx` using the existing `SynopsisSource` data. **Test:** `tests/synopsis-ui.mjs`.

### R2F-037 `/api/bots/import` still uses raw `c.req.json()`
- **Old id:** MF-014 follow-up (found while tracing R2F-032). **Root cause:** `server/src/routes.ts:217` calls `await c.req.json()` inside a try that maps every error to 400 with the raw message. **Fix:** use `readJson(c)` like the other handlers. **Test:** qa-ws1 malformed body case.

### R2F-038 Security header follow-ups
- **Source:** backend-results 1.2. **Observed:** CSP allows `connect-src 'self' https: wss:` and `img-src ... https:`; `Permissions-Policy` is absent. **Fix:** narrow `connect-src` to self plus the configured voice host (`server/src/security/request.ts` `contentSecurityPolicy`), add `Permissions-Policy: camera=(), geolocation=(), microphone=(self)`. **Acceptance:** voice still works; curl shows the new headers. **Test:** extend qa-ws1 header test.

---

# 3. Product decisions

Each has a RECOMMENDED DEFAULT. Implement the default in this PR unless it is impossible; list applied decisions in the PR body.

| ID | Question | Options | RECOMMENDED DEFAULT |
|---|---|---|---|
| PD-R2-01 (MF-056) | Sidebar order now uses the last user message only (`server/src/store.ts` `lastActivityAt`). A Bot that posts a routine or proactive result no longer moves up. | A. Keep user-message order. B. Also move up on Bot-originated results, with a debounce. | **A, plus an unread dot for Bot results** (already rendered when `unread > 0`). No reshuffle while Bots work. Revisit after owner feedback. |
| PD-R2-02 | Bot settings > Routines has no create control ("To add or change one, ask in chat."). | A. Chat only. B. Add a simple create form. | **A for now;** add a "Ask <Bot> to add a routine" button that opens the chat with a prefilled prompt. |
| PD-R2-03 | Unsent composer drafts persist per chat. | A. Keep. B. Clear on send only (current). C. Clear on Bot switch. | **A** (keep). It is expected behavior. |
| PD-R2-04 (R2F-006) | How a "draft" is shown. | A. Model text only. B. `present_draft` tool and draft card. | **B.** |
| PD-R2-05 (R2F-001) | What a group turn may access. | A. Read-only apps. B. No app tools at all in group turns. | **B** (simplest and safe). The Bot answers from group context and says to ask in its own chat for app work. |
| PD-R2-06 | Second Ctrl+, reopens the last-used Settings tab, not General (R2-017 note). | A. Keep last-used. B. Always General. | **A** (keep). Matches common apps. |
| PD-R2-07 | Full router for Bot settings and Tasks (PD-05 option C). | A. Hash sync only (R2F-028). B. Full router. | **A in this PR;** B as a follow-up. |

---

# 4. Verified fixed in round 2 (PASS list)

Live UI checks that passed after PR #73: R2-001 to R2-005, R2-007 (hash parts), R2-008 (no CSP violations), R2-009 (CSP frame-ancestors none, XFO DENY, HSTS, nosniff), R2-012, R2-013 (streaming Bot stays in place), R2-014, R2-016 (Alt+Shift+N works, Ctrl+N inert), R2-017, R2-018 (badge equals "2 tasks need your input"), R2-019, R2-020 (theme), R2-024 (banner with Review and activate and Skip setup), R2-025 (setup-mode reply not saved to Responsibilities), R2-027 (no literal escape sequences in Files or History), R2-029, R2-030 (duplicate import name error "A Bot with this name already exists. Choose a different name."), R2-032 (remove disabled with "A group needs at least 2 Bots."), R2-035 (no Share button), R2-037 (replies without reload in 3 to 6 s), R2-039 (32,000 cap inline error, draft kept), R2-040, R2-041 (one New conversation dialog), R2-042, R2-043 (revision unchanged on model and fast changes), R2-044 (effort cycle and toasts), R2-045, R2-046, R2-047 to R2-049 (Ask before computer toggle, Browser approval card, Always allow and Ask again), R2-050 (expired Slack gives a Connect card, Skip works, no `ca_` id), R2-051 (no `ca_` ids in Connected apps), R2-052, R2-055 (Needs you item with Question chip, badge equals Pending), R2-057 (goal delete "Deleted QA goal.", acceptance checks required), R2-058 (synopses in "Asia/Dubai", "No recorded runs yet"), R2-062 (hide suggestion persists), R2-065, R2-066, R2-068 (MF-064 Details caret: "whXYZ123en", fixed), R2-070 to R2-072, R2-074 (Label 40 and About 300 caps, save persists), R2-075 (skills type-to-name, Save resources disabled until change, archive), R2-078 (Learning explains On and Off; "Inherited from the account."), R2-079 (Analytics in Asia/Dubai), R2-081 (`#settings/<section>` and reload), R2-082 (zone change moves synopsis), R2-083, R2-084, R2-085 (offline "Couldn't load permissions." with Retry), R2-086 (only Remote URL Streamable HTTP and legacy SSE), R2-087, R2-088, R2-089 (badge on its own line, "MCP servers" opens `#settings/mcp`), R2-091 (cleanup).

Backend and tests: every round 1 curl smoke test passes; `/api/health` is exactly `{"ok":true}` with `no-store`; HSTS, nosniff, XFO DENY, Referrer-Policy on every response; enforced CSP on HTML; `Server-Timing` gone from public responses; HEAD returns with `Content-Length` in under 60 ms; new MF routes are auth-protected. Typecheck PASS, 730/730 unit tests, 18/19 UI scripts. Round 1 items verified by code plus tests or curl: MF-001, 002, 003, 013, 014, 015, 021, 032, 061, 062, 063.

Also confirmed safe: on Bot settings, "Save changes" is disabled until an edit exists (`BotSettingsModal.tsx:224`), so a click with no edits changes nothing.

---

# 5. Not fully root-caused (verify first)

- **R2F-001:** whether the observed 1:1 rows and the Slack card are new or left over from round 1 (identical text). The query in the item settles it. The code gaps listed are real either way. The AsyncLocalStorage audience path for the native runner is a hypothesis.
- **R2F-005:** the caret jump and lag. The submit-time read is correct; the remount and render-cost causes are hypotheses. Part of the first-pass failure may come from the test tool's typing, but the caret jump appears with plain chunked typing.
- **R2F-007:** the exact path from the phone back control to Goals. `backToList` using `history.back()` is the most likely cause.
- **R2F-023, R2F-033, R2F-035:** observed once, no code cause found yet.

---

# 6. Implementation plan for the coordinator

## 6.1 Work streams and file ownership

Use one integration branch, `qa/master-fix-r2-20261122`. A file is owned by one stream; others ask the owner.

| Stream | Owns files | Items |
|---|---|---|
| **WS1 Agent runtime and server** | `server/src/agent/loop.ts`, `server/src/agent/rooms.ts`, `server/src/store.ts`, `server/src/usage-context.ts`, `server/src/cli/*` (audience only), `server/src/agent/tools.ts`, `server/src/agent/prompt.ts`, `server/src/agent/app-connections.ts`, `server/src/agent/teammates.ts`, `server/src/bot-setup.ts`, `server/src/coordination/requests.ts`, `server/src/proactive.ts`, `server/src/routes.ts`, `server/src/db.ts`, `server/src/knowledge/evolution-schema.ts`, `server/src/security/request.ts`, new `server/src/lib/redact.ts` | R2F-001, 002 (server), 006 (server), 009, 012 (server), 017 (server), 018, 019, 032 (server), 037, 038 |
| **WS2 Web chat and shell** | `web/src/App.tsx`, `web/src/store.ts`, `web/src/configStore.ts`, `web/src/components/Sidebar.tsx`, `ChatView.tsx`, `Composer.tsx`, `ComposerModelMenu.tsx`, `ComputerViewer.tsx`, `AgentExchangeGroup.tsx`, `CoworkerSetupCards.tsx`, `BotsView.tsx`, `web/src/components/cards/*`, `web/src/components/modals/*`, `web/src/lib/scrollToRow.ts`, web CSS for chat | R2F-002 (web), 004 (store and sidebar), 005, 006 (web), 007, 008, 011 (viewer), 013, 015, 023, 024, 025, 030, 031, 032 (web), 033, 034 |
| **WS3 Web settings and work area** | `web/src/components/config/*`, `web/src/components/DetailsPanel.tsx`, `web/src/styles/*` | R2F-003, 004 (BotSettingsModal guard UI), 010, 011 (Details link), 012 (web), 014, 016, 017 (web), 021, 022, 026, 027, 028, 029, 035, 036 |
| **WS4 Tests** | `tests/*`, `package.json` scripts | R2F-020, and test wiring for every item |

## 6.2 Order

1. P0 first (R2F-001, R2F-002), with their tests, merged to the integration branch.
2. Then P1 (R2F-003 to 007), then P2, then P3.
3. Integrate, run all checks, open one PR, merge, let the deploy workflow run, verify live.

## 6.3 Definition of done

1. `npm ci && npm run typecheck` passes.
2. Existing tests stay green: at minimum `npm run test:qa`, `test:onboarding`, `test:google-auth`, `test:usage`, `test:models`, `test:native-auth`, `test:deployment`, `node --import tsx --test tests/bot-creation.test.mts tests/ui-store.test.mts tests/cli-account-client.test.mts`, the hermes-native unit set, and the UI scripts listed in backend-results section 3 (start `vite preview` on the fixed port where a script needs it), including the fixed `tests/viewer-wake.mjs`. Record any test that was already failing at baseline (`tests/bot-creation-chat.mjs`, `browser-recovery.test.mts` 2/14) in the PR body.
3. New tests for every P0 and P1 item, and cheap ones for P2 and P3 where listed.
4. One PR to `main` titled `QA master fix round 2: 2026-11-22` with a checklist of R2F-001 to R2F-038 (done, partial with reason, or not done with reason) and the PD-R2 decisions applied.
5. Merge to `main`. The "Deploy Fly staging" workflow deploys it.
6. Verify `curl -s https://swarm-team.fly.dev/api/version` shows `revision` equal to the merge commit SHA, `/api/health` is still exactly `{"ok":true}`, and `curl -sI https://swarm-team.fly.dev/` still shows CSP, HSTS, nosniff and frame protection.

---

# 7. Guardrails

1. No secrets in code, tests, fixtures, logs, commits or the PR body. Do not print env values.
2. No destructive data changes: no table drops, no row deletes outside explicit user actions, additive idempotent migrations only (follow the `addColumn` pattern in `server/src/db.ts`). A rollback must still boot on the migrated DB. Do not touch the QA test Bots or any real Bot in the live account. Read-only queries for R2F-001 evidence are allowed.
3. No force push, no history rewrite on `main`.
4. Keep approvals at least as strict as today. No change may turn an `ask` into an `allow`. Group turns get fewer capabilities, never more.
5. Do not send any real external message (email, Slack, SMS) while testing; use the mock provider and fake Composio clients.
6. Keep existing tests green; do not delete or skip a test to make the run pass.
7. No em dashes or en dashes in new UI copy, docs or PR text. No person's name in code, docs or PR text.
