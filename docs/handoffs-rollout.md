# Handoff rollout and recovery

Do not enable rollout until the real UI demo, twelve journeys, visual quality gate, security corpus and required regression suites pass. Compare the same commands on main and the candidate. A passing headless loop does not prove that the agent runtime supplies the context needed by `submit_verdict`.

## Flag and policy

The per-account setting is stored in `handoff_user_settings` and exposed at authenticated `GET /api/handoff-settings` and `PUT /api/handoff-settings`. Its public shape is:

```json
{"enabled":true,"agentHandoffs":"team"}
```

Policy values are `team`, `links_only` and `off`. `off` restricts agent-initiated handoffs; `enabled:false` disables the feature for the account. Settings Agents presents these controls after HO-I stage 2 is installed. The API can restore an account's disabled flag, unless the environment kill switch is active.

The current implementation defaults to enabled and team policy when no row exists. A test-account-only rollout therefore requires explicitly disabling other accounts through the owning operational process before exposure. Do not assume an absent row is disabled. The quality suite never changes real account settings.

## Kill switch

`HANDOFFS_DISABLED=1` makes handoff and Flow routes return 503, suppresses handoff tools and prevents the loop driver from dispatching new steps. Apply it through the normal deployment configuration process. Do not resize machines. There is no administrative stop-all route.

Disabling is not a guarantee that a job already admitted to the normal agent runtime has been interrupted. When individual controls are available, Stop the affected loops and cancel handoffs first. For an urgent incident, enable the kill switch promptly and inspect already admitted jobs separately through existing job controls. Retain IDs and event sequences for diagnosis.

To restore service, clear the environment switch, confirm the account setting, inspect queued work and active leases, and run the seeded demo again before widening access. Recovery reconciles persisted requests and jobs. It does not need manual duplicate dispatches or edits to verdicts.

## Rollout stages

1. Test accounts only: verify the deployed revision and configuration. Run the four-width demo using the scripted provider and a test account. Inspect receipt, running and finished Timeline, Graph, Flow and capped result in light and dark. All screenshots must meet BUILD-SPEC 0b, 0c and 0d.
2. Initial accounts: enable the account flag only after local main-versus-candidate checks have no new failures and the real runtime demo converges. Keep automatic links and pair auto-approval opt-in.
3. Broader use: expand only after reviewing event errors, cap and stall rates, latency and support reports. Keep the kill switch ready. Do not claim rollout complete while required suites or visual inspection are pending.

## What to watch

| Signal | Expected behavior | Investigate when |
|---|---|---|
| Handoff events | Created, admitted, running and terminal transitions with IDs | Repeated dispatch, orphaned requests, or a missing result |
| Loop events | A bounded sequence of steps, verdicts and one terminal transition | More than the cap, duplicate steps, or work after Stop |
| `no_verdict` | One nudge, then a clear failure | Structured tool calls are refused, especially missing job or tool call context |
| Corrected verdicts | Server recomputes required checklist checks | A checker claims success while required checks fail |
| Gates | Human approval before agent work, expiry after 24 hours | Work begins before approval or a gate cannot be declined |
| Budget and usage | Stop after the step that crosses a measured cap | New steps start after exhaustion or untracked usage is displayed as zero |
| Concurrency | At most three active loops per account | Deferred work never resumes or unrelated work is interrupted |
| Flow cache | Configuration changes invalidate the hash | Stale nodes, wrong destinations or lost return focus |
| UI | Readable rows, equal buttons, one Back, no stale typing indicator | Tiny text, duplicated copy, raw links, harness strings or clipped labels |
| Performance | Output <20ms, handoff POST p95 <80ms, warm Flow <15ms, cold Flow <150ms | Stored baseline budgets fail under comparable conditions |
| Browser performance | 12-step Timeline <300ms, SSE update <100ms, Flow paint <50ms | Repeated slow updates or duplicate subscriptions |

Metrics are collected by `server/src/handoffs/metrics.ts`; inspect the available diagnostics surface and structured event logs. Event payloads should contain IDs, counts, hashes and statuses, not output bodies, credentials or private file contents. Use **Copy details** on a run or handoff for a support record.

## Investigation checklist

1. Record the deployed revision, account scope, loop or handoff ID, status, stop reason and latest event sequence.
2. Compare controller steps with coordination request IDs and job outcomes. Each loop step has an idempotent dispatch key. Check leases before considering recovery.
3. Confirm the receiver is an active Bot in the same account. Check selected file grants and reference ownership; a uniform 404 is expected for inaccessible IDs.
4. Reproduce with test data in the seeded harness. Preserve the JSON report, server log and screenshots. File changes with the component's owner instead of editing another workstream's files.
5. After the fix merges, repeat the failing command, full required regression set, real demo and visual inspection. Compare pass and fail counts with main. Do not suppress failures, bypass hooks or merge a quality-gate PR before review.
