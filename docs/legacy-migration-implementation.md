# Legacy migration implementation boundary

This describes implemented migration components and the remaining integration. It is not an enabled production migration runbook. No real account has been frozen, exported or cut over by this implementation work.

## Implemented sequence

1. Audit a stopped snapshot and reserve the original immutable account identity with `stageLegacyImport`. Provider subjects must be proven; matching email strings are insufficient. Every selected Composio connection is checked against the original private provider identity. Fresh provider sign-in redeems the reserved identity claim. Generic provisioning is not started.
2. `MigrationCoordinator.beginExport(tenant)` reserves an immutable operation and fences generic provisioning. Its source adapter must prove database writers, subprocesses, pending VM starts and account file writes are stopped. The coordinator records the exact source checkpoint and source fence in `exporting`; no target package or activation is accepted yet.
3. Review `planMigrationDestination` and reserve its private app/network and encrypted volume through `MigrationDestination`. Reservation requires the complete source hold, qualified image, exact migration lease and immutable reviewed binding; it creates no VM or runtime credentials. Export and encrypt the package into that reserved destination. `exportTenantDatabase` rejects foreign explicit and implicit references, including incoming room memberships, hidden Bot parents, preferences, usage and ambiguous phones. `prepareMigrationPackage` copies only owner-mapped files, rejects symlink/hardlink/changed-file sources, rewraps authenticated owner credentials, disables grants and records reconnection requirements. `MigrationTransfer` connects this packager to tenant encryption, durable upload inventory, scoped backup storage and the host installation format under the exact migration lease.
4. `prepare(tenant, packageHash, sourceCheckpoint)` requires the exact reserved checkpoint, live source hold and a verified target package. A verification race or lost/partial freeze enters reconciliation. `cutover` cannot freeze a still-running source after accepting a pre-existing package.
5. `FlyMigrationTarget` implements held target installation, activation, inspection, stop and fresh rollback checkpoint capture through the Fly driver and host protocol. It checks the same source hold and authorizes workloads only after exact installation acknowledgement; the coordinator publishes routing after exact host readiness. Rollback stops the target, boots only its trusted host in hold mode to capture a fresh encrypted checkpoint, stops that host again, and supplies the resulting digest to the source restore adapter. Complete source restore/resume/retirement and a production maintenance entrypoint remain unfinished.

Coordinator and transfer metadata now use tenant-before-migration lock ordering. Lease/owner state is checked in a fresh statement after lock waits using `clock_timestamp()`. Expiration or account revocation while waiting cannot publish prepared/cutover metadata. This is covered by real PostgreSQL lock-race tests.

## Encrypted package transfer

`server/src/platform/migration-transfer.ts` is trusted maintenance code. It has no browser, model, runtime or public upload endpoint. A qualified source adapter must already supply the complete frozen checkpoint; the database-only/current-process/desktop drain functions do not satisfy it.

The integration sequence is:

```ts
const frozen = await coordinator.beginExport(tenant);
const plan = await planMigrationDestination(directory, {
  tenant, image: qualifiedHostImage, region: reviewedRegion,
});
// Review plan before this infrastructure mutation.
const destination = await new MigrationDestination(directory, fly, qualifiedSource).reserve(plan);
const transfer = new MigrationTransfer(directory, envelopes, storage, qualifiedSource);
// Inspect the exact artifacts attested by qualifiedSource, after its freeze.
// Review the private report; zero inventory issues is necessary, not a freeze.
const inventory = await inventoryLegacySource({
  tenant, sourceSnapshot, filesRoot, cliProfilesRoot, desktopSnapshot,
});
const result = await transfer.upload({
  tenant, operation: frozen.operation, checkpoint: frozen.checkpoint,
  sourceSnapshot, filesRoot, cliProfilesRoot, desktopSnapshot,
  reviewedInventoryHash: inventory.inventoryHash,
  volume: destination.volume, workDirectory: privateMaintenanceDirectory,
  sourceSessionSecret,
});
await coordinator.prepare(tenant, result.packageHash, result.checkpoint);
```

This is a library integration contract, not an enabled production migration command. `sourceSnapshot` and all file/profile roots must come from the reviewed frozen source layout. The full source checkpoint must attest those artifacts. The destination volume must come from the reviewed reservation above; transfer rejects missing or substituted reservations. Inventing a source/volume record is not a migration shortcut. Import the legacy session secret through the maintenance secret store, never a CLI argument, log, model prompt or shell history. The maintenance workspace must reside on encrypted storage, be absolute/canonical, owned by the maintenance user and mode 0700.

