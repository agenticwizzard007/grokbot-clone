# Bot General background refresh

R9-2 was investigated against untouched `b8df0fd281c8678a593e7f1bc29c13f585eefde6` using a production Vite build and local API fixtures. No live account was opened or changed.

## Findings

The saved server snapshot deliberately normalizes Slack's reason to `Slack was suggested for this Bot.` The refresh returned `Slack is named in this Bot's work.` SuggestedIntegrations replaced the visible array with that response, reproducing the wording change.

All 40 baseline first inputs navigated to the QA-Temp-1 chat. This included direct loads and reloads at 390 with mobile touch emulation and 1280 with mouse input, in light and dark, at offsets of -200, -100, 0, 100 and 200 ms around the response. The zero case held native pointer input down while the response arrived and React committed. The missed first tap itself was not reproduced.

MutationObserver records and animation-frame samples found no replacement of the page, header or back node, no React ancestry/key change, and no header/back geometry movement. Pointerdown, pointerup and click reached the same connected back button. The failing baseline regression assertions concern reason wording, not navigation. The baseline #217 suite also passed all 292 checks.

Code inspection agrees with that evidence: BotSettingsPage is keyed by account and Bot, its header is a sibling of the content, and suggestions own their request state. The route's initial lazy import has a Suspense boundary, but the suggestions request neither suspends nor recreates the route or updates shell state.

## Changes

- Preserve displayed reasons and order on quiet refreshes with the same app set. Keep fresh response data in the cache without exposing it during passive connection/setup notifications.
- Accept new reasons after an explicit edit or retry, or when an app is added, removed or replaced.
- Key cards by account, Bot and app instead of the draft/request revision, retaining surviving card nodes.
- Reserve the suggestions block's displayed height locally and exclude that subtree from scroll anchoring. A removed card cannot collapse the reserved block. New items can grow the list; navigation remains stationary.

No chat transcript, approval card, step row, navigation handler or deployment workflow was changed.

## Regression coverage

`npm run test:readiness-hh` runs the display-policy/cache tests and a production browser suite. The browser suite records native input timestamps, node identity, React ancestor keys/types, per-frame bounding boxes, layout shifts including recent-input shifts, and every displayed reason transition. It checks 40 timed first inputs plus quiet refreshes, passive notifications, explicit edits, card identity, and app additions/removals in all four viewport/theme combinations.

Raw evidence is retained under `.context/baseline-hh`, `.context/readiness-hh`, `.context/baseline-gg`, and `.context/fixed-gg`. Full unit baselines use a detached, unchanged checkout in `.context/baseline-source`, with the same Node 22.16.0 and dependencies as the branch run. Full-suite counts and failure-name comparison are recorded in the PR.
