# QA R3: bird Bot avatars

You are the implementer for this item only. Do not take on the loader animation, effort picker, plan connections, suggested integrations, or leftovers. Those live in other Conductor workspaces.

## First action in your first reply
Paper is open on the Mac where Conductor runs. Codex is configured with `[mcp_servers.paper]` and command `/Users/metrix/.paper/bin/paper`. This session should have Paper MCP tools.

Your first reply must confirm whether Paper MCP tools are available in this session by listing a Paper tool you called successfully (name the tool and a one-line result). If Paper is not available, say so clearly, fall back to deriving the variations as SVGs from the official Paper flock assets already in `web/public/assets/swarms/`, and continue the rest of this brief.

If Paper is available:
1. Design 8 to 12 bird logo variations based on the Swarms three-birds-flying logo.
2. Keep the designs in a Paper file or artboard.
3. Export them as SVGs into the repo (prefer `web/public/assets/swarms/` or a clearly named sibling folder, with a consistent naming scheme and light/dark variants as needed).
4. Then update the new-Bot logo or avatar picker as specified below.

Do not depend on a Paper desktop connection from any other machine. Only this Conductor session's Paper MCP (or the repo flock fallback) counts.

## Your job
1. Read this brief fully. Commit it unchanged as `docs/qa/R3-BIRD-AVATARS.md` on your branch.
2. Confirm Paper as required above, then create the variations and wire them into the pickers.
3. If this environment lets you spawn more agent sessions, spawn a reviewer or tester at model `gpt-6-astra` and effort `ultra` (agent `codex`). Do not silently pick a different model or effort. If those values are not offered, stop and report the exact mismatch. A Reviewer session may already exist in this workspace; use it rather than duplicating work.
4. Checks before the PR: `npm ci && npm run typecheck`, existing avatar and create-bot tests (including `tests/create-bot-ui.mjs` and `tests/working-avatar-ui.mjs`) plus new tests this brief requires. Keep every existing test green.
5. One branch and ONE PR to `main` titled `QA R3: bird Bot avatars`. The PR body has a checklist for this item only.
6. Merge only when CI is green, the Reviewer has approved, and the loader PR from workspace 38 is already on main. Rebase onto main after that lands. Do not force-push. After merge, the "Deploy Fly staging" workflow deploys `main`. Do not run a manual `fly deploy` unless the workflow fails.
7. Guardrails: never commit or print secrets; no destructive data changes; no force push; do not use em dashes or en dashes in PR text, docs or new UI copy; do not put any person's name in code, docs or PR text. Do not touch live QA test Bots.