## Offline source inventory

`migration-inventory-cli.ts` provides a read-only prerequisite inspection. It imports no application runtime, starts no provider client and changes no source file, routing, host or directory record. It writes an exclusive mode-0600 report beneath a canonical mode-0700 maintenance directory. The report contains private paths, IDs, sizes and hashes, so keep it on encrypted maintenance storage; it is not platform telemetry.

Example for a **previously prepared offline staging snapshot** (substitute reviewed staging values; never point this command at the production live database):

```sh
node server/dist/platform/migration-inventory-cli.js inventory \
  --tenant usr_REVIEWED_ID \
  --snapshot /encrypted-maintenance/source/swarm-snapshot.db \
  --files-root /encrypted-maintenance/source/files \
  --cli-profiles-root /encrypted-maintenance/source/cli-profiles \
  --desktop-snapshot /encrypted-maintenance/desktop \
  --source-image "$reviewed_legacy_image_digest" \
  --source-host staging-source/REVIEWED_MACHINE_ID \
  --source-volume REVIEWED_VOLUME_ID \
  --output /encrypted-maintenance/reports/source-inventory.json
```

Omit `--desktop-snapshot` only when the source records no desktop volume. An absent CLI root is incomplete, even when no provider is currently selected. Do not create an empty replacement root to satisfy inspection: its provenance must be part of the future qualified source checkpoint. The command requires an explicit pinned image and app/machine/volume declaration, but marks that declaration `verified:false`; it has not queried the cloud provider or attested a host.

The database input must be an offline rollback-format SQLite snapshot without WAL, SHM or journal sidecars. A trusted snapshot operation may create one with SQLite's backup or `VACUUM INTO` facilities as appropriate to the reviewed source. This inspection never changes journal mode. A WAL-format database is refused before opening SQLite, because even a read-only connection may create sidecar files. A copied database without its WAL is not a valid snapshot.

The inventory includes all owned Bot IDs, including hidden Bots; mapped files; hosted `.claude`, `.claude.json` and `.codex` profiles; and supported browser/desktop paths. It requires exact desktop tenant/volume manifest identity. Missing roots, unowned Bot directories, unmapped desktop content and nonempty shared CLI home paths require explicit reconciliation. Empty cache/config directories are harmless, but nonempty unknown content is never silently discarded or copied into both provider runners. Foreign known Bot/profile directories are not opened.

Descriptor-relative opens reject symlinks in every ancestor, dangling links, hardlinks, devices and FIFOs. Enumeration, recursion, file count and bytes are bounded. The inventory hash binds paths, ownership, snapshot bytes, file contents, empty directories and outstanding issues. `MigrationTransfer` now requires `reviewedInventoryHash`; packaging compares it before writing, validates copied bytes and enumerates again before publication. Changing the reviewed inventory, roots or journal binding requires reconciliation. Old transfer journals lacking this binding are refused; do not delete or rewrite an admitted journal to bypass that check.

The boundary is explicitly **`observed-files-only`**. The report contains no `writersStopped`, `filesFrozen` or source checkpoint field. It records remote CLI mode and uncertain provider jobs without claiming that disconnecting them stopped their processes. It also cannot discover source hosts, custom environment paths or files outside the declared roots. A full source adapter still needs independently verified process, pending-start, descriptor, writable-mount and provider inventory evidence. A clean report cannot authorize `beginExport`, target activation or source deletion by itself.

The package and encrypted backup format now preserve empty directories. New backups use plaintext manifest schema version 2 inside the existing authenticated envelope. Current readers accept older version-1 backups; old readers reject version 2 instead of silently losing directories. Qualify and use a host release with the updated reader before transferring these bundles. Restore rejects traversal, duplicate/conflicting directory paths, file-as-parent layouts and excessive depth before creating the unpublished environment.

## Rollback credential preparation

`rewrapLegacyRollbackCredentials(database, tenant, targetKey, legacySessionSecret)` prepares credentials in an already restored, owner-verified **isolated snapshot**, never a live shared database. It authenticates the target tenant/purpose envelopes and re-encrypts them with the original source's owner-derived key. Supported records are private model/voice API keys, OpenRouter credentials, Apple refresh tokens and MCP credentials/OAuth. Invalid keys, foreign owners, substituted ciphertext or malformed secrets roll back the entire transaction. Temporary key and plaintext buffers use the shared envelope cleanup rules.

