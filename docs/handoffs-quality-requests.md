# Quality gate integration record

HO-H integrates main `308ccf17`, including FIX-4, FIX-5, FIX-6, HO-Q and HO-Q2. Production source and dependencies are unchanged. The owner authorized the correction to the shared receipt quality guard after its false failure on real one-pass receipts.

## Receipt guard correction

The failing real receipt contains one `.ho-chip`, inside `.ho-receipt-meta`, with the correct text `1 pass`. Loading and stopped status text use the separate `.ho-status` element. The selector was selecting the intended chip. The expression `passes?` accepts `passes` and `passe`, but rejects `pass`; `pass(?:es)?` fixes that grammar without changing the allowed label forms.

`node tests/handoffs/loop-chip-quality.mjs` exercises the real rendered receipt and the shared browser inspector: seven checks pass. It accepts `1 pass`, `3 passes` and `Pass 1 of 3`, and rejects `1 passe`, `Loop, 3 passes`, `Loading` and an empty chip. The quality runner includes this regression. No production correction is needed for this failure.

## Capture and Flow test synchronization

Receipt capture also waits for loop summaries. The expand control can exist while a group still shows Loop and Loading, and older groups in the same chat resolve independently. The demo waits for the selected loop's exact name before expansion; the shared screenshot helper waits for every rendered group before the unchanged quality audit. Failure screenshots retain the failed state. `node tests/handoffs/receipt-ready.mjs` passes seven checks using two real loops, deliberately delaying the older summary response and proving that both readiness and capture remain pending. The strict title guard still rejects that loading state, and a mismatched resolved title cannot satisfy the selected loop's wait.

Journey 10 retains keyboard activation of every displayed node, destination mapping, keyboard reading order and return-focus assertions. It waits for the canonical Flow URL after Back because the chart can remain mounted behind a destination. It then observes stable focus beyond the Flow refresh debounce.

The installed Playwright implementation treats an async `waitForFunction` predicate as truthy before its resolved boolean is checked. The test now explicitly polls the resolved result of `page.evaluate`. This corrects a test that could proceed while focus restoration was still pending. No browser events, production callbacks or destination assertions are disabled.

## Current verification

After the receipt wait correction, typecheck passes again, the delayed-summary regression passes 7/7, and both complete browser runs below exit zero. Fresh evidence is consolidated in `.context/handoffs/final-receipt-report.json`.

`HO_D_AXE_PATH=.context/handoffs/axe.min.js HANDOFFS_EVIDENCE=.context/handoffs/receipt-ready-journeys node tests/handoffs/e2e/journeys.mjs` exits zero: 24 journeys pass, zero fail; all 18 real-capture audits and 592 mandatory quality views pass. Both one-pass receipts and the visible Saved status remain in the checks. The earlier FIX-6 failures are retained under `fix6-journeys/`; the superseded run with the async predicate is explicitly marked aborted under `fix6-journeys-before-predicate-fix/`.

The demo of record passes 40 checks with zero failures across 320, 390, 500 and 1280 in light and dark. All eight converging loops and eight capped loops have three passes, six completed steps and three verdicts, with these exact results:

- `Done in 3 passes: all checks passed.`
- `Stopped after 3 passes (limit). 2 of 3 checks still fail.`

The demo imports the mandatory merged quality checker, which passes all 592 views. Its descriptive receipt controls use `^Show passes\b` and `^Hide passes\b`; each loop is counted only after its expanded receipt capture succeeds. All 104 captures pass automated checks and manual inspection against BUILD-SPEC 0b, 0c and 0d. Settings Agents is included, and no capped result remains marked failing. Evidence: `.context/handoffs/demo-h/report.json` and `inspection.json`.

The unchanged full chain recorded before this test-only receipt correction passes 738 Node tests, with zero failures or skips, including 38 security cases and eight widget contracts. Clean main passes 690 tests; HO-H adds 48 cases. Both workspace typechecks and the candidate web build pass. Existing UI suites pass 441 checks across ten commands, and handoff route layout/accessibility passes 12 checks with axe enabled and no skips. Evidence is retained under `fix6-checks/`, `fix6-baseline/`, `fix6-existing-ui/` and `fix6-followup/`.

Shared alignment passes 364 general/dashboard views, 42 dashboard-suggestion checks and 592 handoff views. Navigation passes 870 route/size/theme cases. All nine supporting demo/export commands pass: HO-A checks its packet and layout plans; HO-B 2 scenarios; HO-C 11 scenarios; HO-D 54 checks; HO-E 24 replays; HO-F 25 server and 10 UI checks; HO-I 84 checks; real-runtime loops 2 scenarios; polish exporter 12 captures plus 592 quality views. Logs and exit codes are under `fix6-followup/` and `fix6-demos/`.

The retained performance run passes all 11 budgets: five server/bundle and six browser. The committed baseline is unchanged. Server p95 values are 2.31ms output creation, 26.49ms handoff POST, 4.57ms cold Flow and 1.55ms warm Flow. Browser p95 values at 390/1280 are 31.50/29.90ms for the 12-step Timeline, 28.70/29.90ms for Flow paint and 42.00/41.70ms for SSE updates. Evidence: `fix6-perf/report.json` and `perf-h/measured.json`.

## Resolved production requests

| Issue | Resolution | Evidence |
|---|---|---|
| Checker verdict tools lacked a stable call ID | FIX-4 passes the active call ID | Real loops in the demo converge and cap |
| Activity lacked the handoff list | FIX-5 mounts All, Sent and Received filters | Journey 7 and Activity quality checks |
| Room progress was missing | FIX-5 projects committed loop transitions | Journey 9 uses real events, without seeded progress rows |
| Demo I used the old dashboard label | FIX-5 selects Create | `node tests/handoffs/demo-i.mjs` |
| Receipt spacing and labels needed polish | HO-Q and HO-Q2 group passes and name controls | Mandatory quality checks and fresh expanded-receipt captures |
| Saved status failed contrast | FIX-6 uses the text success token | Journey 8 waits for Saved and audits it with axe 4.10.3 |

## Verification limits

The deployed `BASE_URL` mode is implemented and documented but has not been exercised without an isolated deployed test account configured for the scripted provider. The bundle comparison measures HO-H additions against integrated main, not historical pre-feature cost. Performance measurements are rerun without refreshing the committed baseline when its budgets pass.

Historical reports remain in `.context/handoffs/`. The current `.context/handoffs/final-receipt-report.json` distinguishes fresh receipt regression, journeys, demo and typecheck results from the unchanged full-chain evidence in `final-fix6-report.json`. Earlier accessibility runs without axe do not establish contrast compliance. The previous demo captures are archived under `demo-before-receipt-ready-20261128T022849Z/`. There are no outstanding production requests from this verification.
