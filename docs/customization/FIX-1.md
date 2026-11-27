# FIX-1 default-layout baseline review

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

The baseline retains 208 views, the same widths, themes and fixed history timestamp. Its checkout directory now includes the pin, so a cached old checkout cannot survive a pin change. The collector waits for the actual details page, transcript, coworker review and lazy action preview before measuring; immutable assets can use the browser cache.

FIX-1 routes Flow and its link sheet through shared navigation and removes the temporary duplicate header. Invalid flow models use the existing Retry state. Detail tabs can wrap on narrow desktop panes so the added Flow tab keeps every label visible. No cosmetic theme or font changes.

## Reviewed FIX-1 differences

The pre-fix pin cannot fully match the corrected navigation. `reviewedDifferences` in `client-defaults-baseline.json` records only these two route views:

| Route view | Reason and measured change |
| --- | --- |
| `390-light-bot-activity` | FIX-1 uses the shared Flow header and removes the phone tabs exposed by the invalid-route fallback. The shared header is `[0, 0, 390, 56]`; the old phone tab box `[0, 787, 390, 57]` is absent. |
| `390-dark-bot-activity` | The same shared-navigation correction in dark mode, with the same header and removed phone tab boxes. |

These views are reported as `REVIEWED`, not skipped. `client-defaults-compare.mjs` compares their complete token maps, every non-navigation node (including exact Page and card bounding boxes), the navigation boxes recorded in the JSON, and navigation styles. The Flow Page remains `[0, 117, 390, 286]` in both views. Every unlisted view must match its complete pinned snapshot. A review also fails if the pin already matches, so stale exceptions cannot silently remain. Nine negative/control tests cover tokens, Page and card boxes, navigation boxes and styles, missing Pages, unlisted differences and stale reviews.

The final accounting is 206 exact matches plus 2 reviewed views, for 208 of 208. Desktop Activity and all Setup views still compare in full against the pin. The two FIX-1 differences are separate from the 24 reviewed HO-G changes between the old and new pins above.

The crashes had two causes. The temporary Flow adapter wrote a hash that `parseScreen` did not recognize, so navigation history could receive a null screen and read its `kind`. Its separate header also hid the shared Back control and avatar. Separately, the client accepted incomplete successful API responses as `FlowModel`; FlowTab and FlowCompact then called `map` on missing arrays. The fix registers Flow and link-sheet routes with the shared router and validates the model before storing it.

## Local verification

All browser data is local fixture data. Logs are under `.context/fix-1/`.

| Command | Result | Log |
| --- | --- | --- |
| `npm run typecheck` | Server and web pass, 2/2 | `typecheck-reviewed.log` |
| `node --import tsx --test --test-concurrency=1 tests/flow/*.test.mts tests/navigation-*.test.mts tests/structural-navigation.test.mts tests/ui-custom/unit/*.test.mts` | 337/337 pass; untouched main 326/326, with two additional Flow route cases and nine comparison cases here | `unit-reviewed.log`, `unit-main-latest.log` |
| `node --import tsx tests/navigation-every-route-ui.mjs` | 800/800 pass, zero failures | `navigation-reviewed.log` |
| `node tests/ui-custom/unit/client-defaults-ui.mjs` | 208/208: 206 exact matches and 2 reviewed navigation differences | `defaults-reviewed.log` |
| `node tests/ui-custom/demo-fix-1.mjs` | 40/40 pass: rich, empty, missing arrays and null models; five widths; both themes | `demo-reviewed-final.log` |
| `node tests/flow/demo-g.mjs` | 36/36 pass, including link editing and focus return | `flow-demo-verified.log` |
| `node tests/layout-alignment-ui.mjs` | 208/208 route views, zero issues | `alignment-reviewed.log` |
| `node tests/ui-custom/unit/contracts-ui.mjs` | 3/3 pass | `contracts.log` |
| `node tests/ui-custom/navigation-top-level-no-back-ui.mjs` | 156/156 pass | `phone-navigation.log` |
| `node tests/ui-custom/unit/client-runtime-ui.mjs` | 21/21 pass | `client-runtime.log` |
| `node tests/ui-custom/unit/client-composer-ui.mjs` | 12/12 pass | `client-composer.log` |
| `node tests/ui-custom/unit/client-production-ui.mjs` | 3/3 pass | `client-production.log` |
| `node tests/ui-custom/unit/client-performance-ui.mjs` | 3/3 pass on branch and main | `client-performance-recheck.log`, `client-performance-main-latest.log` |
| `node tests/ui-custom/unit/client-scale-matrix-ui.mjs` | 12/12 pass | `client-scale-matrix.log` |

Four older browser suites retain identical failures on untouched main `e0d2cf9` and this branch. `bot-details-ui.mjs` times out on the removed Morning product walk switch (0 completed cases); `navigation-history-ui.mjs` on `.settings-nav__back` (0 completed cases); `navigation-routes-ui.mjs` on `.setup-paper__bar` Back (1 completed case); `readiness-yy-ui.mjs` records 21 passes and 5 failures before the same hidden `.chat__header` timeout. Their `*-main.log` and branch logs record the same selectors and failure names. No assertions were changed. Initial performance runs were sensitive to concurrent browser load; isolated repeats pass on both checkouts.

The rich and empty Flow demos use deterministic local models, as the existing HO-G demo does. Mounting `server/src/flow/routes.ts` remains the pre-existing HO-I integration request; this PR fixes routing and response handling without changing that server rollout.
