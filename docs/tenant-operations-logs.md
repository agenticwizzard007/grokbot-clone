# Tenant meters, logs and health

MT-D adds an optional metadata ledger for the isolated platform. It does not enable billing or enforce a spending cap. Standalone authentication, sessions and usage remain unchanged, including when `TENANT_METERING=1` is accidentally present on a standalone server.

## Collection and trust

`TENANT_METERING` accepts unset, `0` or `1` and defaults off. Set `1` on the platform and provisioner only after the directory migration. New Fly hosts inherit it and pass it to the tenant application. Existing hosts need a reviewed image/configuration rollout. This flag is independent of `TENANT_USAGE_COLLECTION`, which collects trusted host capacity samples for sizing.

The directory stores `tenant_meter(tenant_id, day, metric, quantity, unit, cost_usd, source, updated_at)`. The primary key is `(tenant_id, day, metric, source)`. Days and months are UTC. Source is explicit in every export:

| Source | Metric | Unit | Meaning |
| --- | --- | --- | --- |
| provisioner | machine_running_seconds | seconds | Elapsed time in provider-observed started/running/stopping/suspending state |
| provisioner | storage_gb_days | GB-days | Observed volume size multiplied by elapsed UTC day fraction, including suspended and retained volumes |
| tenant | model_spend_usd | USD | Cumulative recorded AI cost from this tenant's usage report, including its estimates and priced audio |
| tenant | computer_minutes | minutes | Cumulative running computer time recorded by this tenant's existing SQLite VM meter |
| tenant | voice_minutes | minutes | Cumulative minute-denominated voice usage recorded by this tenant |

Infrastructure collection reads owned provider inventory and lifecycle create/wake/suspend observations. It does not ask the tenant for machine time or volume size. Per-resource cursors and daily increments commit under the tenant lock in one transaction. Identical or older observations do not add usage. Day boundaries split intervals; volume size changes apply from the next observation. Resources absent from verified complete inventory become destroyed observations. Revocation purges the ledger immediately and prevents late collection from recreating it.

The provisioner schedules one inventory attempt per second, reserving tenants due after 60 seconds in oldest-attempt order. Provider errors are recorded for health and retried later. A slow or large fleet can produce longer observation gaps. The first observation has no historical backfill. Gaps over five minutes and generation changes are omitted, not extrapolated. Therefore these observations are operational estimates, not complete provider invoices or qualification evidence. Provisioner restarts preserve cursors; durable polling reservations expire after 60 seconds. Unknown prices are `cost_usd=null`, never a fabricated zero-dollar invoice. Machine state in health is a last observation, not a live provider query.

The tenant sends its last 32 UTC days every minute as a bounded cumulative snapshot to `POST /internal/runtime/meter`. Empty days are included. Late changes within that window replace prior claims without double counting. The API accepts up to 32 distinct days within the last 62 days, an 8 KiB JSON body, a two-second body deadline, at most 32 concurrent requests and at most one accepted report per tenant per 15 seconds. It authenticates before reading the body and rechecks the signed runtime JWT, tenant, generation, machine and host run permit inside the revocation lock. Host JWTs cannot report these claims. A tenant cannot choose another tenant, a metric name or `source=provisioner`.

The report timestamp must be newer than that tenant's durable high-water mark and no older than 60 seconds. Equal or older timestamps are rejected, including across runtime token rotation and process restarts. The runtime sends a fresh snapshot after a lost response. A claim remains untrusted even after successful authentication: a compromised tenant can misreport its own numbers. Model spend includes existing `usage.ts` estimates, unknown prices contribute no known spend, subscription requests have no extra API charge, and unrecorded local desktop/audio time cannot be reconstructed. These limitations must not be represented as zero actual usage or proof of an invoice.

The provisioner prunes ledger days older than 400 days every minute. Report high-water marks live until account deletion so retention never reopens replay. Zero-quantity resource cursors expire after a day. `revokeTenant` deletes meters, allowances, resource cursors and meter/tunnel status transactionally. Export files and external log sinks have their own retention and deletion obligations.

## Operator CLI and soft allowances

Run these commands from a trusted operator environment with the restricted directory `DATABASE_URL` loaded from a protected file, not on the command line. No provider, KMS, Composio or customer credentials are needed. The CLI never calls a provider. It prints only the selected metadata, never connection strings, data keys, session tokens, email, display names, provider errors or job error text. Tenant IDs in private exports and health results are intentional operator identifiers; request logs use hashes only.