## Repo and live app

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Commit tested | `main` @ `11b244fea954142ddc14cc402100efedd18d4f1e` (merge of PR #75) |
| Live app | https://swarm-team.fly.dev |
| Deploy | GitHub workflow "Deploy Fly staging" (`.github/workflows/staging.yml`) on merge to `main` |

Line numbers are against that commit and may drift by a line or two. Search for the quoted code if a line does not match.

## Sequencing
Six R3 PRs will be opened. Merge order: (1) loader animation, workspace 38, (2) this bird avatars PR, (3) suggested integrations, workspace 41, (4) per-model effort picker, workspace 39, (5) plan connections, workspace 40, (6) leftovers, workspace 42, last. This item merges after workspace 38 only. If `main` moved, rebase before you merge. Coordinate with the loader workspace so you do not conflict on flock assets, `FlockMark`, or activity-line CSS. Reuse the official flock artwork; do not rewrite the processing animation.

## Where the pickers and current logos live

The current "Grok Bot style" default logo set is a family of filled character silhouettes (blob, cloud, heart, sparkle, and the rest), not bird marks. They are generated shapes in `web/src/avatar/shapes.gen.ts`, rendered by `BotAvatar`, and offered by `PICKER_SHAPES`.

- `web/src/avatar/BotAvatar.tsx:20-21` exports `PICKER_SHAPES` in the design order (comment says rows of 5/5/3): `blob`, `cloud`, `square`, `sparkle`, `clover`, `heart`, `flower`, `teardrop`, `tablet`, `wedge`, `house`, `star`, `hex`.
- `web/src/avatar/BotAvatar.tsx:11-17` maps missing shape names onto those silhouettes and resolves them through `shapes.gen.ts`.
- `web/src/avatar/BotAvatar.tsx:38-55` paints the silhouette with the Bot color from `palette(color).fill`. A working state keeps the chosen shape and only adds a small `FlockMark` badge.
- `web/src/avatar/BotAvatar.tsx:70-79` `BotAvatarFor`: the primary Bot is the official flock mark; every other Bot uses its stored shape and color.
- Create a Bot: `web/src/components/modals/CreateBotModal.tsx:3` imports `PICKER_SHAPES`. Lines 35-36 default a new Bot to shape `heart` and color `orange`. Line 116 submits `avatarShape` and `avatarColor` to `api.createBot`. Line 155 is a `<select>` of `PICKER_SHAPES` labeled "Choose a character shape" (the color select is the following label).
- Bot settings: `web/src/components/config/BotSettingsModal.tsx:5` imports `BotAvatar` and `PICKER_SHAPES`. Line 208 shows a 72px preview. Line 216 opens `LookPicker`. Lines 305-337 build a visual shape grid from `PICKER_SHAPES` (rows of 7 and 6) plus `COLOR_ORDER` swatches, aria-label "Character shape".
- Contract: `server/src/types.ts:3-9` (`AvatarShape` and `AvatarColor`). Server allow-lists and fallbacks are in `server/src/bots.ts` (shape list around lines 15-17, zod around 32-33 and 53-54, hash fallback around 91-92). DB default is `blob` (`server/src/db.ts:68`). The primary account Bot is seeded as `blob` / `black` (`server/src/accounts.ts:139`).
- Color palette to stay compatible with: `web/src/lib/colors.ts:23-39` (`BOT_COLORS` and `COLOR_ORDER`).
- Official flock sources to start from: `web/public/assets/swarms/flock.svg`, `flock-night.svg`, `flock-working-light.svg`, `flock-working-night.svg`. These are the Paper-exported three-birds-flying marks. The loader workspace (38) is changing how the processing animation uses them; do not regress that work or fight its PR.

## What to implement
Create about 8 to 12 on-brand bird variants of the Swarms three-birds-flying logo. Examples: different bird counts and formations, poses, a single bird, and color or accent fills that fit the existing palette. Keep consistent stroke and size. They must stay legible at 24 to 32 px and work in light and dark mode.

Wire them into both pickers (Create a Bot and Bot settings):
- The new-Bot picker shows the bird variants first, as the suggestions.
- The default new-Bot avatar is a bird variant (replace the current `heart` / `orange` default in `CreateBotModal`).
- Existing Bots keep the avatars they already chose, including old silhouette shapes still stored on those Bots. Do not migrate or rewrite existing avatar fields.
- Do not suggest the old Grok Bot style silhouette logos in the pickers. Those shapes may remain renderable for existing Bots, but they are no longer offered as choices for new or edited logos.
- If the Create a Bot flow is still a `<select>` of shape names, upgrade it so the bird suggestions are visible, not only listed as words.
- Server validation (`AvatarShape` / `server/src/bots.ts`) must accept the new variant ids and still accept previously stored shape ids so old Bots load.
- Primary Bot continues to use the official flock mark in `BotAvatarFor`. Do not replace the primary mark with a random variant.

## Tests
Add tests that:
- The Create a Bot and Bot settings pickers list the bird variants first.
- A newly created Bot gets a bird variant by default.
- Previously stored silhouette shapes still render.
- Old Grok Bot style logos are not offered as suggestions.
- The new SVGs render in light and dark, and stay usable at 24 and 32 px (or the same sizes the pickers actually use).

Keep `tests/create-bot-ui.mjs` and `tests/working-avatar-ui.mjs` green. Extend or add a focused UI or unit test rather than a one-off manual-only check.

## Acceptance criteria
- 8 to 12 bird variants exist as SVGs in the repo, derived from the Swarms three-birds-flying logo (via Paper MCP if available, otherwise from the repo flock assets).
- If Paper MCP was used, the PR notes the Paper file or artboard and that it was available. If it was not, the PR says the repo flock fallback was used.
- New-Bot picker shows bird variants first as suggestions.
- Default new Bot avatar is a bird variant.
- Existing Bots keep their chosen avatars.
- No old Grok Bot logos are suggested in the pickers.
- Tests above are added and green, plus typecheck.
- No conflict with the loader work in workspace 38 (shared flock assets and `FlockMark` behavior stay compatible; rebase after 38 if needed).
- CI green. Reviewer approved. Merged only after workspace 38.

Reply with the PR URL when it is open, and confirm the Paper MCP result in your first reply as required above.