MCP Bot/folder grants and cached tools are cleared, revisions advance, pending approvals are denied and MCP policies are removed. The return value still requires reconciled import and makes no routing or writer claim. The source adapter must independently verify that the reviewed source image understands `private1` owner/purpose envelopes, resolve the exact fresh target checkpoint, obtain the original source secret through the maintenance secret store, merge only owned records/files while all source writers remain fenced, and handle interrupted resume/retirement. This helper supplies no live-merge, freeze-release, resume or deletion shortcut.

Reservation uses the actual `FlyTenants` driver behind the same private-network/encrypted-volume assertions as ordinary provisioning. An immutable `migration_destinations` record binds tenant, migration, checkpoint, source fence, generation, image, region and destination. Cloud creation intents are committed before dispatch. Lost responses may be reconciled against observed resources; an absent resource after an unobserved create does not authorize another create. Unadmitted namespaces, extra volumes, unexpected machines and changed bindings fail. Revocation, lease expiry and source loss are checked after cloud waits and before effects/publication. A failed reservation retry withdraws the previous transfer permission until the complete inventory is revalidated. The tenant remains pending with no routing, credentials or host run permit. Qualified source/Fly behavior is still required; tests use a simulated Fly transport, not real infrastructure.

Keep the returned reservation with the maintenance journal. Retries must use the exact reviewed plan; image/region/checkpoint changes require reconciliation. Reserve before the first transfer. Once a transfer has been admitted, reservation cannot allocate or replace its destination. Existing lifecycle deletion inventories the same deterministic app and volume namespace, including creations whose acknowledgement was lost. Unknown creates and missing source-retirement receipts keep deletion pending.

Transfer checks the source hold before/after packaging and before every storage dispatch. It obtains only this tenant's KMS data key, rewraps proven credentials, creates an encrypted full-environment bundle and clears its temporary key buffer. Temporary plaintext is removed after sealing. A durable `binding.json` prevents reusing another tenant/operation's workspace; `transfer.json` binds the exact owner, operation, source checkpoint/fence, destination volume, encrypted part hashes and package receipt. Crashed plaintext staging paths are removed only inside that bound private workspace. An unbound nonempty workspace requires reconciliation instead of automatic deletion.

The directory stores only immutable transfer/part metadata. `migration_transfers` links the coordinator operation to one backup ID and package hash. Backup storage receives owner-prefixed ciphertext; it never receives the legacy session secret. Empty files are valid authenticated encrypted entries and survive the storage/host-installation path. Foreign IDs, changed journals, missing admitted bundles, altered ciphertext and mismatched target volume/generation are rejected.

After a lost upload response, retain the same local encrypted bundle and retry `upload` with the same binding. Completed parts are reused. An outstanding part's three-minute lease cannot be cleared by an old worker; retries and deletion wait for it to expire. The actual upload deadline is two minutes, and the lease is refreshed immediately before dispatch after any source/authorization waits. A storage acknowledgement without complete bounded stream consumption cannot finalize the package. Missing local journals or different bytes require reconciliation, never a new backup ID substituted for the admitted one.

An observed lost/partial/resumed source moves the migration to reconciliation and attempts fenced source containment, even if directory metadata is unavailable. Revoked accounts and newer migration fences prevent acknowledgement/publication. The transfer itself never enables routing, resumes a source or starts a target VM. `verifiedMigrationTransfer` lets the trusted target adapter resolve only the admitted owner/checkpoint/package/destination binding; host installation verifies the current generation, reserved destination, source checkpoint and fence for both expired and unexpired inputs. Initial runtime backup APIs still refuse pending migration accounts.

Ordinary backup expiry retains an unfinished migration's admitted inputs, including reconciliation states. Explicit account deletion overrides retention but still waits for outstanding uploads. Completed migrations resume normal backup retention. Retention and deletion operate on encrypted object versions and multipart state through the existing storage driver; real S3 behavior remains unqualified.

## Target activation and rollback checkpoint

`FlyMigrationTarget(directory, fly, qualifiedSource)` implements the coordinator's target interface. Construct the coordinator with this target and the same qualified source adapter. These are trusted maintenance libraries; they are not enabled by a tenant request or an automatic signup migration.

