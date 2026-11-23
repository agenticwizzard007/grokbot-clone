# QA R3 follow-up: visible top-effort animation

You are the implementer for this item only. Do not take on the flock loader, suggested integrations, Skip setup, slug routes, model display names, or Goals/Reports titles. Those are in other Conductor workspaces and will have their own PRs. A separate workspace named "QA UI overlap audit" is doing a report-only layout audit; do not take on that work.

## Your job
1. Read this brief fully. Commit it unchanged as `docs/qa/R3-FU-EFFORT-ANIM.md` on your branch.
2. Implement the fix below. Verify the root cause in the code on current main before you change it, and correct course if the code says otherwise.
3. If this environment lets you spawn more agent sessions, spawn a reviewer or tester at model `gpt-6-astra` and effort `ultra` (agent `codex`). Do not silently pick a different model or effort. If those values are not offered, stop and report the exact mismatch.
4. Checks before the PR: `npm ci && npm run typecheck`, plus Playwright or unit tests that prove this fix (see Tests). Keep every existing test green, including existing effort and `effortFor('ultracode', ...)` tests.
5. One branch and ONE PR to `main` titled `QA R3 follow-up: visible top-effort animation`. Branch name: `conductor/qa-r3-fu-effort-anim`. The PR body has a checklist for this item only.
6. Merge only when CI is green on the latest head, and only after you rebase onto current `main` if it moved. This item is third in the follow-up merge order (see Sequencing). After merge, the "Deploy Fly staging" workflow deploys `main`. Do not run a manual `fly deploy` unless the workflow fails. Confirm live with `curl -sS https://swarm-team.fly.dev/api/version` and report the revision.
7. Guardrails: never commit or print secrets; no destructive data changes; no force push; do not use em dashes or en dashes in PR text, docs or new UI copy; do not put any person's name in code, docs or PR text. Do not touch any real user data. Do not sign into the live app with a real account. Do not connect or disconnect apps, and do not mutate live QA test Bots.

## Repo and live app

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Commit tested | `main` @ `de14ddcc0d02649718fba60a69ad387c9568d35b` (merge of PR #83; also contains merged PRs #76 #77 #79 #80 #81 #82) |
| Live app | https://swarm-team.fly.dev |
| Live build at handoff | `GET /api/version` revision `de14ddcc0d02649718fba60a69ad387c9568d35b`, builtAt 23 Nov 2026 05:06:32 (UTC+4, Dubai) |
| Prior PR that missed this | https://github.com/agenticwizzard007/grokbot-clone/pull/80 (merge `4f82ef5`) |
| Deploy | GitHub workflow "Deploy Fly staging" (`.github/workflows/staging.yml`) on merge to `main` |

Work from current `main`. If it has moved, rebase onto the tip.

## Sequencing
Four follow-up PRs will be opened in parallel. Merge order: (1) flock loader, (2) suggested integrations, (3) this effort animation PR, (4) slug routes and titles last. If `main` moved, rebase before you merge. Keep the diff scoped to the top-effort animation (pill, menu label, and composer glow) and its tests.

Avoid editing: `FlockMark` / `ActivityLine` / transcript loader treatment, suggestion components and APIs, setup-skip state, hash routing, `document.title`, Goals/Reports chrome. You may edit `ComposerModelMenu.tsx` and the effort animation CSS. Do not rename effort levels or change which levels a model offers unless that is required to attach the animation to the real top level.

## Live failure (must fix)

On the live app, the per-model effort picker is otherwise correct: each model shows the right levels and default, and the top level is tinted salmon/red. There is no visible ultracode-style animation on that top level (pill, menu label, or composer glow).

The original PR #80 acceptance required: "The highest documented level of every model that has effort selection uses the current ultracode animation (pill, menu label, and composer glow), including when the stored id is the real top level (`max`, `xhigh`, `high`) rather than the synthetic `ultracode` id."

Find why the class or CSS is not producing a clearly visible animation (animation attached only to the synthetic id, animation too subtle, duration zero, missing keyframes, reduced-motion always applied, wrong element, and so on). Make the animation clearly visible to a person looking at the picker and the composer when the top level is selected. Keep `prefers-reduced-motion: reduce` respected: no motion in that case, a static top-level treatment is enough.

## Acceptance criteria
- When the selected effort is that model's highest documented level, a clearly visible ultracode-style animation plays on the effort pill, the menu label for that level, and the composer glow, unless reduced motion is on.
- This works when the stored id is the real top level (`max`, `xhigh`, `high`, or whatever that model uses), not only when the id is the synthetic `ultracode` value.
- With `prefers-reduced-motion: reduce`, there is no motion. A static top-level tint may remain.
- Lower levels are not animated.
- Effort labels, defaults, and cross-model mapping from PR #80 stay correct.
- Existing effort unit tests still pass.

## Tests
Add or extend Playwright or unit UI tests that fail on current main and pass after this fix:
- the top-level control has the animation class or equivalent, and a computed style / keyframe check (or Playwright screenshot/pixel-change check) proves motion when reduced motion is off
- the same top level with `prefers-reduced-motion: reduce` has no motion
- this holds for at least two models whose top-level ids differ (for example one `max` and one `xhigh` or `high`), not only `ultracode`

## Out of scope
- Flock loader, suggested integrations, Skip setup, slug routes, model display names, Goals/Reports titles
- The UI overlap audit
- Touching live user data
