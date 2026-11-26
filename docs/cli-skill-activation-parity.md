# CLI skill activation parity, readiness round 12

## Cause

At `9981a52`, `propose_skill` always calls `stageSkillProposal`. Its description explicitly says it does not activate a skill. In contrast, `manage_skill` activates an attended change when `skillApproval` is false. `propose_skill` is a core tool while `manage_skill` requires discovery. A model choosing the former can therefore leave a pending proposal without an action approval card. This reproduces the reported state through the official hosted Claude binary using a local model response that chooses that tool. The same choice also affects Codex.

We did not access the live account, its messages or its credentials. The exact tool chosen in that live turn cannot be established from the provided last-tool label alone. The regression exercises that candidate through the production hosted path, including the wrapper seen in the report.

## Fix

On an attended CLI turn, `propose_skill` uses the same guarded create/update operation as `manage_skill`. Both enforce source evidence, current revisions, read-before-write, locked skills, ownership and the explicit skill approval setting. Text-only updates preserve resources and owner controls. The adapter projects only advertised content fields. The CLI instructions describe activation based on the tool result.

API-mode proposal behavior and maximum action approval are unchanged. Background proposals still stage. Existing pending proposals are not approved retroactively. `skillApproval` remains false by default. New-skill review copy now explains that the skill becomes active after approval; existing-skill copy explains that the current revision stays active.

## Internal-action audit

| Area | Finding |
| --- | --- |
| Job trigger and depth | Both providers enter the same persisted user job. `toolManagement` uses the job ancestry before depth. A durable user job stays attended through nested wrappers. Background management context takes precedence. No change needed. |
| `tool_call` | The shared loop unwraps the target before policy and dispatch for CLI plans. It keeps the original execution context. API maximum retains its separate outer/inner approval. No change needed. |
| CLI trust and MCP | Both official binaries reach the authenticated Swarm MCP session through hosted account profiles. Claude tools use its MCP name prefix; default Codex uses code mode. No trust changes needed. |
| Memory, tasks, files, routines | Shared tool definitions, implementation and policy. The real-binary matrix verifies persistence and no approval rows/cards for both providers. |
| App discovery and reads | Shared app policy checks provider-attested read-only metadata. Listing connections and an attested read execute on both plans. External writes retain existing approval coverage. |
| Prompts and tool selection | Both receive the shared tool descriptions, but core `propose_skill` contradicted the direct-activation policy. Description and CLI instructions now match execution. |
| Admission events and diagnostics | Unchanged. No Last tool run, task reply or sidebar wording changes. |

## Verification

`npm run test:cli-internal-parity` runs the official installed Codex 0.167.1 and Claude Code 2.1.322 binaries through `hosted.ts`, isolated profile environments, the deployed bridge and its per-generation MCP server. Subscription status and model outputs are local fixtures; no paid inference, live sign-in or real external write occurs. Codex leaves its model unset, preserving default code-mode selection. Both direct and deferred `propose_skill` calls are exercised.

The matrix checks memory, tasks, skill activation, saved file bytes, routines, app discovery, an attested app read, durable user attendance, no approval cards and no pending proposals. Additional official-binary cases cover updates and explicit skill approval for both tool names. Supplemental cases cover the production detached reviewer with a local model executor, inherited background context, missing-job depth and mutation guards. Existing production-review and API maximum suites cover their separate execution gates.

The local Playwright fixture checks Skills and Learning at 1280 and 390 pixels, in light and dark, for both provider selections. It checks empty, active, pending-new and pending-update states, the default approval toggle, accurate copy and page overflow. Screenshots are saved under `.context/cli-skill-panel/`.

The new parity suite passes all six tests, and the browser matrix passes all eight provider/width/theme combinations. Running the two official-binary action matrices against untouched `9981a52` fails for both providers: only the `manage_skill` skill is active; the direct and wrapped `propose_skill` skills remain pending. Build and type checks pass.

Full local comparison on this VM used `node --import tsx --test --test-reporter=tap --test-concurrency=2 tests/*.test.mts tests/*.test.mjs`. Untouched `9981a52`: 2,660 passed, 73 failed, 24 existing skips. Pre-rebase candidate `264b540`: 2,667 passed, 72 failed, the same 24 existing skips. After normalizing checkout paths in file-level failure names, there are no new failure names. The baseline-only PTY failure passed in the candidate run; this change does not claim to fix that unrelated test. No tests or CI were disabled.

After rebasing onto `9916dbe` (#222), build/type checks and all eight UI cases passed again. The combined targeted run had 171 passes and 56 failures: 55 existing lifecycle failures plus an intermittent Claude companion assertion about the next model request receiving the pending result. The card had already been persisted. The bridge has the same 250 ms post-result shutdown timer in `9981a52` and current main, so that assertion depends on timing. Focused candidate repeats passed twice and failed once; five isolated runs on each untouched main revision passed. A subsequent complete serial run of `cli-real-app-approvals.test.mts` passed all 49 cases, including the new #222 diagnostics and task reply tests. No assertion, timeout, admission event or transport code was changed to obtain the pass. All six new parity cases passed on the rebased code.