Activation binds the admitted transfer and destination to an immutable installation and target generation. It creates only a stopped machine, records creation before dispatch, reserves a held host policy, stages the owner-only encrypted installation, and supplies a fresh bootstrap credential. The Fly driver now supports authorization callbacks after its own machine lookup and immediately before bootstrap/start effects. Source holds, migration leases and image qualification are rechecked through those waits. No platform database, KMS or Fly credential enters the target environment.

The host installs while held, then acknowledges the exact machine/volume/generation/installation. A durable run-permit marker and host policy change share one transaction. Target activation waits for current readiness; the coordinator alone publishes routing. Failed installation, source loss, changed owner/generation or withdrawn qualification enter containment rather than accepting partial readiness. A lost cloud start response remains an outstanding action; a later observed stop alone does not erase that uncertainty or authorize another start. Its resolution requires provider outcome reconciliation. Default activation/checkpoint wait is bounded to 30 minutes, not a measured recovery-time guarantee.

Rollback does not reuse the imported package. After observed target stop, `stageHostCheckpoint` binds a new request to its tenant, migration, machine, volume, generation and exact hold revision. The root host handles `/internal/host/checkpoints` only on a held boot, before starting any application, desktop or runner. It verifies that Docker reports no running containers and reports the current hold. The snapshot uses the actual current environment directory, SQLite and profile/files, the tenant key and the existing encrypted bundle format.

The root-only checkpoint journal binds the same identities and resumable ciphertext. A host token may upload only the exact backup first admitted for this request; ordinary scheduled backup admission still rejects held hosts. Workload tokens, foreign hosts, reused backups and altered generations/revisions are rejected. A pending or completed checkpoint prevents a run permit. Retention preserves rollback inputs until reconciliation/rollback is resolved; account deletion overrides that retention while waiting for outstanding uploads.

The platform derives the checkpoint receipt from the complete immutable part inventory, not an arbitrary digest supplied by the host. Lost acknowledgements reuse the same local journal. Missing admitted journals require reconciliation. The adapter observes a final stopped VM before returning `writersStopped:true`; source restoration must resolve the receipt to the exact `host_checkpoints`/backup record and must independently enforce its own stopped source and reverse credential-encryption rules. Tests execute real package encryption, host installation, fresh target snapshot and decryption using real SQLite/PostgreSQL. Fly, container absence, KMS/storage transport and source enforcement are simulated; they do not qualify actual hosts or a complete production source adapter.

## Database and tracked-work fencing

`server/src/platform/legacy-database-fence.ts` implements the SQLite portion:

- `holdLegacyDatabase` is trusted maintenance code, not an HTTP/agent action. It installs durable triggers in one immediate transaction. Its receipt says `boundary: database-only` and provides no `writersStopped` or `filesFrozen` assertion.
- The operation identity is stable. Fence numbers may advance for that operation; older or substituted operations fail. There is deliberately no release helper until reconciled source rollback is integrated.
- Owner checks run for both old and new rows. They include indirect foreign-key ownership and known implicit Bot/session/phone relationships. `INSERT OR REPLACE`, `UPDATE OR REPLACE`, UPSERT, rowid collisions and unique index collations cannot evict held records through SQLite's implicit deletes.
- The compiler refuses unknown ownership, virtual tables, expression indexes, composite foreign keys and unsupported rowid shadowing. An empty unknown extension is not automatically trusted. Shared `server_settings` remains outside tenant data ownership and is omitted by export.
- Legacy startup registers the pure messaging decoder and verifies exact schema/trigger fingerprints. Drift or missing guards keeps startup stopped. Session creation and lookup reject held accounts. Taking the database hold alone does not revoke already-open sockets; the process drainer below performs that step.
- `LegacyActivityGate` tracks existing usage callbacks and blocks new ones for held accounts. It adds no generation queue or account/helper cap. `drainLegacyUsage` has a bounded deadline and explicitly reports `tracked-usage-only`. It cannot stand in for stopping detached children, external machines or untracked background work.

SQLite migration controls are trusted operational state. Anyone with arbitrary SQLite schema or host access can disable them; they are not a substitute for the final tenant VM/container isolation boundary. The source adapter must bind the reviewed source image and every relevant process/host to its authorization and must refuse unsupported source layouts.

## Current-process and desktop draining

These are trusted maintenance functions, with no browser, model or public HTTP entry point:

