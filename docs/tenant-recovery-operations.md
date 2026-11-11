# Private environment recovery and image updates

These commands operate an **already isolated** account. They do not migrate an account out of the legacy shared application. The worker and host protocol have deterministic tests; real Fly, storage and recovery-time qualification is still required. Do not run this procedure against production until those gates pass. Authoring this procedure has not queued or deployed any real environment.

## Prerequisites

- Run the platform schema migration using its migration database role. Operators need trusted directory access; tenant runtimes and browser clients have no access to this command.
- Record actual evidence for every required release gate against the exact target image digest. Evidence is now keyed by gate and image, so a rolling update can retain qualification records for both versions. The commands cannot manufacture or bypass these records.
- Run the platform host APIs and the provisioner with the correct environment's Fly/KMS/S3 configuration. The provisioner runs lifecycle and environment replacement jobs within `PROVISIONER_CONCURRENCY`. This setting does not cap subscription Bots/helpers.
- For recovery, select a complete, unexpired full backup belonging to the account, and optionally a newer database backup. Verify backup timestamps and acceptable data loss against the incident. The reviewed plan names exact backup IDs; it never chooses another tenant's backup or silently falls back to an older snapshot.
- Budget for one replacement volume while the previous volume is retained. Downloading/decrypting a restore also needs temporary disk space. The default 10 GB volume and seven-day source-volume retention are unqualified starting values. Include old volumes in inventory and cost reviews.

## Plan and queue

From the repository root after building the server, substitute actual reviewed identifiers. Use the environment-specific operator configuration; no credentials belong in arguments or plan files.

```sh
node server/dist/platform/environment-cli.js plan \
  --tenant TENANT_ID --kind restore --image REGISTRY_IMAGE_AT_SHA256 \
  --full-backup FULL_BACKUP_ID --database-backup DATABASE_BACKUP_ID \
  --output /absolute/private/restore-plan.json
```

Omit `--database-backup` to restore the full checkpoint alone. For a software update, use `--kind update` with the target image and omit both backup arguments. An update preserves the current volume and database; it does not rewind to a backup.

Planning is read-only and creates a new plan file without overwriting an existing one. Review its tenant, source generation/machine/volume/image, target image, region and backup selection. Its digest detects changes to those fields; it is not a substitute for operator authorization.

```sh
node server/dist/platform/environment-cli.js queue --plan /absolute/private/restore-plan.json
node server/dist/platform/environment-cli.js status --id OPERATION_ID
```

**Queueing begins maintenance.** The account's runtime generation is revoked and routing suspended immediately. The provisioner then stops and verifies the source VM, removes the stopped machine, creates the replacement and installs fresh bootstrap credentials. A restore uses a new encrypted volume; an update reattaches the owned current volume. The source machine must be absent before a replacement is created. Sessions remain valid, but application access waits for the replacement to become ready.

For restore, the new host stays held while downloading only its assigned encrypted backup parts. It validates ownership and integrity, publishes a complete private environment and durable pointer, and acknowledges installation. The platform then permits startup. Routing becomes active only after the host has checked application health and SQLite ownership and acknowledged the exact readiness revision.

Recovery clears session/pairing/login attempts, disables restored native-computer consent and advances its revision. MCP connections are disabled, lose Bot grants/discovery/saved MCP approvals, and require explicit review; MCP OAuth must reconnect. Recovered queued/running tasks, pending inbox items and queued/sending replies remain `uncertain`. A snapshot can predate a successful external write. Reconcile provider outcomes before resubmitting such work; do not change those records back to queued wholesale.

## Retry, rollback and deletion

Worker attempts persist phase, lease, fence and sanitized error codes. Normal retries inspect cloud resources before creating anything. A lost response is not proof that a create failed.

Ordinary backup uploads use an exclusive part token, a two-minute dispatch deadline and a three-minute outstanding-write lease. A lost or failed response keeps that lease until expiry, so an immediate host retry may report `backup_requires_retry` while preserving its encrypted bundle. Do not clear part ownership/leases to force retry or deletion. The platform checks stream size/checksum and complete consumption itself; only the current authorized uploader may acknowledge a part. A stale response cannot change a replacement upload. Account deletion and retention wait for outstanding attempts. Qualify actual S3 abort and delayed-write behavior before relying on these timing bounds.

| Status | Operator response |
| --- | --- |
| `installation_pending` | Inspect the held host and its sanitized readiness error, backup catalog/storage access and temporary space. Await its durable installation acknowledgement. |
| `host_readiness_pending` | Inspect the pinned host's containment result, renewal, application health and database ownership. Never fabricate readiness. |
| `cloud_creation_uncertain` | Reconcile the exact provider request/resource inventory. An absent resource does not authorize another create; do not delete the durable action record to force a retry. |
| `environment_requires_reconciliation` | Inspect image qualification, owned source/target inventory, bootstrap and storage. The operation remains visible and routing stays suspended until readiness is proven. |
| `volume_cleanup_requires_retry` | Verify the old immutable volume ID, attachment state, provider deletion outcome and permissions. Cleanup retries and never targets the current mounted volume. |

Before the target has ever received permission to run, an explicit rollback may recreate the preserved source volume with its previously qualified image and a **fresh** machine/runtime generation:

```sh
node server/dist/platform/environment-cli.js rollback-before-activation --id OPERATION_ID
node server/dist/platform/environment-cli.js status --id OPERATION_ID
```

The operation first fences the previous worker, stops/removes target compute and resolves outstanding creates. It then records a new operation in `rollback_operation`; poll that ID until its fresh readiness acknowledgement. It cannot silently abandon an uncertain cloud create.

Once a run permit was issued, this rollback command refuses even if the target is currently held or public routing never became active. The target may already have issued external writes. After successful cutover, software rollback uses a new reviewed `update` plan on the **current** volume; data rollback requires a reconciled backup checkpoint and an explicit `restore` plan. Never repoint routing at a stale retained source volume.

Successful recovery retains the previous volume for seven days. Retention verifies the volume is not current or attached, scopes it to the recorded tenant operation and confirms provider deletion before marking it gone. Account deletion cancels replacement work, inventories both initial and replacement resources, waits for uncertain creations, and removes all owned storage after provider/backup cleanup. No operation can revive a deleted account.

## Qualification evidence

The deterministic suite exercises actual PostgreSQL leases/generations, encrypted SQLite/file restoration and host ownership checks with a simulated Fly API/object store. It covers restart/lost response, overlapping workers, source mismatch, foreign backups, image gate rejection, pre-activation rollback, revocation/deletion during creation, backup retention and delayed volume deletion.

Use the [bounded staging plan](tenant-qualification.md) for real provider API/network/container/storage tests. Measure interruption time, data loss, disk headroom and recovery within the requested 30-minute target. A green deterministic run is not proof of Fly private-network semantics, nested-container containment, KMS/S3 permissions or fleet capacity.
