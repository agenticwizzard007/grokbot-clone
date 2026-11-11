# Interaction latency and connected-app progress

The reported Notion interaction has two separate problems: useful execution activity is hidden, and a workflow can accumulate multiple slow model and provider round trips. The screenshots show a Claude Max **subscription**, **Opus** selected with **Max reasoning effort**, elapsed times progressing from 2m 28.5s to 3m 21.9s and finally **9m 8.2s with 20 steps**, repeated generic app labels, and an earlier CLI empty-response error. The subscription tier and reasoning effort are different settings.

The code findings below are confirmed in this checkout. The screenshots do not establish the deployed commit or provide per-stage timings. No live Notion writes, production setting changes, or paid model benchmarks were performed. The exact production time split remains unmeasured.

## Implemented progress fixes

- Running operations remain visible when completed steps are collapsed. Pending batch operations say **Queued**, and only the dispatched operation says **Running**.
- App operations use their actual tool identifiers to produce labels such as **Notion: Fetch database**, **Notion: Create page**, **Finding Notion actions**, and **Checking app connections**. Historical rows with saved arguments also get specific labels.
- Each operation records start/completion timestamps. Active operations show elapsed time, and completed operations show their duration. Approval and error states remain distinct.
- Model preparation and model waits say **Preparing model context** and **Waiting for Claude/Codex/model response**, replacing rotating thinking phrases. The overall activity timer remains the turn's elapsed time.
- Labels and approval-card app names no longer wait for a remote toolkit catalog. App names come from local identifiers; approval cards no longer depend on retrieving a provider logo.
- Remaining queued/running rows are settled when a turn exits without a pending approval.

These updates use execution events and client timers; they add no model inference. They describe actual dispatched operations. They do not invent internal progress within a single opaque provider request or expose raw tool arguments. They also do not stream the CLI's reasoning or accelerate its inference.

Implementation: [tool labels](../server/src/tool-activity.ts), [agent loop](../server/src/agent/loop.ts), [transcript](../web/src/components/Transcript.tsx), [activity phrases](../web/src/lib/phrases.ts).

## Implemented latency reductions

- Generation reuses account/runtime-scoped model capabilities for five minutes, instead of refreshing them every 30 seconds. The picker/usage path retains its shorter freshness requirement and explicit forced refresh. Every generation still checks subscription authentication in the runner, and credential changes invalidate cached capabilities.
- Concurrent CLI catalog requests share one RPC. Cancelling a caller leaves other callers running; cancelling the last caller cancels the underlying request. Late responses after credential/runtime changes cannot populate the cache. Bridge disconnects and replacements also invalidate capabilities.
- Tenant account listing obtains one fresh provider snapshot across the required pages, then reconciles local ownership, revision, toolkit, and revocation state. It no longer repeats the provider listing for every registered connection. Actual tool execution still performs independent fresh authorization.
- Tenant prompt context now shares the existing 30-second app-name cache, with tenant checks before cache access and invalidation on local connection changes. Explicit connection checks and execution do not use that prompt cache.
- The operating instructions now constrain capability questions to relevant checks, encourage reuse of valid discovered IDs/schemas, request independent reads together, and direct draft workflows to use the necessary schema/sample rather than auditing every record.

These changes remove measured or directly observable orchestration overhead. They do not change the selected model or effort. The instruction change needs a live task evaluation to quantify its effect on operation count.

## Confirmed sources of delay and missing visibility at investigation start