- Background admission/accounting now covers cloud create/start/resize/archive/delete, provisioning callbacks, owner-resolved inbox handlers, outbound message queues, subscription jobs and MCP execution. A queued send checks admission after waiting. Provider follow-up effects check again after asynchronous lookups/uploads. Normal generation stays concurrent.
- Provisioning skips held owners without consuming attempts or starving other accounts. A late create whose database update was fenced is retained for reconciliation instead of orphan cleanup. Unknown outcomes are not converted into successful migrations.
- Inbox processing and history cleanup skip held records, using the same provider-event decoder as the database triggers. Login housekeeping uses transitive ownership predicates, so a held linked session does not block cleanup for other users. Routine, event, proactive and VM-meter callbacks skip held owners.
- `drainLegacyProcess(DatabaseFence)` notifies session revocation listeners, disconnects the owner's cloud/native/CLI bridge sockets, cancels login terminals under the existing credential-mutation lock, waits for hosted subscription jobs, closes the owner's MCP sessions, interrupts Bots and drains tracked callbacks/messages. Credentials are preserved. It checks the exact operation/fence and rejects timeout, cleanup failure or a superseding fence. Its receipt says `current-process-only`.
- `stopLegacyCloud(DatabaseFence, authorize)` calls the process drainer, validates exact provider metadata and requires observed `stopped` state, followed by a consistent inventory. It does not accept suspension or a successful stop response alone. The required authorization callback is rechecked after provider waits; the future directory adapter must bind it to the current migration lease. In-flight/failed provisioning, ambiguous creations/archives, missing ownership and unexpected machines require reconciliation. It does not update the frozen database or delete disks. Its receipt says `legacy-desktop-only`.

The current-process receipt cannot prove a remote CLI or an orphaned subprocess stopped, and the desktop receipt cannot prove the source application's files are frozen. Neither contains `writersStopped` or `filesFrozen`. The coordinator deliberately rejects such partial receipts. Multiple source application processes, detached writers, remote credential homes and file descriptors still need host-level inventory and enforcement. Production standalone execution remains prohibited; these functions do not enable a production legacy-source deployment role.

## Remaining concrete adapter work

- Supply the reviewed staging source app/machine/volume IDs, pinned image, database/files/CLI root paths and all additional process/remote bridge writers. Run the offline inventory on legitimately captured staging artifacts, reconcile its issues, then bind the drain functions to that image and a qualified maintenance control plane. The implemented file report does not discover every process/host or attest every possible extension.
- Prove actual container/process-group termination and remote CLI shutdown rather than inferring it from a disconnected WebSocket or a settled callback.
- Reconcile unknown or late cloud creates, archives and deletes before accepting a source checkpoint. Qualify the desktop stopper against real Fly metadata/stop/inventory semantics; tests use a simulated driver.
- Enforce and verify filesystem quiescence, including already-open descriptors and CLI/browser profiles. A path check or successful copy is not a write fence. Verify exact source layout, owner/volume, schema, operation and checkpoint before issuing a full `SourceCheckpoint`.
- Qualify the implemented Fly target activation/stop and fresh checkpoint protocol against actual provider/network/container behavior. Integrate it with the complete source adapter and a reviewed maintenance entrypoint; do not manufacture source receipts or use ordinary recovery to bypass legacy provenance.
- Implement reconciled source record/file restore, source resume, rollback routing and retryable deletion across both source and target. Reverse credential rewrap for an isolated rollback snapshot is implemented above, but is not a live source merge. No stale checkpoint may overwrite a source already resumed after a lost response.
- Qualify a synthetic end-to-end cutover, crash/restart, failure containment, rollback and account deletion before importing real credentials. Kernel/Fly/KMS/provider evidence and the independent security assessment remain external release gates.

Deletion now requires both `writer='none'` and an actual source-retirement receipt (`source_retired_at` and `source_retirement_digest`) before generic lifecycle cleanup can finish. A stopped source still contains private data. The future trusted retirement adapter must produce these fields from verified source record/file/credential cleanup; do not populate them merely to bypass a pending deletion. The receipt and deletion integration still require implementation and qualification.

Tests use real SQLite/PostgreSQL for ownership, triggers, leases and races, real encrypted bundles and the actual host installer, plus real WebSocket connections for owner-only draining/reconnect rejection. Transfer tests use simulated KMS/object storage and source freeze receipts. Source/target VM and file-freeze receipts in coordinator tests are simulations. They do not prove a complete migration adapter exists or that real legacy hosts/files are stopped.
