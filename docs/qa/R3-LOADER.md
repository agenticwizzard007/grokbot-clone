# Swarm logo processing animation

You are the implementer for this item only. Do not take on effort picker names, plan connections, suggested integrations, or the round 3 leftovers. Those are in other Conductor workspaces and will have their own PRs.

## Your job
1. Read this brief fully. Commit it unchanged as `docs/qa/R3-LOADER.md` on your branch.
2. Implement the fix below. Verify the root cause in the code before you change it, and correct course if the code says otherwise.
3. If this environment lets you spawn more agent sessions, spawn a reviewer or tester at model `gpt-6-astra` and effort `ultra` (agent `codex`). Do not silently pick a different model or effort. If those values are not offered, stop and report the exact mismatch.
4. Checks before the PR: `npm ci && npm run typecheck`, unit tests that already cover avatars and chat (`tests/working-avatar-ui.mjs` must stay green; add the new test this brief requires), and any existing UI scripts that touch the activity line or empty chat. Keep every existing test green.
5. One branch and ONE PR to `main` titled `QA R3: swarm logo processing animation`. The PR body has a checklist for this item only.
6. Merge only when CI is green, and only if no other listed R3 PR that should land first is still unmerged in a way that would clash. This item is first in the merge order (see Sequencing). After merge, the "Deploy Fly staging" workflow deploys `main`. Do not run a manual `fly deploy` unless the workflow fails.
7. Guardrails: never commit or print secrets; no destructive data changes; no force push; do not use em dashes or en dashes in PR text, docs or new UI copy; do not put any person's name in code, docs or PR text. Do not touch live QA test Bots.

## Repo and live app

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Commit tested | `main` @ `9f2481a2c805e86d1af93a43cf6703e18f5bfd19` (merge of PR #74) |
| Live app | https://swarm-team.fly.dev |
| Live build | `GET /api/version` revision `9f2481a2c805e86d1af93a43cf6703e18f5bfd19`, builtAt 22 Nov 2026 20:53:25 (UTC+4, Dubai) |
| Deploy | GitHub workflow "Deploy Fly staging" (`.github/workflows/staging.yml`) on merge to `main` |

Line numbers are against that commit and may drift by a line or two. Search for the quoted code if a line does not match.

## Sequencing
Five R3 PRs will be opened. Merge order: (1) this loader PR, (2) suggested integrations, (3) per-model effort picker, (4) plan connections, (5) leftovers last. This loader work should land first. If `main` moved, rebase before you merge. Avoid editing `ComposerModelMenu.tsx` or leftover-only files.

## Root cause
The official Paper working flock artwork is already in the repo, but a new chat's default processing state never uses it as the main animation.

Paper-exported assets already present (live 200 on the Fly app):

- Static: `web/public/assets/swarms/flock.svg`, `flock-night.svg`
- Working (SMIL animated, about 33 KB, 1440ms loop, rest vs flight groups): `flock-working-light.svg`, `flock-working-night.svg`

`FlockMark` (`web/src/components/FlockMark.tsx:1-11`) shows the static images, and when `working` is true also the working SVGs. CSS in `web/src/styles/paper-core.css:94-103` hides static images while working, and under `prefers-reduced-motion: reduce` hides the moving images and shows the static logo. Theme is handled with `.brand-image--light` / `--night`.

Where it renders today:

- `ActivityLine` (`web/src/components/ActivityLine.tsx:31-34`) uses `<FlockMark size={32} working={!waiting} />` plus a `BrailleSpinner`. `Transcript.tsx:168-172, 228` shows this line only when `(running && !streamingNow) || waiting`.
- `EmptyChat` (`web/src/components/Transcript.tsx:240-247`) is the new-chat default state: a 72px `BotAvatarFor` plus the Bot name. It mounts only when `loaded && visibleRows.length === 0 && groups.length === 0` (`Transcript.tsx:203`). The moment the user's first message is in the transcript, `EmptyChat` unmounts. The large centered mark is gone for the rest of the wait.
- For a primary Bot, `BotAvatarFor` (`web/src/avatar/BotAvatar.tsx:70-78`) is a full `FlockMark` and will animate if `live.isRunning` is already true while EmptyChat is still mounted. For any other Bot, the empty state shows the Bot's shape, and working is only a small corner badge (`BotAvatar.tsx:54-55`). That is not "variations of the swarm logo" as the processing animation.
- `.app .activity-line__mark { animation: none; }` (`paper-core.css:97`) only disables the CSS bob. It does not hide the SMIL artwork, but the activity-line mark is 32px and sits beside a generic braille spinner, so it is not the new-chat default processing animation.

The Paper MCP (Cursor plugin "Paper", catalog id 6062) is not connected in the environment that wrote this brief. Do not invent new logo artwork. Use the Paper-exported working and static flock SVGs already in `web/public/assets/swarms/`. If a Paper connector is available in your environment and has additional official logo variations, you may use those as well, but the repo assets are sufficient and already live.

## Wanted behavior
A new chat in its default state, while a response is being generated, shows an animated swarm logo that cycles through the official Paper working variations (light or night to match the theme). The animation means the swarm is active.

- Show this as the primary processing animation for a new chat (empty or first-turn) while the Bot is running and the assistant has not started streaming.
- Stop the working artwork and return to the static logo (or unmount the processing mark cleanly) when the response starts streaming or the run finishes.
- `prefers-reduced-motion: reduce` shows the static flock logo, no SMIL or CSS motion.
- No layout shift: reserve a fixed size for the mark so swapping static and working images does not move the transcript or composer.
- Existing chats may keep the activity line. Do not regress `tests/working-avatar-ui.mjs` (header, sidebar, and activity avatars still use the working flock when a Bot is running).
- Do not replace a non-primary Bot's identity avatar in history or the sidebar with the flock, except as the new-chat processing animation (or the existing small working badge).

## Files to change (likely)
- `web/src/components/Transcript.tsx` (`EmptyChat`, `showActivity`)
- `web/src/components/FlockMark.tsx`
- `web/src/styles/paper-core.css`, `web/src/styles/chat.css` (empty-chat and activity-line)
- `web/src/avatar/BotAvatar.tsx` only if the empty-state mark must use the flock while processing
- A new unit or Playwright UI test next to `tests/working-avatar-ui.mjs`

## Acceptance criteria
- In a brand-new empty chat, after the user sends a first message and while the Bot is running with no assistant tokens yet, the chat's default processing state shows the animated Paper working flock (the visible `img` src ends with `flock-working-light.svg` or `flock-working-night.svg` according to theme).
- The working images are actually moving (pixel change over a couple of frames) when reduced motion is off.
- When the assistant starts streaming or the run ends, the working images unmount or hide and motion stops.
- With `prefers-reduced-motion: reduce`, only the static flock is visible.
- No vertical jump of the composer or transcript when the animation starts or stops.
- New test covers new-chat processing, stop on stream, reduced motion, light and dark.
- `tests/working-avatar-ui.mjs` and existing unit tests still pass. `npm run typecheck` passes.

## Product decision
Use the existing Paper working SVGs as the "variations". Do not build a new generic spinner. Do not pull random logo files from the web.
