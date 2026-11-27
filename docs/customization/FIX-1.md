# FIX-1 default-layout baseline review

The branch is rebased onto main `5294c8567ff1c956a8731ad24e96437804cfcef7` (HO-I, PR #268). The baseline now pins that commit. It retains 208 route views, 390 and 1280 px, both themes, the fixed history timestamp, and the comment that the pin moves only with a reviewed layout change.

## Navigation repair

The original failures combined a Flow hash unknown to shared navigation, a temporary duplicate header that hid the shared Back control and avatar, and successful but incomplete responses that were treated as Flow models. HO-I now owns the shared route contract: `{ kind: 'details', tab: 'activity', flow: true, link? }`. FIX-1 uses that contract, removes the temporary hash adapter and header, and rejects missing model arrays before rendering the existing Retry state.

Automatic Flow defaults no longer rewrite Activity URLs or the Back trail. The mounted panel follows explicit Flow/Activity transitions during browser Back and Forward. Detail tabs wrap into equal columns on narrow desktop panes, keeping labels visible. No cosmetic theme or font changes.

## HO-I baseline audit: e0d2cf9 to 5294c85

Both untouched commits were recorded with the local layout seed and no customization. The audit compares every token map and every captured node, including exact Page and card bounding boxes. All 208 token maps match. 184 views match completely; exactly 24 differ because HO-I mounts the existing Flow and handoff surfaces. None of these main-to-main changes belongs in FIX-1's `reviewedDifferences` map.

Full before/after node records: `.context/fix-1-rebase/defaults-diff.json`. Summary: `.context/fix-1-rebase/defaults-audit-summary.json`.

| Differing route view | Page heights, before to after (px) | Reviewed reason |
| --- | --- | --- |
| `1280-dark-bot-activity` | 258 to 616 | HO-I mounts the Flow API, replacing the unavailable placeholder with the seeded chart. |
| `1280-dark-bot-tasks` | 317 to 333 | HO-I mounts handoff settings, enabling the existing TaskActions container and its 8 px top margin on each seeded task row. |
| `1280-dark-chat-approval` | 920.13, 108 to 972.13, 108 | HO-I adds the Message actions control after the seeded assistant reply, increasing the transcript by 52 px. |
| `1280-dark-chat-declined` | 873.13, 108 to 925.13, 108 | HO-I adds the Message actions control after the seeded assistant reply, increasing the transcript by 52 px. |
| `1280-dark-scoped-tasks` | 624 to 632 | HO-I enables the Loops link and TaskActions; the task columns grow by 8 px. |
| `1280-dark-tasks` | 544 to 552 | HO-I enables TaskActions spacing and the Loops link in the task header. |
| `1280-light-bot-activity` | 258 to 616 | HO-I mounts the Flow API, replacing the unavailable placeholder with the seeded chart. |
| `1280-light-bot-tasks` | 317 to 333 | HO-I mounts handoff settings, enabling the existing TaskActions container and its 8 px top margin on each seeded task row. |
| `1280-light-chat-approval` | 920.13, 108 to 972.13, 108 | HO-I adds the Message actions control after the seeded assistant reply, increasing the transcript by 52 px. |
| `1280-light-chat-declined` | 873.13, 108 to 925.13, 108 | HO-I adds the Message actions control after the seeded assistant reply, increasing the transcript by 52 px. |
| `1280-light-scoped-tasks` | 624 to 632 | HO-I enables the Loops link and TaskActions; the task columns grow by 8 px. |
| `1280-light-tasks` | 544 to 552 | HO-I enables TaskActions spacing and the Loops link in the task header. |
| `390-dark-bot-activity` | 286 to 1346 | HO-I mounts the Flow API, replacing the unavailable placeholder with the seeded chart; recognized Flow routing removes fallback phone tabs at 390 px. |
| `390-dark-bot-tasks` | 305 to 321 | HO-I mounts handoff settings, enabling the existing TaskActions container and its 8 px top margin on each seeded task row. |
| `390-dark-chat-approval` | 1049.19, 100 to 1101.19, 100 | HO-I adds the Message actions control after the seeded assistant reply, increasing the transcript by 52 px. |
| `390-dark-chat-declined` | 898.19, 100 to 950.19, 100 | HO-I adds the Message actions control after the seeded assistant reply, increasing the transcript by 52 px. |
| `390-dark-scoped-tasks` | 794 to 862 | HO-I enables TaskActions spacing and the Loops link; the phone title wraps beside the additional header control. |
| `390-dark-tasks` | 714 to 730 | HO-I enables TaskActions spacing and the Loops link in the task header. |
| `390-light-bot-activity` | 286 to 1390 | HO-I mounts the Flow API, replacing the unavailable placeholder with the seeded chart; recognized Flow routing removes fallback phone tabs at 390 px. |
| `390-light-bot-tasks` | 305 to 321 | HO-I mounts handoff settings, enabling the existing TaskActions container and its 8 px top margin on each seeded task row. |
| `390-light-chat-approval` | 1049.19, 100 to 1101.19, 100 | HO-I adds the Message actions control after the seeded assistant reply, increasing the transcript by 52 px. |
| `390-light-chat-declined` | 898.19, 100 to 950.19, 100 | HO-I adds the Message actions control after the seeded assistant reply, increasing the transcript by 52 px. |
| `390-light-scoped-tasks` | 794 to 862 | HO-I enables TaskActions spacing and the Loops link; the phone title wraps beside the additional header control. |
| `390-light-tasks` | 714 to 730 | HO-I enables TaskActions spacing and the Loops link in the task header. |

Source evidence: `git show 5294c85 -- server/src/routes.ts web/src/lib/navigation.ts web/src/App.tsx web/src/components/ChatView.tsx web/src/components/Transcript.tsx`. The mounted handoff settings endpoint enables the existing `TaskHandoffProvider`, `TaskActions` and `TaskLoopsLink` in `web/src/components/config/TaskCards.tsx`. `MessageHandoff` adds a control after each completed assistant reply. The Flow API supplies the full chart instead of the unavailable placeholder. The phone Flow height differs between light and dark because the fixed route traversal warms Connected apps before the dark view, removing its app-status hint.

An initial Setup files discrepancy was a lazy Markdown loading state. Re-recording after the file reader renders removes it; all Setup views match between these pins. The collector also waits for the Flow and handoff policy responses that add controls, loaded chat data, lazy approval previews and fonts. It still compares every captured node and token. Each pinned checkout has its own Vite cache so parallel local checks cannot swap optimized dependencies between commits.

## Reviewed FIX-1 differences

`reviewedDifferences` is empty for the new pin. The former two phone Activity exceptions applied to `e0d2cf9`; HO-I already removes the invalid-route fallback tabs. FIX-1 replaces the temporary header inside the same geometry. The fresh comparison matches all 208 complete snapshots against `5294c85`, with zero reviewed exceptions and zero skipped views.

The review mechanism remains strict: listed views must have a reason, identical token maps, every non-navigation node including Page/card boxes, unchanged navigation styles, and exactly the recorded navigation boxes. Unlisted views require complete equality. A review fails when the pin already matches, so stale exceptions cannot survive. Nine negative/control tests exercise those safeguards.

## Original HO-G audit: fc3eab7 to e0d2cf9

Compared the original pin `fc3eab7` with main `e0d2cf9`, using the local layout seed, no customization, 390 and 1280 px, light and dark. All 208 token maps are unchanged. 184 route views match exactly; the 24 differences below all come from reviewed HO-G PR #265 (`b33d36a`). The later UC-G merge adds no differences to this default matrix.

The audit recorded both checkouts with the snapshot collector from `tests/ui-custom/unit/client-defaults-ui.mjs`. Full results are in `.context/fix-1/defaults-diff.json`. Chat was also recorded with its transcript and seeded coworker review loaded: all eight chat/room views match. The approval and declined views also wait for the lazy action preview on both checkouts. Waiting for that data avoids accepting an initial loading state as a baseline.

| Differing route view | Reviewed reason |
| --- | --- |
| `1280-dark-bot-activity` | HO-G makes Flow the default for a new bot; the Flow page replaces Activity statistics. |
| `1280-dark-bot-setup-files` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-dark-bot-setup-harness` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-dark-bot-setup-history` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-dark-bot-setup-responsibilities` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-dark-bot-setup` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-light-bot-activity` | HO-G makes Flow the default for a new bot; the Flow page replaces Activity statistics. |
| `1280-light-bot-setup-files` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-light-bot-setup-harness` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-light-bot-setup-history` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-light-bot-setup-responsibilities` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-light-bot-setup` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-dark-bot-activity` | HO-G makes Flow the default for a new bot; the Flow page replaces Activity statistics. |
| `390-dark-bot-setup-files` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-dark-bot-setup-harness` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-dark-bot-setup-history` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-dark-bot-setup-responsibilities` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-dark-bot-setup` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-light-bot-activity` | HO-G makes Flow the default for a new bot; the Flow page replaces Activity statistics. |
| `390-light-bot-setup-files` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-light-bot-setup-harness` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-light-bot-setup-history` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-light-bot-setup-responsibilities` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-light-bot-setup` | HO-G adds the Agent flow compact card above the Setup content. |

Source evidence: `web/src/components/DetailsPanel.tsx` selects the Flow default and `flow-page`; `web/src/components/config/AgentConfiguration.tsx` adds `FlowCompact` before every Setup subtab. These changes are in `git show b33d36a -- web/src/components/DetailsPanel.tsx web/src/components/config/AgentConfiguration.tsx`.


## Local verification

All checks use local fixture data and mock providers. Logs are under `.context/fix-1-rebase/`. Both cached defaults checkouts and all 210 snapshot/metadata files were deleted first; `cache-reset.log` records the reset, and `defaults-fresh.log` starts with a new detached checkout at `5294c85`.

The expanded unit command runs on the branch and untouched main:

```sh
node --import tsx --test --test-concurrency=1 tests/ui-custom/*.test.mts tests/ui-custom/unit/*.test.mts tests/flow/*.test.mts tests/navigation-*.test.mts tests/structural-navigation.test.mts tests/handoffs/integration-i.test.mts
```

| Command | Result | Log |
| --- | --- | --- |
| `npm run typecheck` | Server and web pass, 2/2, zero errors | `typecheck.log` |
| `npm run build -w web` | Production build passes | `build.log` |
| Expanded unit command above | Branch 667/667, zero failures/skips; main 655/656, one timing failure described below | `unit.log`, `unit-main-isolated.log` |
| `node --import tsx tests/navigation-every-route-ui.mjs` | 850/850 route/size/theme cases, zero failures, including Flow | `navigation-fresh.log` |
| `node tests/ui-custom/unit/client-defaults-ui.mjs` | Fresh 208/208: 208 exact matches, 0 reviewed | `defaults-fresh.log` |
| `node tests/ui-custom/demo-fix-1.mjs` | 40/40 pass | `demo.log` |
| `node tests/layout-alignment-ui.mjs` | 208/208 route views, zero issues | `alignment.log` |
| `node tests/flow/demo-g.mjs` | 36/36 pass | `flow-demo.log` |
| `node tests/handoffs/integration-routes-ui.mjs` | 42/42 pass, zero real provider calls | `integration-ui.log` |
| `node --import tsx --test tests/ui-custom/sources-performance.test.mts` | Branch 1/1; main 0/1, timing failure | `source-performance-branch.log`, `source-performance-main.log` |

The branch adds two Flow route round trips and nine comparison controls to the 656 tests on main. Untouched main's isolated run has one source-performance failure: p95 167.89 ms against a 150 ms limit. A focused comparison records main 169.08 ms and branch 144.99 ms; the test and source implementation have no diff from main. The branch passes its complete 667-test run and the focused comparison. There are no new failures versus main.

Acceptance evidence:

- [x] Flow renders with rich, empty and malformed local models, shared navigation and avatar, and no browser errors: FIX-1 demo 40/40 and navigation 850/850.
- [x] Flow/Activity browser Back and Forward stay synchronized with HO-I's route contract: FIX-1 demo 40/40 and existing Flow demo 36/36.
- [x] Every HO-I geometry change is audited and listed above, with complete node/token records in `defaults-diff.json`; 184 unchanged views, 24 explained changes, 208 equal token maps.
- [x] The baseline pins untouched main `5294c85`, retains 208 views and the reviewed-pin comment, and has no stale FIX-1 exceptions: fresh defaults 208/208 exact matches.
- [x] Typecheck, customization/Flow/navigation tests and Paper v3 alignment pass locally. HO-I's mounted API integration passes 42 checks.

Scope deviations: none. Verification limitation: the unchanged source-performance test exceeds its timing budget on main as recorded above. Requests for other workstreams: none; HO-I's Flow API mounts are integrated. The PR stays open for orchestrator review and merge.

## Demo evidence

`node tests/ui-custom/demo-fix-1.mjs` writes `.context/ui-custom/demo-fix-1/report.json`. It covers rich, empty, missing-array and null models at 320, 390, 500, 768 and 1280 px in both themes, shared Back and avatar, reloads, browser history, Flow/Activity transitions and zero browser errors.

Screenshots:

- `.context/ui-custom/demo-fix-1/rich-390-light.png`
- `.context/ui-custom/demo-fix-1/empty-390-light.png`
- `.context/ui-custom/demo-fix-1/rich-390-dark.png`
- `.context/ui-custom/demo-fix-1/empty-390-dark.png`
- `.context/ui-custom/demo-fix-1/rich-1280-light.png`
- `.context/ui-custom/demo-fix-1/empty-1280-light.png`
- `.context/ui-custom/demo-fix-1/rich-1280-dark.png`
- `.context/ui-custom/demo-fix-1/empty-1280-dark.png`