| Finding | Evidence | Effect |
| --- | --- | --- |
| Subscription streaming is buffered | `cliResponsesClient()` awaits the complete `cliRequest()` before returning an async event iterator. `execute()` collects stdout/stderr until process close. Text-only Claude uses `--output-format json`; image requests use stream-json but still collect the complete output. | The user cannot see model text while it is being generated. All apparent stream events arrive after completion. |
| Each tool round starts fresh CLI work | `runTurn()` calls the model again after a tool batch. `runGeneration()` creates a temporary working directory, starts an auth-status process, then starts a generation process. Sessions are ephemeral / not persisted. | Startup, auth checks, input processing, and reasoning recur across a workflow. Removing UI delays alone does not remove these costs. |
| The selected Max effort applies to every round | `callModel()` sends `bot.effort` on each call; the Claude runner forwards it through `--effort`. | Simple connection checks and tool selection use the same reasoning setting as complex scoring design. Max is a plausible substantial contributor, but its production duration is not measured here. |
| CLI catalog discovery recurred during long tasks | Previously capabilities expired after 30 seconds without in-flight sharing. `readCatalog()` starts an auth probe and control process, queries models, and requests usage with a five-second subtimeout. The catalog operation has a 20-second deadline. | Repeated metadata work is reduced by the five-minute capability cache and shared RPC. Cold loads still include catalog/startup/usage overhead. Deadlines are upper bounds, not measured typical delays. |
| App context is fetched before model requests | `systemPrompt()` awaits `connectedToolkits(userId, true)` on each model round. Previously its 30-second cache applied only outside tenant mode. | Even a general capability reply can wait for Composio before model inference begins. The cache now also covers tenant prompt context; cold loads remain on the critical path. |
| Tenant connection listing performed sequential repeated ownership lookups | Previously `ConnectionGateway.list()` awaited `own()` for each account; `ComposioProvider.owned()` listed private provider accounts for each lookup. | With N registered accounts, listing could make N separate sequential provider-list operations. Replaced with a single paginated snapshot plus registry checks. This optimization is specific to the tenant gateway path; standalone listing has different behavior. |
| Cosmetic labels used the full app catalog | Before this change, `processCalls()` called `toolkitInfo()` before execution and before publishing approval cards. `toolkitInfo()` calls `catalog()`. Tenant `catalog()` exhausts pages without a local cache; standalone caches for an hour. | An operation could wait for an unrelated catalog download just to show an app name. That time preceded the tool timer. **Removed from these paths in this change.** |
| Tool discovery and execution add serial provider requests | Standalone discovery checks accounts, loads toolkit metadata, and rechecks accounts. Standalone execution checks accounts, fetches tool metadata, rechecks accounts, then executes. Tenant execution performs ownership, tool/version checks, dispatch authorization, then execution. | One visible tool call represents multiple network operations. Preserve ownership, revocation, version, and approval guarantees when optimizing. |
| Discovery and history increase input size | Discovery requests up to 5,000 toolkit definitions and caches them for five minutes, then returns up to 20 full schemas. Tool outputs retain up to 60,000 characters. `prepareCliRequest()` serializes all available tool schemas and conversation data into the prompt on every call. | Broad discovery and accumulated tool outputs increase input processing and model selection work. Full transcript replay does not prove provider prompt-cache misses, but there is no persistent application-side CLI conversation. |
| Tool batches are serial | `processCalls()` awaits each operation in order. The normal app adapter exposes single-operation search/execute tools. | Independent reads cannot overlap within a returned batch. Writes and dependent browser actions require ordering, so indiscriminate parallelization would be incorrect. |
| Compaction can block a response | `maybeCompact()` is awaited in model preparation. Large histories can trigger an additional model summary. Its `lowEffort()` override currently applies only to direct-provider requests. | Long conversations can incur a hidden model request before the requested response; subscription summaries use provider defaults rather than an explicit low effort. |
| API-mode work has an additional account queue | Non-subscription jobs wait on `userQueues`, serializing work across bots for the account. Subscription work bypasses this account queue but retains per-bot ordering. | This can explain delays elsewhere on the platform, but it is not the subscription-specific explanation for the screenshots. |

Sources: [CLI adapter](../server/src/cli/responses.ts), [CLI runner](../companion/cli-bridge.mjs), [CLI catalog](../server/src/cli/catalog.ts), [prompt](../server/src/agent/prompt.ts), [Composio adapter](../server/src/composio.ts), [gateway policy](../server/src/platform/composio-policy.ts), [provider](../server/src/platform/composio-service.ts), [gateway routes](../server/src/platform/composio-gateway.ts), [memory](../server/src/agent/memory.ts).

Normal connected-app chat in this checkout uses `SWARM_APPS_SEARCH` / `SWARM_APPS_EXECUTE`, not Composio Tool Router planning on every turn. The presence of `sessionFor()` does not imply that it runs for every ordinary app action; it serves the connection authorization flow. The evidence does not justify blaming Composio's planning model for the delay.

## The CLI error in the screenshots

