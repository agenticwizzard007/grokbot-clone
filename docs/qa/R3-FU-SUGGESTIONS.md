# QA R3 follow-up: suggested integrations loading and Skip setup

You are the implementer for this item only. Do not take on the flock loader, effort animation, slug routes, model display names, or Goals/Reports titles. Those are in other Conductor workspaces and will have their own PRs. A separate workspace named "QA UI overlap audit" is doing a report-only layout audit, including the Connect an app page. Do not take on overlap/layout audit work. If you must touch the suggestions section on that page, do not change connected-row layout (the known Gmail "Connected" label overlap is owned by the audit, not this PR).

## Your job
1. Read this brief fully. Commit it unchanged as `docs/qa/R3-FU-SUGGESTIONS.md` on your branch.
2. Implement the fix below. Verify the root cause in the code on current main before you change it, and correct course if the code says otherwise.
3. If this environment lets you spawn more agent sessions, spawn a reviewer or tester at model `gpt-6-astra` and effort `ultra` (agent `codex`). Do not silently pick a different model or effort. If those values are not offered, stop and report the exact mismatch.
4. Checks before the PR: `npm ci && npm run typecheck`, plus Playwright or unit tests that prove this fix (see Tests). Keep every existing test green, including existing Connect Apps tests.
5. One branch and ONE PR to `main` titled `QA R3 follow-up: suggested integrations loading and Skip setup`. Branch name: `conductor/qa-r3-fu-suggestions`. The PR body has a checklist for this item only.
6. Merge only when CI is green on the latest head, and only after you rebase onto current `main` if it moved. This item is second in the follow-up merge order (see Sequencing). After merge, the "Deploy Fly staging" workflow deploys `main`. Do not run a manual `fly deploy` unless the workflow fails. Confirm live with `curl -sS https://swarm-team.fly.dev/api/version` and report the revision.
7. Guardrails: never commit or print secrets; no destructive data changes; no force push; do not use em dashes or en dashes in PR text, docs or new UI copy; do not put any person's name in code, docs or PR text. Do not touch any real user data. Do not sign into the live app with a real account. Do not connect or disconnect apps, and do not mutate live QA test Bots. Reproduce with a local dev build and seeded fake data.

## Repo and live app

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Commit tested | `main` @ `de14ddcc0d02649718fba60a69ad387c9568d35b` (merge of PR #83; also contains merged PRs #76 #77 #79 #80 #81 #82) |
| Live app | https://swarm-team.fly.dev |
| Live build at handoff | `GET /api/version` revision `de14ddcc0d02649718fba60a69ad387c9568d35b`, builtAt 23 Nov 2026 05:06:32 (UTC+4, Dubai) |
| Prior PR that missed this | https://github.com/agenticwizzard007/grokbot-clone/pull/76 (merge `072a52a`) |
| Deploy | GitHub workflow "Deploy Fly staging" (`.github/workflows/staging.yml`) on merge to `main` |

Work from current `main`. If it has moved, rebase onto the tip.

## Sequencing
Four follow-up PRs will be opened in parallel. Merge order: (1) flock loader, (2) this suggestions PR, (3) effort animation, (4) slug routes and titles last. If `main` moved, rebase before you merge. Keep the diff scoped to suggestions loading, empty/timeout/error states, and Skip setup state.

Avoid editing: `FlockMark` / `ActivityLine` / transcript loader treatment, `ComposerModelMenu.tsx`, effort animation CSS, hash routing, `document.title`, Goals/Reports chrome, connected-app row layout.

## Live failures (must fix)

Per-Bot "Suggested integrations" never shows suggestions on the live app.

1. Bot still in setup (live check used QA-Temp-1, which was stuck in setup): the Details panel and Settings > General stay on "Finding relevant apps…" for 30+ seconds and never resolve. This needs a timeout and an honest error or retry state. Suggestions should also work even before setup finishes, using whatever description or About text already exists.

2. Bot with a description (live check used QA-Temp-2): the UI says "No additional apps to suggest. Describe this Bot's work in About…" even though the Bot already has a description. Suggestions should load and fit the Bot (a subset of the current Composio catalog, with logo or monogram and a one-line reason).

3. Related setup bug, also in scope: QA-Temp-1 stayed in setup and gave a canned "I'm still being set up" reply even after Skip setup. Check whether Skip setup actually clears setup state (server and client). If Skip setup does not mark the Bot as ready / not-in-setup, fix that so Skip setup is honored and the canned setup reply stops. Do not invent a live-data cleanup; fix the product path and cover it with tests and seeded local data.

Find the actual causes (hung request, missing timeout, suggestions gated on setup completion, description field not read from the right place, Skip setup not persisting, and so on) and fix them.

## Acceptance criteria
- "Finding relevant apps…" cannot hang indefinitely. After a short, reasonable timeout, the UI shows an error or retry state, not a spinner forever.
- Suggestions load for a Bot that is still in setup, using the description or About text that already exists.
- When the Bot has a non-empty description, the UI does not show the "Describe this Bot's work in About…" empty state. It shows catalog-fitting suggestions (or a truthful "no matching apps" that is not blaming a missing description).
- Visible suggestions are a subset of the current Composio catalog, each with logo or monogram fallback, display name, and a one-line reason.
- Skip setup actually clears setup state. After Skip setup, the Bot is not treated as still being set up, and the canned "I'm still being set up" reply is not returned.
- Existing Connect Apps tests still pass.

## Tests
Add or extend Playwright or unit tests that fail on current main and pass after this fix:
- suggestions request that never resolves is replaced by a timeout / error / retry state (do not wait 30s in CI; fake a hang)
- a Bot still in setup, with a description, still receives suggestions
- a Bot with a description does not get the "Describe this Bot's work in About…" empty state
- a description about GitHub PRs and Slack yields those toolkits when they are in the catalog (keep the original contract)
- Skip setup clears setup state, and a later turn is not served the canned setup reply

## Out of scope
- Flock loader, effort animation, slug routes, model display names, Goals/Reports titles
- The UI overlap audit, including the Gmail connected-row overlap
- Connecting or disconnecting any live app, or touching live user data
