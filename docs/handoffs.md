# Handoffs, loops and agent Flow

A handoff sends a finished result to another Bot in your account. It carries an instruction, a summary and references to the result's parts. It does not copy your chat history or give the receiving Bot new permissions.

## Send work to an agent

1. On a finished reply or done task, choose **Send to agent**. An assistant message also has this action in its menu.
2. Choose a Bot and write what you want it to do.
3. Choose **Send**. The receipt opens the handoff's status, inputs, result and events.

**Send result back to me** is on by default. The receiver gets a task and a receipt in its chat. Rooms and Bots still in setup cannot receive a handoff. A room's picker offers its members first.

Open an output to inspect its summary, parts and provenance. Text and JSON are read in pages. Files stay in the artifact store; the receiver can request a bounded copy of an included file. A reference is an address, not permission to read it.

## Improve a result in a loop

Use **Keep improving** in the Send sheet, or open **Loops** from the sidebar menu and choose **New loop**. Pick different Maker and Checker Bots, enter a goal, select an exit rule and set the pass limit. A checklist is useful when completion can be described as concrete checks.

The Maker drafts and the Checker reviews. A failed review sends the draft and feedback into another pass. The controller stops when checks pass, a limit is reached, progress stalls, a step fails, or you choose **Stop**. **Pause** lets the current step finish without dispatching the next one. **Resume** continues it.

Defaults are four passes and thirty minutes. The absolute pass limit is ten. Three loops may be active per account and twenty may be created per day. Cost and token caps apply when the runtime reports usage. An untracked cost is shown as untracked, never as free.

An agent-started loop waits for human approval before its first pass unless you enabled automatic approval for that exact Bot pair. A gate expires after twenty-four hours. Gate tasks appear in Tasks. At an eligible iteration cap, **Continue 2 more passes** extends the loop once, without exceeding ten passes.

The final result is explicit:

- `Done in 3 passes: all checks passed.`
- `Stopped after 3 passes (limit). 2 of 3 checks still fail.`

**Use this** opens the best output. Equal scores favor the latest pass. A stopped or capped loop does not imply that its checks passed.

## Follow the work

The Timeline shows passes, runs, inputs and verdicts. Graph shows the same sequence as a deterministic graph, with a vertical arrangement on phones. **Copy details** exports identifiers and event types for support, without output bodies.

A Bot's **Flow** tab shows Triggers, Inputs, Steps, Outputs and Handoffs. Select a node to open its related setting; Back returns to the node. Flow reads stored configuration and does not need a model request. Suggested connections stay suggestions until you connect them.

Use the Flow link editor to offer future handoffs or send them automatically. Automatic links cannot form a cycle. Templates support `{title}` and `{summary}`. Settings Agents exposes account policy when that integration is available. A missing Settings entry does not grant any extra permission.

## UI quality

Every new screen must follow [Paper BUILD-SPEC sections 0b, 0c and 0d](design/paper/BUILD-SPEC.md). Passing route geometry alone is insufficient.

- Use Page, Section, Card, Row and ButtonGroup. Keep centered columns, equal side padding, aligned labels and equal card widths.
- Use readable text of at least 13px in handoff and Flow surfaces. Avoid faint, cramped timeline metadata. Use tokens for both light and dark modes.
- Rows and controls have a minimum 44px hit area. Spacing follows 8px steps, with 4px only inside a control. Cards use 16px padding, 16px between cards and 24px between sections.
- Grouped buttons have equal widths or stack at full width. Keep actions aligned with their row; do not leave View floating between rows. Loop navigation is a deliberate control, not a raw underlined link.
- Labels wrap without truncation. Do not repeat an output's title as its summary. Use one short heading and at most one short helper line. Put extra explanation behind details or an info control.
- Phone screens have one Back control. Escape closes a sheet and returns focus. Keyboard order follows reading order. Status has a text label and appropriate live announcements.
- Finished messages have no leftover typing indicator. No visible `mock:` directives, harness markers, `undefined`, internal identifiers or secrets. No em or en dashes in UI copy.
- Inspect receipt, running and finished Timeline, Graph, Flow and capped result at 320, 390, 500 and 1280 in both light and dark modes. Record main-region word counts and review copy against section 0b.
- Run `node tests/handoffs/ui-quality.mjs` when supplied by HO-P. The HO-H demo and e2e call it automatically when present, otherwise print a clear skip. A skip means that visual acceptance is still pending.

The demo saves a quality record beside each screenshot. Automated checks do not replace inspecting screenshots for hierarchy, spacing, duplicate copy and action placement.

## Developer map

Contracts and pure transitions live in `server/src/handoffs/`. Persistence, reference authorization, loop execution and recovery build on coordination requests and normal agent jobs. Routes are mounted by `routes-handoffs.ts`; tools are in `agent/handoff-tools.ts`. The web consumes these contracts from `@shared/handoffs`.

A finalized output is immutable. Declare structured output while a run is active, then let the job-finish hook finalize it. Every tool call needs the run's user ID, Bot ID, job ID and stable tool call ID supplied by the runtime. Never accept authority from model arguments.

### Add a part kind