`The CLI returned neither a reply nor an action` originates in the adapter when a successfully parsed response contains `text: ""` and `tool_calls: []`. It is not a Notion authentication error. The screenshot shows it after a user-facing answer and a **Saving notes / Saved a memory** step, which is consistent with a model ending silently after bookkeeping. The actual CLI payload is unavailable, so that sequence is suggestive rather than proof of intent.

The prompt permits an empty tool array on completion but the adapter rejects an entirely empty completion. A follow-up fix should distinguish a valid end after an already delivered answer/bookkeeping from an empty initial response or an unresolved app failure. Do not fix this by silently accepting every empty response or automatically replaying app writes. This behavior remains unchanged in this patch.

## Follow-up: Claude reports `No such tool available: SWARM_APPS_SEARCH`

The later GitHub screenshot shows a different failure on Sonnet Low: the account lookup succeeds, then the assistant claims app discovery is unavailable and suggests activating the agent. Both app wrappers are already permitted during setup; execution remains restricted to provider-verified reads. Activation is not required to verify an existing connection.

The exact missing-tool message occurs in the installed Claude CLI, not Swarm's dispatcher. Swarm supplies its action definitions as prompt data and expects a JSON action envelope, while native CLI tools are disabled. A native `tool_use` attempt can therefore fail inside the CLI before Swarm sees it. This is the leading diagnosis supported by the source and screenshot; no production CLI event trace was available to prove the exact sequence.

The follow-up repair:

- Gives Claude a system prompt defining its role as Swarm's stateless reasoning engine and makes the current action manifest authoritative over stale assistant claims.
- Restricts action names in the output schema to the current function tools, with zero actions allowed when no tools exist. Custom structured-output schemas remain unchanged and receive no action manifest.
- Reads Claude's NDJSON events for text and image requests. If a complete assistant event contains only known app tool calls with complete object arguments, hands those requests back to Swarm and terminates the CLI process group before another internal error/reasoning cycle. Non-action narration in that event is discarded because execution has not happened yet.
- Requires names to match both explicit request metadata and the output schema. Unknown names, mixed known/unknown batches, partial events, error events and malformed arguments are never captured as app actions. Cancellation, size limits, subscription authentication, disabled native tools and process cleanup remain enforced.
- Routes captured requests through the existing server validation, ownership checks, setup read restrictions and approval loop. The repair does not execute tools inside Claude or replay previous writes.

Validation: 131 focused tests passed across CLI runner/subscription/catalog/concurrency/hosted/supervisor suites and app read-only/connection suites. The process reproducer returns the requested search action before the fake CLI's missing-tool loop; tests cover split Unicode/JSON, malformed and unknown calls, oversized arguments, cancellation and descendant cleanup. A real WebSocket/Responses/agent-loop test using fixture CLI and provider implementations completes GitHub discovery and one read while setup remains in review. A captured write pauses for approval with zero provider executions. Typechecking and the production build passed.

Deploy the server and the runner containing `companion/cli-bridge.mjs` together. Hosted tenant workers need the updated runner image; a personal computer bridge needs the updated script and a restart. Then retry the connection verification in the existing conversation. This action handoff is not token-by-token user-text streaming, and the tests do not establish production latency or live GitHub access.

## Controlled measurements

These are deterministic local probes, not production latency estimates:

| Probe | Result |
| --- | --- |
| Hold a fake subscription response for 300 ms | No stream was available during the hold. It became available at about 310 ms; all four response events arrived within 0.03 ms. This confirms buffering, not model speed. |
| Four tenant account checks, each with an artificial 50 ms provider delay | Original fallback: four sequential provider lookups, about 202 ms. Bulk path: one lookup, about 50 ms. Approximately 75% less time **for this controlled listing component**, not for a full production task. |
| Serialize available built-in tools in the local probe | 33 tools and 14,036 prompt bytes before system prompt/history/app schemas. Tool count depends on configured computer capabilities and bot role. |

The probe and raw output are in `.context/latency-analysis/probe.mts` and `probe.json`. The output includes a server startup log before the JSON report. These workspace artifacts are gitignored.

## Recommended next changes

