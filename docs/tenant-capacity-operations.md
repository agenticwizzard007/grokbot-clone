# Tenant capacity maintenance

This implementation supports measured, operator-reviewed growth of a tenant's machine and encrypted volume. It does not enable unattended autoscaling, allocate resources on startup, or qualify any Fly sizing. Production stays disabled until cost, quota, interruption, trusted collection and filesystem-growth behavior are approved and tested. A larger VM does not increase an upstream subscription allowance. Container CPU, memory, process and filesystem limits remain enforced; no account generation queue or helper cap is added.

## Policy and usage evidence

Use the trusted provisioner/operator environment with its own directory credential. No capacity route exists in the browser, tenant app or MCP adapter. Each tenant requires an explicit `tenant_capacity_policies` record, installed by `capacity-cli set-policy --tenant ID --file approved-policy.json`. It carries a monotonically increasing revision. Only a trusted operator can install or expand it. Policy changes are refused while environment maintenance is incomplete; resolve or roll back that operation first. There is no default approval.

Example policy shape, for review only (these sizes and thresholds are not a recommended production budget):

```json
{
  "version": 1,
  "enabled": false,
  "tiers": [
    {"cpu_kind": "shared", "cpus": 2, "memory_mb": 4096},
    {"cpu_kind": "shared", "cpus": 4, "memory_mb": 8192}
  ],
  "maxVolumeGb": 40,
  "volumeStepGb": 10,
  "cpuThreshold": 0.8,
  "memoryThreshold": 0.8,
  "diskThreshold": 0.8,
  "reserveGb": 2,
  "windowSeconds": 120,
  "cooldownSeconds": 600
}
```

Choose ceilings from the approved per-user and fleet budget and provider quota. The code enforces resource ceilings; it does not calculate or promise a dollar bill. CPU tiers stay within a single explicitly approved CPU class and only increase. Automatic downsize, volume shrink and CPU-class changes are unsupported. Sustained CPU or memory pressure selects at most one next tier. Disk growth uses the larger of the target utilization and backup reserve, rounded to the configured step. Exhausted policy returns an error for operator review; it cannot silently exceed the ceiling.

The input is a bounded JSON array of trusted collector measurements:

```json
[{"tenant":"usr_exampletenant","generation":"1","machine":"machine-id","volume":"volume-id","at":1794355200000,"cpu":0.9,"memory":0.7,"usedBytes":9663676416}]
```

That single row demonstrates the shape only and is not a valid window. Supply at least three samples covering the policy window, at most 60 seconds apart, with the newest no older than 60 seconds. CPU and memory are fractions of the current VM allocation; a sample describes the interval since the preceding timestamp. Disk use includes tenant data, profiles, Docker writable data on the tenant volume and backup staging, measured at the host. Samples bind the exact tenant, generation, machine and volume. Gaps, future times, invalid values, unowned environments and old evidence are refused. A brief spike does not count as sustained compute pressure.

The collector must run outside untrusted workload containers and authenticate its host/provider inventory. **No production collector is selected or wired yet.** Importing a user-provided file or accepting model-supplied measurements is not an acceptable collector. The privileged CLI records the operator's evidence URI, SHA256 and reviewer; those fields describe reviewed evidence, not an independent validation or proof created by the command. Archive the actual report and compare its digest before planning. Do not put provider payloads or credentials in it.

## Review and execution

Build the server, then run `node server/dist/platform/capacity-cli.js` in the operations environment. `set-policy` changes only policy; `plan` performs cloud reads and writes an exclusive mode-0600 local file. Neither queues maintenance.

```sh
node server/dist/platform/capacity-cli.js plan \
  --tenant usr_exampletenant --usage trusted-usage.json \
  --evidence-uri https://evidence.example/usage-report \
  --evidence-sha256 ACTUAL_REPORT_SHA256 --reviewer operator-identity \
  --acknowledge-maintenance yes --output reviewed-capacity-plan.json
node server/dist/platform/environment-cli.js queue --plan reviewed-capacity-plan.json
node server/dist/platform/environment-cli.js status --id OPERATION_ID
```

The acknowledgement means the operator has approved the maintenance interruption and any required user notification. It is not an assertion that the VM is idle. There is no busy/idle inference or unattended scheduler. Recollect fresh evidence if review exceeds its freshness window. Queueing rechecks the exact source, image, policy revision, evidence, cooldown and target. In addition to the ordinary signed-image gates, the exact tenant-host image needs a `tenant-capacity-resize` release-gate record. Only real staging evidence may supply it.

Queueing revokes runtime routing/credentials and advances the generation, then the durable environment worker stops and removes the old machine. It retains the user's encrypted volume, verifies the observed source capacity, journals any irreversible growth before dispatch, and creates a new stopped machine at the admitted size. Bootstrap and start require the current lease, generation, policy and release gate. Routing resumes only after a fresh trusted host acknowledgement. Subsequent image updates preserve compute sizing and storage; restore creates a volume at least as large as the current source volume. Existing in-flight operations without persisted source sizing require reconciliation if the source machine has already disappeared.

Lease checks acquire operation/tenant row locks first, then revalidate ownership and expiry in a new statement using the actual PostgreSQL clock. Waiting on a lock cannot renew an expired worker's authority. Retry metadata follows the same rule, while dispatch journals remain intact for reconciliation. Usage freshness is also measured after the policy lock is acquired. An evidence row must have an effective approval timestamp; merely recording unapproved or future evidence cannot enable resizing.

Fly volume extension uses an absolute target with `PUT /apps/{app}/volumes/{volume}/extend`. The code checks the private network and resource ownership, requires detachment before a new extension, and then inspects the resulting volume size. An accepted response alone is insufficient. A lost response is recovered by inspection; an unobserved outcome blocks retry, rollback and deletion rather than issuing another cloud write. If a later machine-create response is lost, the same machine is inspected. The volume cannot be grown twice through a retry increment.

Before activation, rollback recreates the prior compute size on the preserved source volume. Confirmed volume growth remains in place because it cannot be reversed. Once a run permit was issued, use the existing reconciled-checkpoint recovery workflow. Policy/gate revocation keeps an admitted change held for reconciliation; there is no force flag to bypass it.

## Qualification still required

On one owner-approved disposable staging tenant, qualify the actual Fly API contract, enforced guest size, network isolation, stop/detach behavior, volume extension, usable guest filesystem expansion and image boot before recording `tenant-capacity-resize`. API `size_gb` is not proof that the guest can use the additional filesystem blocks. Exercise lost responses, restart, lease loss, rollback, deletion during growth and a later image update, and measure interruption, backup temporary storage and data integrity. Keep that evidence bound to the exact host image.

Then select and qualify the trusted collector; decide admission during active work, user notification, policy budgets and fleet headroom; integrate a bounded scheduling loop with the same policy/fencing checks. This operator path is intentionally not a claim of automatic production scaling or capacity for 1,000 users. That claim still requires the approved fleet ramp, burst and 24-hour soak.

## Directory schema release step

Run `SWARM_ROLE=platform node server/dist/platform/migrate.js` in a separate trusted release job with **MIGRATION_DATABASE_URL** set to the dedicated schema-owner connection. The command also accepts explicit `provisioner` and `composio-gateway` roles. It refuses standalone/tenant/unset roles and never falls back to runtime `DATABASE_URL`. DDL is serialized by the existing PostgreSQL advisory transaction lock and can be retried. Runtime services do not apply schema changes at boot. Keep migration credentials out of tenant images and ordinary service deployments; configure TLS and grants through the infrastructure runbook.
