# Quality gate integration record

HO-H integrates main `a9b3e990`, including FIX-4, FIX-5, HO-Q and HO-Q2. HO-H changes remain limited to its tests, demo, documentation and additive npm scripts.

## Pending contrast fix

The owner's verification against main `a9b3e990` passes 23 of 24 journeys. At 390, journey 8 finds a serious axe color-contrast violation on the Settings Agents Saved status. FIX-6 owns the production correction from `--color-success` to `--color-success-text` in `AppSettings.tsx`. HO-H does not change that file or exempt the status from accessibility checks.

Journey 8 now waits for the rendered Saved status before running the unchanged accessibility audit, so a completed API save cannot race its confirmation. The earlier local run had no axe installation and used the shared helper's permitted lightweight fallback. Its accessibility result does not establish contrast compliance. A standalone axe file supplied through the helper's existing local-file option enables contrast verification without changing repository dependencies.

The focused rerun with axe 4.10.3 reproduces the same serious `color-contrast` violation on `.cfg-chip.agents-saved` at 390. Journey 8 passes at 1280: one pass, one failure. The mandatory merged UI quality checker passes all 592 views. Command: `HANDOFFS_JOURNEYS=8 HANDOFFS_EVIDENCE=.context/handoffs/saved-chip-check node tests/handoffs/e2e/journeys.mjs`. Report: `.context/handoffs/saved-chip-check/report.json`. No accessibility rule or threshold was changed.

## HO-Q2 demo rerun

HO-Q2 gives the receipt expansion control and pass group descriptive accessible names. The demo now selects `Show passes` and `Hide passes` by word-boundary prefix and finds the named pass group by its `passes` suffix. A loop scenario is counted as passed only after the expanded receipt screenshot succeeds. No stale exact-name selectors remain in the HO-H journeys or demo; the existing polish exporter also passes.

On main `a9b3e990`, `node scripts/handoffs-demo.mjs` passes 40 checks with zero failures across 320, 390, 500 and 1280 in light and dark. All eight converging loops and eight capped loops reach the exact sentences below. The mandatory quality checker passes 592 views, and all 104 fresh captures pass automated and manual inspection. Evidence: `.context/handoffs/demo-h/report.json` and `inspection.json`. The previous demo is retained under `.context/handoffs/demo-before-q2-20261128T005739/`.

The refreshed Node suites pass 738 tests with zero failures or skips, including 38 security cases and eight widget contracts. Typecheck and the web build pass. The polish exporter passes 12 captures. `node tests/handoffs/perf/server.mjs` passes five budgets and `node tests/handoffs/perf/browser.mjs` passes six; the committed baseline is unchanged. Current evidence is summarized in `.context/handoffs/q2-report.json`. The full 24-journey gate remains pending FIX-6.

The remaining counts below are historical results from main `6af24740`, pending a complete journey rerun after FIX-6 lands.

## Resolved integration requests

| Issue | Resolution | Evidence |
|---|---|---|
| Checker verdict tools lacked a stable tool call ID | FIX-4 supplies the active call ID in the runtime context | `node --import tsx tests/handoffs/e2e-loop-real.mjs`: 2/2 real loops pass on candidate and main |
| Bot Activity did not mount the handoff list | FIX-5 mounts All, Sent and Received filters | Journey 7 passes at 390 and 1280; Activity quality passes 32 states |
| Committed loop transitions did not appear in rooms | FIX-5 projects committed transitions with rollback and recovery coverage | Journey 9 passes at 390 and 1280 using real loop events, without seeded progress rows |
| Demo I expected the old dashboard action label | FIX-5 uses Create | `node tests/handoffs/demo-i.mjs`: 84 checks pass on candidate and main |
| Receipts needed compact grouping, spacing and copy | HO-Q supplies collapsed Loop groups and explicit pass expansion | Mandatory quality checker: 568 passing views; fresh demo inspection: 104 accepted captures |

## Historical journeys and demo

`node tests/handoffs/e2e/journeys.mjs` passes all 24 journeys with no skips. Its 568 mandatory quality views and 18 real-capture audits pass. Report: `.context/handoffs/final-journeys/report.json`.

Two genuine test timing issues were corrected. Journey 9 waits for the Checker recipient before asserting the complete member list. Journey 10 activates the intended Flow node with one locator keyboard action instead of separating focus from a page-level Enter. Destination and return-focus assertions remain intact. Earlier 22/24 and 23/24 reports are retained under `integrated-journeys/` and `integrated-journeys-final/`.

`node scripts/handoffs-demo.mjs` passes 40 checks. Eight real two-agent loops converge and eight reach the cap, covering 320, 390, 500 and 1280 in light and dark. Each loop has three passes, six completed steps and three verdicts, with the expected event sequence. The exact sentences are:

- `Done in 3 passes: all checks passed.`
- `Stopped after 3 passes (limit). 2 of 3 checks still fail.`

The historical demo records 104 screenshots and clean capture audits, plus 568 mandatory checker views. Every capture was inspected against BUILD-SPEC 0b, 0c and 0d. Expanded loop groups show individual passes. Settings Agents is included. `.context/handoffs/demo-before-q2-20261128T005739/inspection.json` records 104 passes, zero pending, zero rejected and no runtime-blocked capped result. Earlier receipt captures remain under `demo-before-q/`.

## Historical verification evidence

Candidate and main results are retained under `.context/handoffs/integrated-checks/` and `integrated-followup/`, with matching directories inside `main-polish-baseline/.context/handoffs/`. The candidate Node suites pass 735 tests; main passes 687. HO-H adds 38 security cases, eight widget contract cases and two mock-script cases. Both pass typecheck, web build and the real-runtime loop regression. The candidate's ten existing UI suites pass 441 checks.

Both branches pass shared alignment covering 250 general/dashboard views, 42 dashboard-suggestion checks and 568 handoff views, plus 870 navigation cases. The candidate's route layout and accessibility audit passes 12 cases with no skips. All 11 fresh performance budgets pass; the committed reference remains unchanged.

Main's initial loop behavior run timed out when its Retry control disappeared before the click. The unchanged standalone rerun passes all 37 checks, bringing its existing UI comparison to 441 passing checks. The original failure and successful retry are both retained under the baseline worktree's evidence directory.

The final consolidated report is `.context/handoffs/final-report.json`. It records the completed alignment, navigation and performance commands, comparison counts and any retained retry evidence. Passing performance measurements are saved separately in `.context/handoffs/perf-h/measured.json`; the committed reference is not refreshed for a passing run.

The deployed `BASE_URL` mode is implemented and documented, but has not been exercised without an isolated deployed test account configured for the scripted provider. The bundle comparison measures HO-H additions against integrated main, not historical pre-feature cost.
