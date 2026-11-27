# Quality gate integration requests

These requests are reproduced against integrated main. HO-H owns tests and documentation only. A failing quality gate must remain failing until the production owner fixes the behavior.

## Runtime tool call context

FIX-4 owns this production fix: pass the stable call ID into registered handoff tools on every runtime dispatch path, including native and resumed tool execution. HO-H will merge main and rerun all 24 journeys after that fix merges, without a test-only runtime workaround.

`server/src/agent/loop.ts` calls `impl.impl(args, { ...ctx, depth: st.depth })` without `toolCallId`. `server/src/agent/handoff-tools.ts` requires `userId`, `botId`, `jobId` and `toolCallId`. A real Checker calls `submit_verdict`, receives `This tool needs an active run and a stable tool call id. Ask the user to retry from an active run.`, and the controller eventually stops with `no_verdict` on pass 1.

Reproduce: `node scripts/handoffs-demo.mjs`. The headless demo supplies a context directly and therefore does not catch this missing runtime argument. The live demo must reach both exact three-pass result sentences without a test-only runtime patch.

The post-polish demo records 32 distinct refused `submit_verdict` calls across 16 loop attempts. The mock provider emits the verdict, including the real checklist IDs; the runtime returns the missing-context refusal. Evidence: `.context/handoffs/demo-h/provider-requests.json` and `.context/handoffs/runtime-refusals-polish.json`.

## Room and task event projection

Request to HO-B: invoke `projectHandoffEvent` for committed handoff and loop transitions, with idempotent recovery and no side effects after rollback.

`server/src/handoffs/rooms.ts` exports `projectHandoffEvent`, which synchronizes room rows and task state. No production caller exists on this baseline. `server/src/handoffs/db.ts` records the event and emits SSE but does not project it. Real loop creation with a room ID produces no visible room progress.

Reproduce: `HANDOFFS_JOURNEYS=9 node tests/handoffs/e2e/journeys.mjs`. After fixing runtime context, journey 5 must also verify the gate task and needs-input count.

An isolated journey 9 at both widths records `loop.created`, `loop.started` and `loop.finished` with `stopReason: "user_stopped"`, but zero corresponding room progress rows. It does not reach the Checker, so FIX-4 cannot resolve this failure. See `.context/handoffs/independent-integration/report.json`.

## Activity handoff list

Request to the Bot-details integration owner: mount the existing `HandoffList` on the Bot Activity page, with All, Sent and Received filters and one Back control.

The component exists in `web/src/handoffs/HandoffList.tsx`; the baseline Bot Activity surface does not mount it. Reproduce: `HANDOFFS_JOURNEYS=7 node tests/handoffs/e2e/journeys.mjs`.

An isolated journey 7 at both widths verifies a completed handoff and a nonempty list API before the Activity filter lookup fails. This is independent of loop verdict submission. The same report above records the completed status and listed IDs.

## UI polish and Settings dependencies

HO-P is merged in main `56e65ba`. Its checker is a mandatory import in the demo and e2e, with no skip path. The demo asserts clean visible copy and captures four widths in both themes, with the same quality inspector beside every image. The merged type scale permits 12px status chips, with body text at least 14px and metadata at least 13px.

HO-I stage 2 is merged. Settings Agents is mandatory in the route audit, standing-link journey and four-width demo. The standing-link journey verifies automatic mode and pair approval through the real controls and restores suggestion mode afterward.

## Evidence and release status

The current quality gate is blocked. Do not treat passing component fixtures or regression suites as acceptance of the real feature.

- `.context/handoffs/demo-h/report.json` contains the actual loop records, events, screenshot quality records and explicit failures. The scripted drafts use realistic release notes, and each handoff selects the output from its newly completed job.
- `.context/handoffs/demo-h/inspection.json` records the inspection of receipt, running and finished timeline, Graph, Flow and cap-scenario views at 320, 390, 500 and 1280 in both themes. The cap scenario fails before the limit; its images are failure evidence, not a capped success substitute.
- `.context/handoffs/e2e-polish-final/report.json` contains the refreshed journey matrix at both required widths. The later historical-message and Settings regression is recorded under `menu-pagination-smoke/`, including its fixture variation that forces pagination. Earlier attempts remain under `e2e-h/`, `pre-polish/` and `e2e-refresh/`.
- `.context/handoffs/quality-polish/` preserves the candidate regression results; `.context/handoffs/baseline-polish/` preserves main `56e65ba` results. Existing tests are compared separately from the new acceptance failures.

The deployed `BASE_URL` mode is implemented and documented, but has not been exercised without an isolated deployed test account configured for the scripted provider. The bundle comparison measures HO-H additions against the integrated main baseline; a historical pre-feature bundle comparison remains separate.
