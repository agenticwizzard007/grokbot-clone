# Continuous agent tasks and explicit budgets

Agent tasks can continue past the previous six-minute subscription generation deadline and the 60/150 tool-step limits. The same durable job continues until it finishes, waits for a human decision, reaches an explicit budget, fails or is stopped. This applies to Claude and Codex through the personal bridge, hosted runner and isolated tenant runner.

## Execution boundaries

The foreground model client passes `subscriptionTimeoutMs: 0`. The adapter, bridge, runner, isolated client, supervisor and worker preserve zero as an explicit opt-out from a total generation deadline. API requests retain their own timeout. Authentication, login, startup, housekeeping and individual tool-operation deadlines remain finite; background learning reviews keep their five-minute per-request timeout and independent iteration/input budgets.

After 60 native tool calls, Swarm closes that CLI generation and starts another within the same job. Completed calls and results have already been persisted; the next generation consumes them without dispatching them again. The generation's replay cache is reset and current context can be refreshed or compacted. Approval, end-turn and context-change boundaries take precedence. API-backed tasks also have no fixed total tool-round cutoff.

Stop targets the current generation and prevents further actions. In-flight actions settle before the same Bot's queue is released, preserving their outcome. Stop does not promise to undo an external action. Disconnect, credential changes, cancellation escalation, account isolation and per-Bot ordering remain in force. An idle provider can wait indefinitely until it responds, fails or the user stops it; transport liveness is not evidence of model progress.

## Goal budgets

New goals use `maxTurns: 0` when the field is omitted. Zero means no turn-count limit. A positive value still limits reserved durable turns; checkpoints within one job do not consume additional turns. The UI field is optional: blank means no limit, and positive values remain visible on the saved goal.

Existing saved goals are not rewritten. A saved ten-turn budget remains ten, including records made with the former default, because storage cannot distinguish that old default from an explicit choice. Token and spend budgets remain independent of the optional turn limit.

The dispatcher checks the current shared budget and coordinator authority both before preparation and after asynchronous validation/policy lookup, immediately before approval or dispatch. If a teammate exhausts a shared token/spend budget during validation, the waiting action cannot execute.

Usage at a stopped CLI checkpoint can be a lower bound even when both input and output counters are present. Those observed values remain in usage reports. For a finite token budget, partial totals mean the remaining allowance is unknown and the goal pauses. Uncapped goals can continue, and subscription cost attribution remains independent. Observed usage cannot predict or undo the cost of an already-started model request.

## Maintained qualification

```sh
npm run test:hermes-native
npm run test:cli
node --test tests/tenant-image-release.test.mjs
```

- Runner, bridge, worker and supervisor tests advance clocks through 40 simulated minutes, then verify completion/cancellation/disconnect. A zero generation timeout still retains the independent startup deadline. Old-style bridge handshakes reject unsupported long requests without breaking status, catalog or finite requests; reconnecting with the current bridge enables the new behavior.
- Both providers execute 125 native actions through generations starting at actions 0, 60 and 120, with unique persisted results and one completed job. Stop after a checkpoint prevents later actions. An API task executes 165 tool rounds.
- New goals continue beyond ten turns, while finite turn/token/spend controls remain covered. Real validation-worker races test sibling budget exhaustion, goal pause and user Stop before any business mutation. Production usage recording verifies partial counters remain visible but cannot fund an exact token allowance.
- The real-server browser test covers omitted, untouched, cleared and explicitly finite limits; API, database and UI agree. Existing finite ten- and twenty-three-turn records survive creation, reload and restart unchanged. Each new UI goal executes an actual tool call and waits for a decision; cleanup explicitly stops it.
- Production detached-review tests use both subscription adapters and verify that a preceding unbounded foreground request does not change the reviewer's finite timeout or management-only tool surface.

These tests use isolated storage and deterministic provider/transport fixtures. Simulated elapsed time is not a live long-running provider benchmark.

The final local run on 2026-11-13 qualified runtime/test revision `40a3c133392af0f384537dd75cfb408f2a50292a`: 241 native tests, server/web typechecks, production build, all three real-server browser journeys, 255 CLI tests plus the HTTP/CLI smoke, and 12 tenant-image release contract tests passed with no failures or skips. The native browser suite includes the existing Hermes learning/coordination journey and the new optional-budget journey. Logs and screenshots are retained in the workspace under `.context/task-limits-final/`; GitHub checks qualify the subsequently pushed revision independently.

## Deployment handoff

Personal bridges must reconnect with a freshly downloaded script; older bridges receive an explicit update message. Hosted deployments must update the application and bundled runner. Isolated deployments must use the coordinated, source-bound application/runner/supervisor release; mixing versions can retain an old ceiling. No deployment or live-provider qualification is performed by these tests. See [subscription operations](cli-subscriptions.md) and [Hermes rollout requirements](hermes-build-recovery.md) before enabling accounts.
