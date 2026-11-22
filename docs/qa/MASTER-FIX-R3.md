# Round 3 leftovers (MASTER-FIX-R3)

You are the implementer for the round 3 leftover defects only. Do not take on the swarm logo processing animation, the per-model effort picker, plan connections, or suggested-integration ranking, except where a leftover touches the same files: rebase and do not revert those other PRs.

## Your job
1. Read this brief fully. Commit it unchanged as `docs/qa/MASTER-FIX-R3.md` on your branch.
2. Implement every leftover item below. Priorities: P0 first, then P1, then P2, then P3. Root causes are "likely": verify in the code before changing, and correct course if the code says otherwise. Do not skip items silently.
3. If this environment lets you spawn more agent sessions, spawn a reviewer or tester at model `gpt-6-astra` and effort `ultra` (agent `codex`). Do not silently pick a different model or effort. If those values are not offered, stop and report the exact mismatch.
4. Checks before the PR: `npm ci && npm run typecheck` (server and web), the unit suite used in round 3 (758 tests were green at 9f2481a), and the UI scripts that cover the files you change. Add the tests each item lists. Keep every existing test green.
5. One branch and ONE PR to `main` titled `QA master fix round 3 leftovers: 2026-11-23`. The PR body has a checklist of every id in this file, each marked done, partial (with what is left), or not done (with the reason).
6. Merge only when CI is green, and only after the other four R3 PRs have merged (loader, suggested integrations, effort picker, plan connections), then rebase onto that `main`. If one of those PRs is delayed, rebase onto the latest of them rather than overwriting their files. Watch CSP (`img-src`) so you do not undo the logo proxy or allowlist from suggested integrations. Watch `Composer.tsx` and `ComposerModelMenu.tsx` for clashes with the effort and plan PRs. The "Deploy Fly staging" workflow deploys `main`. Do not run a manual `fly deploy` unless the workflow fails.
7. Guardrails: never commit or print secrets; no destructive data changes; no force push; never loosen approval checks; never send real external messages while testing; do not touch live QA test Bots or real Bots; no em dashes or en dashes in PR text, docs or new UI copy; no person's name in code, docs or PR text.