1. **Instrument one representative production turn.** Enable existing `SWARM_LOG_LATENCY=1` logging, then correlate a request from queue admission to the final reply. Add job/round/call IDs and separate spans for CLI auth, startup, catalog/usage, model first event, inference completion, connection listing, schema discovery, and actual app execution. Log durations and identifiers, without prompts, credentials, or app contents. Existing `model_first_text` on subscription mode measures delivery of the buffered result, not provider time to first token; failed model requests also lack `model_complete`.
2. **Support incremental subscription progress end to end.** Parse supported CLI stream events while the process runs; propagate safe progress/text through the runner, bridge, server events, and UI. Keep final tool-name/schema validation and approval enforcement before dispatch. Do not expose raw CLI stdout, reasoning, or incomplete JSON as user-facing text. The companion bridge and tenant runner both need protocol support; changing a CLI flag alone is insufficient.
3. **Offer an interactive effort setting.** Benchmark the same prompts at Medium versus Max on the user's selected subscription, and compare a faster model available in that account if desired. Routine connection checks should not require maximum reasoning. Keep explicit user model/effort choices intact; any automatic routing needs a visible product setting rather than silently switching providers or billing modes. OpenRouter's existing Fast option does not accelerate the Claude CLI path.
4. **Remove remaining setup work.** Capability caching and concurrent catalog sharing are implemented. Split the cold capability request from usage polling so an unavailable quota endpoint does not delay generation. Investigate isolated reusable per-account runner sessions, while preserving credential isolation, cancellation, configuration controls, and authentication freshness. Avoid simply removing auth checks.
5. **Reduce remaining Composio round trips.** Bulk account listing and tenant prompt caching are implemented. Next, reuse discovered versioned schemas/resource IDs, return a small set of relevant candidates, and retrieve full schemas when needed. Validate permissions/revisions immediately before dispatch. Avoid caching authorization decisions as if they were metadata.
6. **Overlap independent work where safe.** Add bounded concurrency for verified independent reads. Preserve ordered writes, approvals, browser-dependent actions, cancellation, and uncertain-outcome handling. Measure the non-subscription per-account queue separately before replacing it with bounded admission.
7. **Bound work and preserve diagnostics.** Record timeout/retry outcomes per stage and propagate cancellation through Composio operations. The chat model timeout is six minutes per round; gateway requests can wait 65 seconds. These limits permit long opaque stalls but do not prove they occurred here. Preserve an uncertain-write state instead of replaying a timed-out write.

Proposed acceptance criteria: show a real request phase within one second of admission, show tool start/end updates within 250 ms of the corresponding server event, keep active calls visible on desktop and mobile, and measure p50/p95 first-visible-progress, first-answer, and total completion time separately. Use a small corpus: capability question, connection check, one Notion read, and approved Notion write workflow. Establish production baselines before promising a completion-time percentage improvement.

## Validation

- Baseline: 66 existing tests passed across latency, CLI subscription/runner, and app discovery.
- After changes: typechecking and production build passed.
- 144 focused tests passed across latency, CLI subscription/catalog/concurrency, app connections/read-only checks, gateway isolation, Composio, and voice controls. New tests verify running/queued labels and timing, no catalog request for display, unchanged write approvals, shared discovery cancellation, capability expiry/invalidation, paginated bulk account lookup, and revocation during lookup. The tenant cache test was additionally rerun after extending it to verify scope, in-flight sharing, explicit fresh reads, and invalidation.
- After adding bridge reconnect invalidation, all 50 subscription/concurrency/hosted-concurrency checks passed, including the new reconnect regression. Typechecking and the production build passed again.
- Browser checks passed at 1440, 390, and 320 pixels: active steps remain visible when collapsed, historical generic labels upgrade, per-tool timers advance, queued/approval/completed states are distinct, model wait is explicit, raw arguments are not rendered, and layout fits in light/dark themes.
- Reproduce: `npm run typecheck`, `npm run build`, `node --import tsx --test --test-concurrency=1 tests/latency.test.mts tests/cli-subscription.test.mts tests/cli-catalog.test.mts tests/cli-concurrency.test.mts tests/app-connections.test.mts tests/app-readonly.test.mts tests/gateway-isolation.test.mts tests/composio.test.mts tests/voice-controls.test.mts`, and `node tests/tool-progress-ui.mjs`.

The patch is local to this workspace and has not been deployed. It fixes progress visibility and reduces recurring discovery/connection overhead; it does not establish that the nine-minute production workflow is resolved. True CLI streaming, fresh-process overhead, and model reasoning time remain the next major targets.
