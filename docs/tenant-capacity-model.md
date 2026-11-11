# Tenant capacity, cost and scaling model

Numbers come from the code as of main 8aa04a7 and Fly's prices effective 2026-10-01 (RAM $6.00/GB/month,
shared-cpu-2x preset $4.39/month, performance-2x $66/month, volumes $0.15/GB/month, stopped machine rootfs
$0.15/GB/month, Managed Postgres Basic $38 / Launch $282 per month, storage $0.28/GB/month). Recheck prices before
committing budget; every figure below is reproducible from the formulas.

## 1. Per-tenant footprint as coded
| Component | Setting | Source |
|---|---|---|
| Tenant machine | shared CPU, 2 vCPU, 4096 MB, one 10 GB encrypted volume, own Fly app and private network | `platform/fly-tenants.ts` |
| App container | 1536 MB, 2 CPU, 512 pids, read-only root, 256 MB tmpfs | `runtime/host.ts` |
| Desktop container | 1536 MB (same policy) | `runtime/host.ts` |
| Runner / MCP containers | 768 MB, 1 CPU, 128 pids each; several may run at once | `runtime/container-policy.ts` |

**Known problem:** the nominal container ceilings exceed the machine. App 1536 + desktop 1536 = 3072 MB, plus
dockerd and the host process, plus 768 MB for every concurrent runner or MCP container, inside a 4096 MB machine.
Either the machine must be larger (performance-2x 4 GB has the same RAM; 8 GB is $6/GB more) or the container
ceilings must be budgeted against the machine. PR #21's operator resize path is the lever; the policy (decision 6 in
`tenant-infrastructure-decisions.md`) must set the ceilings.

## 2. Cost formulas
- Running tenant per month = preset $4.39 + (4096 − 512 MB included) ≈ 3.5 GB × $6 = **$25.39**, + volume 10 GB × $0.15 = **$1.50**.
- Stopped tenant per month = rootfs ≈ 1–2 GB × $0.15 ≈ **$0.15–0.30** + volume **$1.50**.
- Platform services: 2 × performance-2x platform ($132) + provisioner shared-cpu-2x 1 GB (≈ $7.40) + gateway (≈ $7.40) = **≈ $147/month**; Postgres Launch **$282** + storage; backups: Tigris/S3 cents per GB.

| Active tenants (all running) | Tenant compute | Volumes | Platform + Postgres | Total / month |
|---|---|---|---|---|
| 25 | $635 | $38 | $429 (Basic $38) | ≈ $1,100 |
| 100 | $2,539 | $150 | $429 | ≈ $3,120 |
| 250 | $6,348 | $375 | $429 | ≈ $7,150 |
| 500 | $12,695 | $750 | $429 | ≈ $13,870 |
| 1,000 | $25,390 | $1,500 | $429 (Launch) | ≈ $27,300 |
| 1,250 burst (while running) | $31,738 | $1,875 | $429 | ≈ $34,000 |

The owner's target is 1,000 *simultaneously active* users, so the all-running column is the budget case. With idle
suspension (`SWARM_IDLE_SUSPEND_MIN` style policy in the lifecycle worker) the compute line scales with active hours.
Model/API spend, Composio, Inkbox and egress ($0.02/GB) are additional.

## 3. Fly limits versus the provisioning and wake patterns
- Personal organizations start with a soft cap of roughly 20–50 running machines and a per-plan cap on apps; the fleet
  needs about 1,250 apps, custom networks, volumes and machines. Request the increase from Fly before any ramp.
- Machines API: about 1 request/second per action per machine or app (short bursts to 3; `GET machine` 5/s). A tenant
  create issues an app create, a network read-back, a volume create, a machine create and a start; wakes are one
  start per tenant app, so 1,000 wakes across 1,000 apps are not rate-bound by a single app, but each tenant's own
  operations are serialized by the lifecycle lease and the per-app limit. `platform/lifecycle-worker.ts` already
  journals creation intents and reconciles lost responses instead of blind retries; `PROVISIONER_CONCURRENCY`
  bounds concurrent creates.

## 4. Scaling with usage (PR #21 design, operator path)
- Resize = fenced same-volume compute replacement with preserved guest sizing across later image updates and
  restores; volume growth = durable absolute extend journaled before the Fly call, with unknown-outcome
  reconciliation; one lifecycle operation per tenant at a time; plan/queue is operator-only until the trusted
  production collector and unattended scheduler exist.
- Signals to drive it later: `usage-vm` metering, backup health and size, hung-tick metrics from the operations
  exporter, host memory pressure reported through the runtime refresh.
- Before enabling: the `tenant-capacity-resize` gate must record actual Fly resize, volume extend and guest
  filesystem growth behaviour for the exact signed host image in staging; interruption and notification policy and
  spend ceilings must be approved.

## 5. Acceptance targets mapped to measurement points
| Target | Where to measure |
|---|---|
| Control API p95 < 500 ms | platform HTTP relay timings (platform `server.ts`), excluding model/tool latency |
| Warm task start < 2 s p95 | tenant runtime: time from relayed message accept to first model request (agent loop / durable jobs) |
| < 1% platform errors | operations metrics exporter (18 alert rules in `infra/monitoring`) |
| Zero cross-user access | two-tenant isolation test (`docs/tenant-qualification.md`), gateway and directory ownership checks |
| Bounded resource growth | per-tenant backup size, volume usage, host memory over the 24-hour soak |

Ramp plan: 25 → 100 → 250 → 500 → 1,000 active tenants, then a 1,250-user burst and a 24-hour soak, with
simultaneous desktops, backups, signups and mass wakes, on the staging organization after the limit increase.
