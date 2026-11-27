# Quality gate integration requests

These requests are reproduced against main `5294c85`. HO-H owns tests and documentation only. A failing quality gate must remain failing until the production owner fixes the behavior.

## Runtime tool call context

Request to HO-I and the runtime owner: pass the stable call ID into registered handoff tools on every runtime dispatch path, including native and resumed tool execution.

`server/src/agent/loop.ts` calls `impl.impl(args, { ...ctx, depth: st.depth })` without `toolCallId`. `server/src/agent/handoff-tools.ts` requires `userId`, `botId`, `jobId` and `toolCallId`. A real Checker calls `submit_verdict`, receives `This tool needs an active run and a stable tool call id. Ask the user to retry from an active run.`, and the controller eventually stops with `no_verdict` on pass 1.

Reproduce: `node scripts/handoffs-demo.mjs`. The headless demo supplies a context directly and therefore does not catch this missing runtime argument. The live demo must reach both exact three-pass result sentences without a test-only runtime patch.

## Room and task event projection

Request to HO-B: invoke `projectHandoffEvent` for committed handoff and loop transitions, with idempotent recovery and no side effects after rollback.

`server/src/handoffs/rooms.ts` exports `projectHandoffEvent`, which synchronizes room rows and task state. No production caller exists on this baseline. `server/src/handoffs/db.ts` records the event and emits SSE but does not project it. Real loop creation with a room ID produces no visible room progress.

Reproduce: `HANDOFFS_JOURNEYS=9 node tests/handoffs/e2e/journeys.mjs`. After fixing runtime context, journey 5 must also verify the gate task and needs-input count.

## Activity handoff list

Request to the Bot-details integration owner: mount the existing `HandoffList` on the Bot Activity page, with All, Sent and Received filters and one Back control.

The component exists in `web/src/handoffs/HandoffList.tsx`; the baseline Bot Activity surface does not mount it. Reproduce: `HANDOFFS_JOURNEYS=7 node tests/handoffs/e2e/journeys.mjs`.

## UI polish and Settings dependencies

HO-P owns handoff and Flow visual fixes and `tests/handoffs/ui-quality.mjs`. HO-H calls that test if present and reports a clear skip otherwise. Skipping it is not visual acceptance. The demo asserts clean visible copy and captures four widths in both themes, with typography evidence beside the images. Production fixes belong in the HO-P branch.

HO-I stage 2 owns Settings Agents. The route check skips only while the navigation registry lacks that section. After it merges, the real Settings controls become mandatory in the route and standing-link journeys.