1. Extend the output part union, schemas, limits and deterministic content hashing in the handoff contracts and output modules. Add storage only where the new part requires it; keep list responses as manifests.
2. Implement creation, redaction, authorization and bounded reads in `outputs.ts`. File-like parts must use owned artifacts and receiver-scoped grants. Do not fetch link content automatically.
3. Extend packet manifest descriptions and reference reads. Keep the 6000-character inline budget and 8500-character overall packet cap. Put untrusted content inside nonce-delimited blocks.
4. Add the part's renderer and open action to OutputViewer. Use existing layout primitives and accessible names. Extend extraction, round-trip, pagination, grant, injection and rendering tests, including large and missing parts.

### Add an exit rule

1. Extend `ExitRule`, strict schemas and agent tool schemas. Define how a result is evaluated and how the UI explains it.
2. Add the pure transition to `loop-machine.ts` and any verdict validation to `verdict.ts`. Preserve terminal absorption, iteration limits, stall checks and deterministic best-output selection.
3. Connect the runner and persistence. The server decides completion; it must not infer a structured verdict from prose. Never add a tool that approves a human gate.
4. Add sheet fields, timeline and result text. Test convergence, cap, missing verdict, budgets, replay, recovery, gate decisions and Stop with the scripted local provider.

### Add a Flow node kind

1. Extend `FlowNode`, its lane, deterministic ordering and stable ID in `flow/model-types.ts` and `flow/build.ts`. Include every new input in the cache hash.
2. Use a stored input reader in `flow/cache.ts`. Building Flow must not call a provider or a model. Keep the model below 12KB and the lane node limit intact.
3. Define a destination and focus target. Add the readable kind label and existing icon or logo in FlowChart. Restore focus when the user returns.
4. Extend golden fixtures, hash invalidation, shuffled-input determinism, keyboard, route, accessibility, layout and performance tests. Cover rich, empty and suggested-only Bots.

## Local quality gate

Install the existing lockfile with `npm ci`; do not add test dependencies. Chrome is selected with `CHROME_PATH`, defaulting to `/usr/bin/google-chrome`.

```sh
npm run typecheck
npm run build -w web
node tests/handoffs/run-quality.mjs
node scripts/handoffs-demo.mjs
```

The quality runner executes all handoff and flow test files, their component tests, the twelve real-app journeys, security, performance, the demo, layout alignment and navigation. It also runs Composio, readiness, coordination and agent suites. It saves command logs, exit codes and reported pass counts under `.context/handoffs/quality-h/`. Navigation uses `--import tsx` because it imports TypeScript and TSX. `node tests/navigation-every-route-ui.mjs` alone is not supported by Node's type stripping on this baseline.

The seeded harness reuses `tests/fixtures/layout.seed.mts` and the isolation pattern from `tests/layout-fixture.mjs`: temporary SQLite and file directories, placeholder credentials, local provider and blocked external browser requests. `tests/handoffs/mock-proxy.mjs` translates realistic fixture prompts into scripts for the unchanged `tests/mock-provider.mjs`. `mock-iter` selects a script from the packet's iteration number. The gullible persona intentionally follows an exposed attack marker; its positive control proves that nonce boundaries contain that marker. This tests parser boundaries and authorization, not a claim that language models cannot be manipulated.

Security cases live in `tests/handoffs/security/`. Performance results are measured into `tests/handoffs/perf/baseline.json`. Browser measurements use real API responses and SSE, with one development-module warmup excluded. The performance rendering seed contains four passes and twelve completed steps; it is separate from the demo's live loops.

The demo creates a real handoff and two real two-agent loops through the UI. Both use Maker and Checker. One succeeds on pass three; one fails two checks at its three-pass cap. It checks exact result sentences, six unique jobs, three verdicts and event ordering. It saves screenshots, provider requests and `report.json` under `.context/handoffs/demo-h/`. Failures are retained and cause a nonzero exit; no state is fabricated to make a failed live loop appear successful.

## Run the same demo on a deployed test instance

The deployed test account must already contain active test Bots named Maker and Checker. Configure that isolated instance to use the scripted handoff mock proxy and existing mock provider. Never point this test at a real model provider. Use the account's existing session token from the environment; do not put it in a file, command history, report or PR.

Set these environment variables through the session's secret environment facility:

| Variable | Value |
|---|---|
| `BASE_URL` | Deployed test instance URL |
| `HANDOFFS_TEST_SESSION` | Test account session cookie value |
| `HANDOFFS_TEST_USER_ID` | Expected test account ID |
| `HANDOFFS_TEST_MAKER` | Maker test Bot ID |
| `HANDOFFS_TEST_CHECKER` | Checker test Bot ID |
| `HANDOFFS_TEST_PROVIDER` | `scripted`, confirming the isolated mock configuration |
| `HANDOFFS_EVIDENCE` | Optional local output directory |

Run `node scripts/handoffs-demo.mjs`. It verifies the session identity and Bot names, then uses the same UI journey. It creates only test messages, outputs, handoffs and loops. It does not change existing Bot configuration, account policy, provider settings, or delete records. It leaves the test records for inspection. The environment acknowledgement is an operator prerequisite, not remote proof of provider routing; verify the isolated deployment configuration before running.
