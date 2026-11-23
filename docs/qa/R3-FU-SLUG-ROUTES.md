# QA R3 follow-up: slug routes, model names, and tab titles

You are the implementer for this item only. Do not take on the flock loader, suggested integrations, Skip setup, or effort animation. Those are in other Conductor workspaces and will have their own PRs. A separate workspace named "QA UI overlap audit" is doing a report-only layout audit; do not take on that work.

## Your job
1. Read this brief fully. Commit it unchanged as `docs/qa/R3-FU-SLUG-ROUTES.md` on your branch.
2. Implement the fix below. Verify the root cause in the code on current main before you change it, and correct course if the code says otherwise.
3. If this environment lets you spawn more agent sessions, spawn a reviewer or tester at model `gpt-6-astra` and effort `ultra` (agent `codex`). Do not silently pick a different model or effort. If those values are not offered, stop and report the exact mismatch.
4. Checks before the PR: `npm ci && npm run typecheck`, plus Playwright or unit tests that prove this fix (see Tests). Keep every existing test green.
5. One branch and ONE PR to `main` titled `QA R3 follow-up: slug routes, model names, and tab titles`. Branch name: `conductor/qa-r3-fu-slug-routes`. The PR body has a checklist for this item only.
6. Merge only when CI is green on the latest head, and only after you rebase onto current `main` if it moved. This item is last in the follow-up merge order (see Sequencing). After merge, the "Deploy Fly staging" workflow deploys `main`. Do not run a manual `fly deploy` unless the workflow fails. Confirm live with `curl -sS https://swarm-team.fly.dev/api/version` and report the revision.
7. Guardrails: never commit or print secrets; no destructive data changes; no force push; do not use em dashes or en dashes in PR text, docs or new UI copy; do not put any person's name in code, docs or PR text. Do not touch any real user data. Do not sign into the live app with a real account. Do not connect or disconnect apps, and do not mutate live QA test Bots.

## Repo and live app

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Commit tested | `main` @ `de14ddcc0d02649718fba60a69ad387c9568d35b` (merge of PR #83; also contains merged PRs #76 #77 #79 #80 #81 #82) |
| Live app | https://swarm-team.fly.dev |
| Live build at handoff | `GET /api/version` revision `de14ddcc0d02649718fba60a69ad387c9568d35b`, builtAt 23 Nov 2026 05:06:32 (UTC+4, Dubai) |
| Prior PR that missed this | https://github.com/agenticwizzard007/grokbot-clone/pull/81 (merge `620e270`) |
| Deploy | GitHub workflow "Deploy Fly staging" (`.github/workflows/staging.yml`) on merge to `main` |

Work from current `main`. If it has moved, rebase onto the tip.

## Sequencing
Four follow-up PRs will be opened in parallel. Merge order: (1) flock loader, (2) suggested integrations, (3) effort animation, (4) this slug-routes PR last. If `main` moved, rebase before you merge. Keep the diff scoped to user-facing routes, model display names, and document titles.

Avoid editing: `FlockMark` / `ActivityLine` / transcript loader treatment, suggestion components and APIs, setup-skip state, effort animation CSS, and `ComposerModelMenu.tsx` except where a display-name helper must be read (prefer a shared display-name helper over rewriting the menu).

## Live failures (must fix)

1. Settings URLs expose raw Bot IDs, for example `#bot/bot_2RXgsJ5OZGBV/settings/general`. Use a slug or other non-ID route in the user-visible URL (hash or path). The raw `bot_…` id must not appear in the address bar. Deep links must still open the same Bot and tab. If two Bots would collide on a slug, disambiguate without falling back to putting the raw id in the URL (for example a short unique slug). Old `#bot/bot_…` links may redirect to the new form.

2. Also include, if cheap: the Model field shows the raw slug `x-ai/grok-4.7` instead of a human display name (for example "Grok 4.7"). Show a display name in settings and any other user-visible Model field. Keep the raw id for API calls only.

3. Also include, if cheap: Goals and Reports keep the browser tab title "Swarm" and the URL `/`. When Goals or Reports is open, set a matching tab title (for example "Goals" or "<scope> · Goals") and a stable user-facing URL (hash or path, without raw Bot IDs). Opening History and Bot settings should already have been covered in PR #81; if those titles are still "Swarm", fix them in this PR too.

## Acceptance criteria
- Opening a Bot's settings does not put a raw `bot_…` id in the user-visible URL. A slug or other non-ID route is used, and reload or a copied link reopens the same Bot and settings tab.
- The Model field shows a human display name, not a raw provider slug such as `x-ai/grok-4.7`.
- Opening Goals or Reports changes the browser tab title off the bare word "Swarm", and the URL is a stable user-facing Goals or Reports route rather than only `/`. Leaving the page restores a sensible default title.
- Existing settings-hash, navigation, and title tests still pass, or are updated to the new routes without dropping coverage.

## Tests
Add or extend Playwright or unit tests that fail on current main and pass after this fix:
- settings URL for a Bot does not contain `bot_` or another raw Bot id, and a reload of that URL reopens the same settings tab
- Model field (or the display helper it uses) renders "Grok 4.7" or the catalog display name for `x-ai/grok-4.7`, not the raw slug
- opening Goals and opening Reports each change `document.title` away from exactly "Swarm", and each has a distinct user-facing URL

## Out of scope
- Flock loader, suggested integrations, Skip setup, effort animation
- The UI overlap audit
- Touching live user data
- A full public multi-page router beyond what is needed for these user-facing URLs
