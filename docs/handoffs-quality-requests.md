# Quality gate integration requests

These requests are reproduced against integrated main. HO-H owns tests and documentation only. A failing quality gate must remain failing until the production owner fixes the behavior.

## Runtime tool call context: resolved by FIX-4

FIX-4 merged in main `bfe30f8` and is integrated into HO-H. `node --import tsx tests/handoffs/e2e-loop-real.mjs` passes both scenarios: convergence and cap at three passes, each with three verdicts and six output receipts. The required Node suites pass 715 tests on HO-H and 667 on main. The full UI matrix passes 20 of 24 journeys; only Activity and room progress fail at both widths. Convergence, capped continuation and agent approval all pass without a test-only runtime workaround.

Before FIX-4, `server/src/agent/loop.ts` omitted `toolCallId` when invoking registered handoff tools. A real Checker called `submit_verdict`, received `This tool needs an active run and a stable tool call id. Ask the user to retry from an active run.`, and stopped with `no_verdict` on pass 1.

Regression commands: `node --import tsx tests/handoffs/e2e-loop-real.mjs` and `node scripts/handoffs-demo.mjs`. The headless demo supplies a context directly and does not catch a missing runtime argument. The live demo must reach both exact three-pass result sentences.

Historical evidence in `.context/handoffs/runtime-refusals-polish.json` records 32 refused `submit_verdict` calls across 16 loop attempts on main `56e65ba`. The provider emitted real verdict calls with the actual checklist IDs. Those failures are not evidence against FIX-4.

## Room and task event projection

FIX-5 (`fix-5-handoff-gaps`) owns invoking `projectHandoffEvent` for committed handoff and loop transitions, with idempotent recovery and no side effects after rollback. Journey 9 remains a mandatory check.

`server/src/handoffs/rooms.ts` exports `projectHandoffEvent`, which synchronizes room rows and task state. No production caller exists on this baseline. `server/src/handoffs/db.ts` records the event and emits SSE but does not project it. Real loop creation with a room ID produces no visible room progress.

Reproduce: `HANDOFFS_JOURNEYS=9 node tests/handoffs/e2e/journeys.mjs`. After FIX-4, journey 5 passes the gate task, needs-input count, Approve and Decline checks at both widths. The separate gate-task path in `loop-service.ts` does not resolve the missing room projection.

Journey 9 at both widths records `loop.created`, `loop.started` and `loop.finished` with `stopReason: "user_stopped"`, but zero corresponding room progress rows. It does not reach the Checker. The full post-FIX-4 run reproduces the same failure in `.context/handoffs/fix4-journeys/report.json`.

## Activity handoff list

FIX-5 owns mounting the existing `HandoffList` on the Bot Activity page, with All, Sent and Received filters and one Back control. Journey 7 remains a mandatory check.

The component exists in `web/src/handoffs/HandoffList.tsx`; the baseline Bot Activity surface does not mount it. Reproduce: `HANDOFFS_JOURNEYS=7 node tests/handoffs/e2e/journeys.mjs`.

Journey 7 at both widths verifies a completed handoff and a nonempty list API before the Activity filter lookup fails. This is independent of loop verdict submission. The full post-FIX-4 report above records the completed status and listed IDs.

## Existing HO-I demo label

FIX-5 owns updating `tests/handoffs/demo-i.mjs:225` to use the dashboard manager's current `Create` button. It still asserts a button named `New dashboard`. The manager changed that label in UC-X2.

`node tests/handoffs/demo-i.mjs` fails at this assertion at 1280 on both HO-H and main `bfe30f8`, after 67 passing checks. FIX-5 will correct this shared baseline failure. Logs: `.context/handoffs/fix4-demos/i.log` and `.context/handoffs/main-polish-baseline/.context/handoffs/fix4-demos/i.log`.

## UI polish and Settings dependencies

HO-P is merged in main `56e65ba`. Its checker is a mandatory import in the demo and e2e, with no skip path. The demo asserts clean visible copy and captures four widths in both themes, with the same quality inspector beside every image. The merged type scale permits 12px status chips, with body text at least 14px and metadata at least 13px.

HO-I stage 2 is merged. Settings Agents is mandatory in the route audit, standing-link journey and four-width demo. The standing-link journey verifies automatic mode and pair approval through the real controls and restores suggestion mode afterward.

## Evidence and release status

The current quality gate is blocked on FIX-5 and HO-Q. Completion requires all 24 journeys to pass on a branch containing both merges, followed by fresh screenshot inspection. Journeys 7 and 9 are not skipped.

- `.context/handoffs/demo-h/report.json` records 40 passing checks and zero failures after FIX-4. All eight converging runs end with `Done in 3 passes: all checks passed.` All eight capped runs end with `Stopped after 3 passes (limit). 2 of 3 checks still fail.` Each has three passes, six completed steps and three verdicts. All 88 screenshot audits and 544 mandatory checker views pass.
- `.context/handoffs/demo-h/inspection.json` covers seven primary surfaces at 320, 390, 500 and 1280 in both themes. It records 48 visual passes, eight receipt views pending HO-Q and zero screens blocked by runtime failures. All capped-result views are functionally verified. The previous failing-cap evidence is archived under `demo-before-fix4/`.
- `.context/handoffs/fix4-journeys/report.json` contains the complete 20-pass, 4-failure matrix at both required widths, with 18 clean capture audits and 544 passing checker views. The separate forced-pagination regression remains under `menu-pagination-smoke/`.
- `.context/handoffs/fix4-checks/`, `fix4-existing-ui/` and `fix4-demos/` preserve candidate results. Matching directories inside `main-polish-baseline/.context/handoffs/` preserve main `bfe30f8` results. Existing regressions are compared separately from acceptance failures.
- Candidate and main both pass 870 navigation cases and shared alignment covering 250 general/dashboard views, 36 suggestion checks and 544 handoff views. All 11 fresh performance budgets pass in `tests/handoffs/perf/baseline.json` against main `bfe30f8`.

The deployed `BASE_URL` mode is implemented and documented, but has not been exercised without an isolated deployed test account configured for the scripted provider. The bundle comparison measures HO-H additions against the integrated main baseline; a historical pre-feature bundle comparison remains separate.