## Repo and live app

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Commit tested | `main` @ `9f2481a2c805e86d1af93a43cf6703e18f5bfd19` (PR #74, live) |
| Live app | https://swarm-team.fly.dev |
| Live QA results | `/workspace/swarm-qa/round3/ui-results.md`, `/workspace/swarm-qa/round3/code-results.md` |
| Time zone for QA | Asia/Dubai (UTC+4) |

Line numbers are against 9f2481a and may drift. Search for the quoted code if a line does not match.

## Sequencing
Merge last of the five. Rebase onto `main` after the other four PRs. Titles to look for: `QA R3: swarm logo processing animation`, `QA R3: suggested integrations with Composio logos`, `QA R3: per-model effort picker names`, `QA R3: plan connections for Claude Max and ChatGPT`.

# Fix list

## P0

### R2F-002 residual: internal ids still visible in cards and chat
- **Live evidence:** Approval cards in QA-Temp-2's chat still show "Account: ca_KIxihCKrE-D2" (Slack) and "Account: ca_pESfPrEqcgnN" (Gmail). Agent exchange text still contains routine ids `rt_aukPXFs6dQee` and `rt_nbjlbdBm97MG`. Quinn chat and Tasks > Team were clean of `req_`, `ca_`, `apr_` in R3-043, but that does not cover cards or `rt_` ids.
- **Likely cause:** `redactInternalIds` (`server/src/lib/redact.ts:10-45`) and `stripInternalIds` (`web/src/lib/stripInternalIds.ts`) handle `ca`, `req`, `apr`, `cli`, `call`, `job`, `room`, `connect`, `bot`. They are applied to briefs, some exchange text, and some cards, but not to plain assistant message bubbles, notices, or all approval card fields (title, detail, args, account lines). The `rt_` routine prefix is not in either regex (`redact.ts:25-26`, `stripInternalIds.ts:13,45`).
- **Fix:** Filter internal ids out of plain assistant text, notices, and every user-visible card field, including "Account: ca_..." lines. Add `rt` (routines) to the server and web patterns with a neutral label such as "routine". Keep Bot names when a resolver exists.
- **Acceptance:** No user-visible `ca_`, `req_`, `apr_`, `rt_`, or other listed internal prefixes in chat bubbles, notices, approval cards, or exchange text. Unit tests for card fields, assistant text, and `rt_` ids. Existing redact tests still pass.

### R2F-001 residual: group turns still get web and X search
- **Live evidence:** Round 3 confirmed group chats no longer leak into 1:1 and no longer send to apps (R3-031..033). Code still attaches provider search on the built-in model path.
- **Likely cause:** `GROUP_TURN_TOOLS` (`server/src/agent/tools.ts:679-686`) is tight, but `server/src/agent/loop.ts:394` still appends `serverTools()` for group turns when no CLI runner is selected. `serverTools()` (`server/src/lib/llm.ts`, the function that returns OpenRouter `web_search` or `web_search` plus `x_search`) is therefore available in a group turn.
- **Fix:** Do not include `serverTools()` (web or X search) on group turns. Keep group tools read-only and inside Swarm.
- **Acceptance:** Group turns cannot call web search or X search on any model path. Unit test covers the built-in model path. Existing R2F-001 tests still pass.

## P1

### R3-093: composer grows too tall on a short window
- **Live evidence:** On an about 830x480 window the composer is about 28% of the window height (limit 18%). The field scrolls inside.
- **Likely cause:** The textarea cap is `max-height: clamp(66px, 18vh, 200px)` (`web/src/styles/chat.css:205`), but the full composer chrome (padding, bar, buttons, model pill) is not capped. `Composer.tsx` `grow` (`:91-108`) sizes the textarea and may not account for chrome versus window height. 18vh of a 480px window is only the field, not the whole block.
- **Fix:** Cap the whole composer (not only the textarea) at 18% of the window height, with a sensible minimum so it remains usable, and keep inner scroll.
- **Acceptance:** At about 830x480, the composer block is at most 18% of the window height. Existing grow tests / chat-shell checks still pass. Re-measure on resize.

### R2F-003: Work area Routines still has instant Run now
- **Live evidence:** Bot settings Routines has "Run <name> now?" confirm (R3-062 PASS). The Work area Routines page still runs immediately from "Run now".
- **Likely cause:** `WorkRoutines.tsx:57` calls `mutate(routine, 'run')` from the button with no `confirmDialog`. Settings already uses `confirmDialog` in `BotSettingsModal.tsx:498`.
- **Fix:** Add the same confirm step on the Work area Routines page ("Run <name> now?", Cancel runs nothing). Do not change the icon in place in a way that shifts layout.
- **Acceptance:** Work area "Run now" asks for confirm; Cancel does not run. Settings path stays confirmed.

## P2 / P3 smaller misses

### R3-061: routine prefill caret and next-run zone
- **Live evidence:** Prefill text is correct and nothing was sent, but the caret lands at the start of the prefill so typing goes in front. Routine card shows "Next tomorrow 9:00 AM" with no zone (zone only appeared in a chat reply).
- **Likely cause:** `prefillComposer` (`Composer.tsx:37-43`) writes the draft and does not place the caret at the end. `nextRunLabel` (`web/src/components/config/ui.tsx:79-89`) returns `Next ${rel} ${time}` and never appends the zone, even when `timeZone` is passed (`BotSettingsModal.tsx:516`).
- **Fix:** Place the caret at the end of a routine prefill (and keep it there when the field is focused after prefill). Include a zone label on the routine card next time (for example "Next tomorrow 9:00 AM Asia/Dubai").
- **Acceptance:** After "add a routine" prefill, typing appends after the template. The card shows the next time and the zone.

### R3-074: tab title stays Swarm on History
- **Live evidence:** Panel header "QA-Temp-R3 · History" is correct, but the browser tab title stays "Swarm".
- **Likely cause:** `AgentConfiguration.tsx:142` sets a details title including History, but `document.title` is not updated anywhere in `web/src` (no `document.title` assignments found). The HTML default stays "Swarm".
- **Fix:** When History (and other Bot details / settings pages the user would bookmark) is open, set the browser tab title to match the panel, for example "<Bot> · History", and restore a sensible default when leaving.
- **Acceptance:** Opening History changes the tab title off the bare word "Swarm" and back when you leave.

### R3-091: mobile Back from Bot settings goes to chat, not the list
- **Live evidence:** Mobile "Back to Bots" goes to the list from Goals, Reports, and Create a Bot. From Bot settings it goes to the Bot chat, not the list.
- **Likely cause:** `backToList` / `onReturnToList` (`store.ts:328`, `App.tsx:58`) reset the view to chat when returning to the list. Opening Bot settings (`configStore.ts:144` `openBotSettings`) does not put a list entry behind the settings view, so Back behaves like closing settings onto the current chat.
- **Fix:** On a phone, Back from Bot settings should land on the Bot list, consistent with Goals, Reports, and Create a Bot.
- **Acceptance:** Phone-sized viewport: Back from Bot settings shows the list, not the chat.

### R3-044: Setup tab computer status missing or inconsistent
- **Live evidence:** Coworker card "Computer: Awake. App access and approval rules still apply." Details "Bot's computer · Asleep". Settings "Bots' computer · Asleep". Bot details Setup tab had no computer status line.
- **Likely cause:** Shared copy lives in `computerStatus.tsx`. `ComputerStatusLine` (`:30-33`) reads `state.computer` from the store (the account computer), not a per-Bot live state. `AgentConfiguration.tsx` renders a line at `:152` and again at `:207` with `setup={data.computer}`. If one branch is behind a review-only section, or CSS hides it, the Setup tab looks empty. Awake vs Asleep is two surfaces reading different sources or stale state.
- **Fix:** Show a computer status line on the Setup tab in every setup state. Card, Details, Settings, and Setup must use the same readiness words for the same state. If the card is wrong when the computer is asleep, fix the source, not the wording only.
- **Acceptance:** Setup tab always shows the status line. The four surfaces agree. A live asleep computer is not labelled Awake.

### R3-041: Original user answers empty; Resources wording is internal
- **Live evidence:** Review sections were clean of ids, but Resources read "User's private Slack account connected account, toolkit slack, revision 1, status EXPIRED". "Original user answers" was an empty disclosure.
- **Likely cause:** `CoworkerSetupCards.tsx:84-85` shows `brief.shared_resources` and "Original user answers" from `source?.sourceRefs` or `source?.messages`. Resources are not rewritten into user-facing words (toolkit, revision, EXPIRED leak through). Answers stay empty when refs and messages are missing, with no honest empty state.
- **Fix:** Humanize Resources (display names, no raw "toolkit", "revision N", or machine status codes). If there are no original answers, say so plainly or hide the empty disclosure. Do not leave a blank disclosure.
- **Acceptance:** Resources are readable and free of internal toolkit revision jargon. Original user answers is either populated or an honest empty state.

### R3-027: import "No file chosen" and lingering duplicate-name error
- **Live evidence:** Before a file is chosen, the native "Choose File  No file chosen" control is still visible. After choose, "Selected: ..." and "Choose another file" work. Duplicate-name error "A Bot with this name already exists." lingered briefly after rename while "Importing...".
- **Likely cause:** `CreateBotModal.tsx` (under `web/src/components/modals/`) hides the native input only after a file is selected (`is-chosen` / selection branch around the "Selected:" UI). The error is cleared on name change (`setError('')` on the name field), but a stale error or a race with "Importing..." can leave it visible.
- **Fix:** Do not show the native "No file chosen" presentation; keep a custom choose control. Clear the duplicate-name error as soon as the name is no longer a duplicate, and never leave it up during a successful import in progress.
- **Acceptance:** Import UI has no "No file chosen" string. Renaming off a duplicate clears the error immediately.

### R3-120: Learning tab does not explain On and Off
- **Live evidence:** Learning tab only shows checkboxes, with no On/Off explanation.
- **Likely cause:** `LearningSettings.tsx:9` and the form (`:15-43`) have checkbox labels and short hints such as "Allow learning for this account or Bot." The On versus Off consequence is not spelled out in the tab.
- **Fix:** Explain what On and Off mean for Learning (account or Bot override) next to the controls.
- **Acceptance:** A first-time user can tell what happens when Learning is on and when it is off.

### R3-121: Settings > Computer has no Linux note
- **Live evidence:** MCP form and catalog were fine. Settings > Computer has no Linux note (mac-only notice).
- **Likely cause:** Computer / device access copy in `AppSettings.tsx` (Computer section around the "Connect your PC" flow) and `DeviceAccessSection.tsx:17-22` talks about macOS permissions. A Linux-specific note is missing even though the pair command already mentions Node on macOS or Linux in one branch.
- **Fix:** Add a clear Linux note on Settings > Computer (how a Linux user connects a PC, and that Mac permission text applies only on macOS).
- **Acceptance:** On a non-Mac browser, Settings > Computer explains Linux clearly.

### R3-115: composer loses focus after Stop
- **Live evidence:** Stop works and shows "Stopped." After Stop, the composer is not focused.
- **Likely cause:** `Composer.tsx:169` `stop` calls `api.interrupt` only. `refocusComposer` / `useRefocusOnResolve` (`web/src/lib/composerFocus.ts`) are wired for cards, not for Stop.
- **Fix:** Return focus to the composer after Stop, unless the user has already moved focus elsewhere.
- **Acceptance:** After Stop, the user can type immediately in the composer.

### R2F-036: wording
- **Live evidence:** Synopses line is "Paused · 09:00 · Asia/Dubai · from your team's records. Saved in Library." Round 2 asked for a source such as "from Gmail"; the implementation describes team records instead, which matches how synopses are built (`SynopsesPanel.tsx:17-21`).
- **Fix:** Keep the wording accurate. If the source is team records, say that clearly in plain language. If a more specific user-facing source can be named without lying, name it. Do not claim Gmail if mail is not the source.
- **Acceptance:** The source clause is accurate, specific enough to trust, and free of internal jargon.

### R2F-038: CSP img-src still allows https:
- **Live evidence:** Live CSP `connect-src` was tightened; `img-src` is still `'self' data: blob: https:` (`server/src/security/request.ts` `contentSecurityPolicy`).
- **Fix:** Tighten `img-src` so it is not a blanket `https:`. Keep `'self'`, `data:`, `blob:`, and any host the app truly needs (user avatars, and the toolkit logo host or proxy from the suggested-integrations PR). If that PR added a same-origin logo proxy, prefer that and do not allow all HTTPS images.
- **Acceptance:** Production CSP `img-src` does not include a bare `https:`. Needed logos and inline images still load. Voice and existing CSP tests still pass (R3-107 had no CSP errors on a call).

### R3-081: primary Bot name used as if it were a generic Goals label
- **Live evidence:** Titles were otherwise correct. The Goals surface showed a "Quinn's board" button and Reports showed "Ask Quinn for a report…". Quinn is the primary Bot in this account; this is not a hardcoded string "Quinn" in source, but it is the primary name baked into chrome.
- **Likely cause:** `WorkflowsPanel.tsx:108,130` uses `const board = primary ? `${primary.name}'s board` : 'Team board'` for the button. `TasksView.tsx:177` uses the same pattern in the Team subtitle. `DeliverablesPanel.tsx:136` uses `Ask ${botName} for a report`. When the work area is scoped to another Bot, the primary name still appears on the Goals board button.
- **Fix:** Do not treat the primary Bot's name as a global product label. Use the scoped Bot, or a generic label such as "Team board" and "Ask this Bot for a report" / the scoped Bot's name only when that Bot is the scope. Never hardcode a particular Bot name.
- **Acceptance:** With a primary Bot named anything, Goals and Reports chrome is correct for the current scope and does not imply a single hardcoded teammate.

## Tests
Add or extend tests for P0 items (redact + group `serverTools`), composer height, Work Routines confirm, prefill caret, tab title, mobile back from settings, Setup computer line consistency, import file control and duplicate error, Stop focus, and CSP `img-src`. Hook new tests into the existing gates.

## Out of scope
Loader animation, per-model effort labels and ultra animation, plan-connect in the model picker, and Bot-aware Composio suggestion ranking are owned by the other four workspaces. Do not reimplement them here. Rebase if they touch the same files.
