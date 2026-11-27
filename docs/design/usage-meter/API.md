# Plan usage summary

`GET /api/usage/summary` is authenticated, account-scoped, read-only, and served with `Cache-Control: no-store`. Query parameters cannot select another account. `planUsageSummary(userId, at?)` in `server/src/plan-usage.ts` is the server source of truth. It does not contact providers.

The payload follows the audit's `plan`, `ownKeys`, `week`, and `computedAt` contract. `uncategorized` adds historical costs whose key source cannot be proven. Amounts are USD integer cents: each event contributes `Math.round(cost_usd * 100)` before summation. Computer estimates are excluded.

- `plan.usedCents` includes only `native` events, including estimates. `plan.estimatedCents` identifies the estimated portion, and `plan.unpricedRequests` counts requests with no recorded price. No amount is invented for those requests.
- `ownKeys` has `usedCents`, `requests`, `estimatedCents`, `unpricedRequests`, and the exact label `On your own keys (does not count toward the plan)`.
- `uncategorized` has the same counters and label `Historical usage with unknown key source`. These costs enter neither plan nor own-key totals.
- `week` is the rolling seven calendar days including today in the account timezone. It has `start`, `end`, `planUsedCents`, `ownKeysUsedCents`, `uncategorizedCents`, and seven `days` with `day` and the three cent figures. The week may cross the plan month's start.
- `plan.periodStart` is the local calendar month's start. `plan.periodEnd` and `week.end` are exclusive calendar boundaries. Rows after `computedAt` are excluded; rows exactly at `computedAt` are included.
- Optional `SWARM_PLAN_LIMIT_USD` is a positive dollar allowance rounded to cents. Unset, invalid, nonpositive, and unsafe values produce `limitCents: null` and `percentUsed: null`. `SWARM_PLAN_NAME` overrides the display name. These settings provide no billing mutations and are never taken from OpenRouter key-wide limits.
- API `percentUsed` is the raw `usedCents / limitCents * 100`, potentially over 100. Import `displayUsagePercent` from `@shared/plan-usage-percent` for a finite display value in `[0, 100]`, or null. An unset allowance uses `unit: "usd"` with no percent.
- A selected CLI uses `billing: "plan"`, `unit: "percent"`, and `limitCents: null`; it never inherits the API dollar cap. A fresh cached CLI quota can supply `percentUsed` and `resetsAt`. The highest active window is used, with a 30 second observation lifetime. Without a trustworthy observation, percent and reset are null (unknown quota). Ledger dollars remain separate. A summary read never starts discovery.

Every new recorded event has `key_kind` of `native`, `personal`, or `subscription`. API clients capture the selected credential before the request, including streaming responses, so connection changes cannot reclassify completed costs. OpenRouter's `usage.is_byok` remains an independent routing attribute. Speech records the actual OpenRouter credential selection; shared platform voice stays native, and tenant private credentials are personal.

Migration is one-time and transactional. Subscription `cost_source` wins. Existing accounts with no retained personal OpenRouter connection become native; any retained connection, including disabled or disconnected credentials, makes API history unknown. Deleted/unattributed accounts are conservatively unknown. Missing attribution on direct SQL inserts defaults to unknown. Reopening the database cannot rewrite attributed history.

`{ type: "usage" }` is emitted to the account's existing SSE stream after a row is recorded, including charges completing after a run stops. USG-B should refetch on this event and on run idle. The meter, Models & access, and plan widgets should read the summary. For CLI unknown quota, do not interpret null as an unlimited subscription.

Dashboard `usage.summary.costUsd` and `usage.series` with `metric: "cost"` use the same `planUsageRange` aggregation as `summary.week`. `costUsd` means plan-counted USD, excluding own keys and computer estimates. Existing request/token counts and computer-hours fields keep their meanings. Existing `/api/usage` and CSV precision stay unchanged.

Reconciliation fixture: `tests/fixtures/usage-summary.json`. Run `node --import tsx --test tests/usage-summary.test.mts tests/usage.test.mts`; the new suite writes the authenticated mixed-usage response to `.context/usage-summary.fixture.json` for USG-B.

USG-B consumes this contract through the shared `PlanUsageSummary` type in `plan-usage-types.ts`. The sidebar and Models & access share one in-memory, account-scoped reader, invalidated by `usage`, run idle, connection changes, reconnect, and resume. A periodic visible-page read covers calendar boundaries and expiring CLI observations. Requests never consult provider billing for plan figures.

The dashboard `usage.windows` source now publishes the canonical plan as its single row (`label`, raw `usedPercent`, `resetsAt`) and exposes `value.plan` and `value.ownKeys` from the same summary helper. `available` means the summary is available, including a no-limit API plan or unknown CLI quota. Meter widgets render these values with `displayUsagePercent`; saved window indices no longer select a different accounting basis. `usage.summary` and `usage.series` keep their existing field names and cent-based plan accounting.
