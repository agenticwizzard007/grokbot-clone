# QA R3 follow-up: visible flock loader while waiting

You are the implementer for this item only. Do not take on suggested integrations, Skip setup, effort animation, slug routes, model display names, or Goals/Reports titles. Those are in other Conductor workspaces and will have their own PRs. A separate workspace named "QA UI overlap audit" is doing a report-only layout audit; do not take on that work and do not edit Connect-an-app row layout.

## Your job
1. Read this brief fully. Commit it unchanged as `docs/qa/R3-FU-LOADER.md` on your branch.
2. Implement the fix below. Verify the root cause in the code on current main before you change it, and correct course if the code says otherwise.
3. If this environment lets you spawn more agent sessions, spawn a reviewer or tester at model `gpt-6-astra` and effort `ultra` (agent `codex`). Do not silently pick a different model or effort. If those values are not offered, stop and report the exact mismatch.
4. Checks before the PR: `npm ci && npm run typecheck`, plus Playwright or unit tests that prove this fix (see Tests). Keep every existing test green, including `tests/working-avatar-ui.mjs`.
5. One branch and ONE PR to `main` titled `QA R3 follow-up: visible flock loader while waiting`. Branch name: `conductor/qa-r3-fu-loader-flock`. The PR body has a checklist for this item only.
6. Merge only when CI is green on the latest head, and only after you rebase onto current `main` if it moved. This item is first in the follow-up merge order (see Sequencing). After merge, the "Deploy Fly staging" workflow deploys `main`. Do not run a manual `fly deploy` unless the workflow fails. Confirm live with `curl -sS https://swarm-team.fly.dev/api/version` and report the revision.
7. Guardrails: never commit or print secrets; no destructive data changes; no force push; do not use em dashes or en dashes in PR text, docs or new UI copy; do not put any person's name in code, docs or PR text. Do not touch any real user data. Do not sign into the live app with a real account. Do not connect or disconnect apps, and do not mutate live QA test Bots.

## Repo and live app

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Commit tested | `main` @ `de14ddcc0d02649718fba60a69ad387c9568d35b` (merge of PR #83; also contains merged PRs #76 #77 #79 #80 #81 #82) |
| Live app | https://swarm-team.fly.dev |
| Live build at handoff | `GET /api/version` revision `de14ddcc0d02649718fba60a69ad387c9568d35b`, builtAt 23 Nov 2026 05:06:32 (UTC+4, Dubai) |
| Prior PR that missed this | https://github.com/agenticwizzard007/grokbot-clone/pull/77 (merge `4d9d0de`) |
| Deploy | GitHub workflow "Deploy Fly staging" (`.github/workflows/staging.yml`) on merge to `main` |

Work from current `main`. If it has moved, rebase onto the tip.

## Sequencing
Four follow-up PRs will be opened in parallel. Merge order: (1) this loader PR, (2) suggested integrations, (3) effort animation, (4) slug routes and titles last. If `main` moved, rebase before you merge. Keep the diff scoped to the flock loader and its tests.

Avoid editing: suggestion components and APIs, setup-skip state, `ComposerModelMenu.tsx`, effort animation CSS beyond what the loader already uses, hash routing, `document.title`, Goals/Reports chrome.

## Live failure (must fix)

On the live app at revision `de14ddc` / previously `620e270`, while a reply is processing, the transcript shows only a roughly 20px bird mark next to a line like "Waiting for model response 5.6s", plus a tiny dotted (Braille) spinner. The expected 72px animated Paper working flock never appears as the main processing state.

Repro:
1. Open a test Bot chat (empty or with prior messages).
2. Send "Say hi in five words".
3. Watch the first seconds, while the Bot is waiting or running and no assistant tokens have arrived yet.

Observed: a small bird + "Waiting for model response Ns" + dotted spinner. Missing: the large animated flock (`flock-working-light.svg` or `flock-working-night.svg`) at about 72px.

PR #77 was supposed to show that flock in a brand-new empty chat while the first reply is processing. Live still fails, including (from the live check) on a Bot that already had messages. Find why the large flock is not shown: wrong size, wrong state gate (for example only empty chat, or only `running` and not `waiting`), CSS hiding the working images, ActivityLine still being the only visible treatment, or the large loader unmounting immediately. Fix the actual cause so the large animated flock is the default processing state, not only a tiny ActivityLine mark.

The official Paper working flock assets are already in the repo (`web/public/assets/swarms/flock-working-light.svg`, `flock-working-night.svg`) and `FlockMark` already knows how to show them. Do not invent a new generic spinner. Do not pull random logo files from the web.

## Acceptance criteria
- While a reply is processing and no assistant tokens have arrived yet, the chat shows the animated Paper working flock as the main processing treatment. The visible working `img` src ends with `flock-working-light.svg` or `flock-working-night.svg` according to theme, and the mark is about 72px (not a 20px or 32px ActivityLine-only treatment).
- This must work in a brand-new empty chat and in a chat that already has messages.
- The working images are actually moving (pixel change over a couple of frames) when reduced motion is off.
- When the assistant starts streaming or the run ends, the working images unmount or hide and motion stops.
- With `prefers-reduced-motion: reduce`, only the static flock is visible and there is no motion.
- No vertical jump of the composer or transcript when the animation starts or stops.
- Existing `tests/working-avatar-ui.mjs` stays green.

## Tests
Add or extend Playwright or unit UI tests that fail on current main and pass after this fix:
- new-chat processing shows the ~72px working flock
- in-progress chat (already has messages) also shows it
- animation stops when streaming starts or the run ends
- reduced motion shows only the static flock
- light and dark themes pick the matching asset

## Out of scope
- Suggested integrations, Skip setup, effort picker animation, slug routes, model display names, Goals/Reports titles
- The UI overlap audit
- Touching live user data
