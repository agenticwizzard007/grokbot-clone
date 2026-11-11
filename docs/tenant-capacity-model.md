# Tenant capacity, cost and scaling model

Numbers come from the code as of main 1331d58 and Fly's published prices effective 2026-10-01, read on 2026-11-11 from
fly.io/pricing-update and docs.fly.io/mpg/overview (RAM $6.00/GB/month,
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

**Known problem:** the container memory ceilings are not budgeted against the machine. App 1536 MiB + desktop
1536 MiB + one runner or MCP container 768 MiB = 3840 MiB, leaving 256 MiB of a 4096 MiB machine for the kernel,
dockerd, the host process and backups; a second concurrent runner or MCP container (4608 MiB) exceeds the machine
before any host overhead. These are cgroup ceilings, not eager allocations or measured working sets, and tmpfs usage
is charged to its container (do not double-count it). PR #21 changes the VM guest sizing per tenant; it does not
change these per-container limits and does not make arbitrary overlap fit a finite VM. The owner's overlapping
Bots/helpers workload must be measured and headroom chosen without reintroducing generation queues or helper caps.

## 2. Cost formulas
- Running tenant per month = preset $4.39 + (4096 − 512 MB included) ≈ 3.5 GB × $6 = **$25.39**, + volume 10 GB × $0.15 = **$1.50**.
- Stopped tenant per month = rootfs ≈ 1–2 GB × $0.15 ≈ **$0.15–0.30** + volume **$1.50**.
- Platform services: one performance-2x platform machine ($66, single serving replica until inter-replica routing exists) + provisioner shared-cpu-2x 1 GB (≈ $7.40) + gateway (≈ $7.40) = **≈ $81/month**; Postgres Basic **$38** (staging, up to a few hundred tenants) or Launch **$282** (fleet) + storage; backups: S3 cents per GB.

| Active tenants (all running) | Tenant compute | Volumes | Platform + Postgres | Total / month |
|---|---|---|---|---|
| 25 | $635 | $38 | $119 (services $81 + Basic $38) | ≈ $790 |
| 100 | $2,539 | $150 | $119 | ≈ $2,810 |
| 250 | $6,348 | $375 | $363 (services $81 + Launch $282) | ≈ $7,090 |
| 500 | $12,695 | $750 | $363 | ≈ $13,810 |
| 1,000 | $25,390 | $1,500 | $363 | ≈ $27,250 |
| 1,250 burst (while running) | $31,738 | $1,875 | $363 | ≈ $33,980 |

The owner's target is 1,000 *simultaneously active* users, so the all-running column is the budget case. With idle
suspension (`SWARM_IDLE_SUSPEND_MIN` style policy in the lifecycle worker) the compute line scales with active hours.
Model/API spend, Composio, Inkbox and egress ($0.02/GB) are additional.

## 3. Fly limits versus the provisioning and wake patterns
- Personal organizations start with a soft cap of roughly 20–50 running machines and a per-plan cap on apps; the fleet
  needs about 1,250 apps, custom networks, volumes and machines. Request the increase from Fly before any ramp.
- Machines API: Fly's documented policy is per-action, per-identifier limits; the figures of about 1 request/second
  per action (bursts to 3; `GET machine` 5/s) come from Fly staff forum answers and have not been verified against
  this account. A tenant
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
- Signals that still have to be built: a trusted host-side collector reporting tenant memory pressure and disk usage
  (the runtime refresh does not report pressure today; `usage-vm.ts` meters legacy SQLite computer rows, not tenant
  hosts), an idle-suspension schedule for the isolated lifecycle worker (`SWARM_IDLE_SUSPEND_MIN` is a legacy
  cloud-VM setting and is not wired into it), backup health and size, and hung-tick metrics from the operations
  exporter (which exposes state and delay gauges, not an error-rate ratio).
- Before enabling: the `tenant-capacity-resize` gate must record actual Fly resize, volume extend and guest
  filesystem growth behaviour for the exact signed host image in staging; interruption and notification policy and
  spend ceilings must be approved.

## 5. Acceptance targets mapped to measurement points
| Target | Where to measure |
|---|---|
| Control API p95 < 500 ms | to implement: request duration histogram at the platform relay (`server.ts`), excluding model/tool latency |
| Warm task start < 2 s p95 | to implement: tenant runtime timing from relayed message accept to first model request (agent loop / durable jobs) |
| < 1% platform errors | to implement: HTTP error numerator/denominator in the operations exporter (today it exposes state and delay gauges; 18 alert rules in `infra/monitoring`) |
| Zero cross-user access | two-tenant isolation test (`docs/tenant-qualification.md`), gateway and directory ownership checks |
| Bounded resource growth | per-tenant backup size, volume usage, host memory over the 24-hour soak |

Ramp plan: 25 → 100 → 250 → 500 → 1,000 active tenants, then a 1,250-user burst and a 24-hour soak, with
simultaneous desktops, backups, signups and mass wakes, on the staging organization after the limit increase.