```sh
node --env-file=/secure/directory-runtime.env server/dist/platform/meter-cli.js export --month 2026-11 --format csv
node --env-file=/secure/directory-runtime.env server/dist/platform/meter-cli.js export --month 2026-11 --tenant usr_<immutable-id> --format json
node --env-file=/secure/directory-runtime.env server/dist/platform/meter-cli.js health --tenant usr_<immutable-id>
node --env-file=/secure/directory-runtime.env server/dist/platform/meter-cli.js allowance --tenant usr_<immutable-id> --usd 25.00
node --env-file=/secure/directory-runtime.env server/dist/platform/meter-cli.js allowance --tenant usr_<immutable-id> --usd none
```

Omitting `--tenant` exports all tenants in the requested month or all health rows. JSON is the default; both export and health support `--format csv`. Use `umask 077` before redirecting output to an operator file. CSV cells are quoted and spreadsheet formula prefixes are neutralized. `allowance` accepts positive USD amounts with at most two decimal places or `none`; it updates only `tenant_allowances`, not any runtime permission.

An allowance repeats monthly in UTC. No row means no allowance and preserves the UI's `No limit`. The authenticated runtime reads only its own current allowance through `GET /internal/runtime/meter/allowance`, with no tenant or month query parameter. The response includes known model spend claims, percentage, `softLimitExceeded`, source and last report time. Infrastructure quantities and unpriced computer/voice time do not count toward this USD percentage. Exceeding it does not block a model call, computer, login, session or tunnel. Other provider/account limits still apply.

When metering is enabled in a tenant, `/api/usage/summary` uses this response for the existing account usage meter, preserving the money-based display and adding `softLimit`, `source` and `reportedAt`. A platform outage returns an unavailable summary rather than presenting an unknown allowance as unlimited. Reports can lag by at least a minute and are claims, not enforceable billing. Standalone never enters this path.

Health reports tenant state, last authenticated tunnel admission, last accepted meter report, last provider machine state/observation, poll failure, failed lifecycle job count and attempts on currently failed jobs. A tunnel timestamp is connection history only: it does not assert a current tunnel is connected. Null means no observation, not healthy. A completed job is not a current failure. The CLI does not expose raw failure strings.

## Tenant log separation and filtering

On Fly each tenant already owns a separate application named `swarm-u-<first 32 hex characters of SHA-256(tenant ID)>`. Select that exact app in the operator log tooling. Platform, provisioner and Composio gateway logs belong to their separate service apps. Selecting one tenant app avoids mixing workload logs from other apps; this is log organization, not an authorization mechanism. Host/tenant application logs can still contain that tenant's private material and must stay restricted.

Platform and gateway HTTP request records now include `tenant_hash`, the full lowercase SHA-256 of the immutable tenant ID. Provisioner lifecycle, environment and meter work emits the same field. Directory session validation and runtime signature verification bind the hash, never a request header or caller-selected tenant field. Unauthenticated requests have `tenant_hash:null`. Request records contain only a fixed event, role, HTTP method, status and elapsed milliseconds. They omit URLs, queries, headers, request bodies, identities, provider payloads and error text. Worker records use fixed operation names and success state. Hashes are pseudonymous, stable operational identifiers, not secrets or authorization credentials. The private `health` CLI returns the hash for filtering:

```sh
jq 'select(.tenant_hash == "<full hash from health>")' < /secure/platform-requests.jsonl
```

The Docker tenant driver is a separate work package. Its per-tenant containers must be selected by the exact tenant ownership label documented by that driver, then by container ID in Docker log tooling. Verify the driver's label key/value from inspected metadata before filtering; a container name alone is insufficient. The current nested CLI/MCP workload policy uses `swarm.tenant` and `--log-driver=none`, so those workers have no Docker log history to retrieve. This work does not enable their logs, change labels, weaken container policy or claim the Docker driver is deployed. Do not copy raw ownership labels into the structured shared-service logs; correlate through the operator directory and `tenant_hash`.

Real Fly and Docker runtime observations, external log shipping/retention, alert delivery and billing reconciliation have not been qualified by local tests. Local PostgreSQL and fake-provider results are not release-gate evidence. Rollout prerequisites are in [owner steps](multitenant-owner-steps.md#mt-d-per-tenant-meter-ledger-logs-and-health).
