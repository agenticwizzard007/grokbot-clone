# Knowledge schema compatibility and recovery

The knowledge schema installed by PR #48 (including production v39/v40) is forward-only. **Do not deploy pre-Hermes code onto the upgraded volume.** The pre-Hermes `1fd91e1` readers have no `skills.deleted_at` or `memories.status` predicates. They would expose deleted skills and deleted/superseded memories. Their hard skill deletion also hits the immutable revision trigger. This remains true when the account-deletion trigger is repaired, and even an empty upgraded database is not declared downgrade-compatible.

The account-deletion repair atomically replaces `knowledge_receipt_no_delete` at startup, including on volumes that already have the old definition. It changes no receipt or learning record. Deleting receipts directly or modifying receipts still fails. The delete guard permits the foreign-key cascade only after its account or Bot parent has been removed; a failed account-deletion transaction restores its database rows. The repair does not roll back filesystem cleanup or external revocations already attempted by `deleteAccount`, nor does it reconcile earlier failed deletion attempts automatically.

An active legacy tenant-migration hold binds the exact source schema. If that hold predates the repair, startup refuses the changed schema and rolls the trigger replacement back, preserving the old trigger, records and fence. Leave that source stopped and reconcile it through the existing migration coordinator before upgrading; never clear or rewrite a fence to force startup. Holds created with the repaired schema remain valid across restarts.

## Offline compatibility check

Use a consistent, private SQLite backup from the chosen recovery checkpoint. Do not copy only `swarm.db` from a running WAL database. Stop all writers/automatic restarts when assembling an offline checkpoint, or use the established SQLite backup/export procedure. Keep the matching files, profile data and migration journals. Rehearse on a disposable copy with no production network access.

From a checkout containing this repair and its locked Node 22 dependencies:

```sh
node scripts/check-knowledge-rollback.mjs /private/recovery/snapshot.db \
  > /private/recovery/knowledge-compatibility.json
```

The command checks the fixed **pre-Hermes** contract; it does not infer compatibility from an arbitrary image tag. It refuses symlinks, unrecognized/corrupt files and snapshots with WAL/SHM/rollback-journal sidecars. It opens only a private temporary inspection copy with a read-only SQLite connection, checks integrity and records the snapshot SHA-256. It does not import application modules, start workers, run migrations, print account content or modify the source. Temporary inspection storage needs space for the database copy. Sidecar absence is not proof that writers stopped; the operator must establish the checkpoint boundary.

Exit codes:

- `2`, `incompatible`: knowledge objects or knowledge projection columns exist, including partial upgrades. Pre-Hermes rollback on this database is refused regardless of row counts.
- `0`, `no-knowledge-schema-detected`: no blocker from this one schema was detected. The report still sets `rollbackApproved:false`. It does not qualify other schemas, the target image, credentials, files or external effects.
- `1`, `inspection-failed`: invalid input, integrity error or other inspection failure. Stop recovery; do not interpret failure as compatibility.

Retain the report with the exact candidate image digest, source revision and checkpoint manifest. Do not drop triggers/tables, clear tombstones, or edit statuses to make the check pass. Those actions destroy history or revive data the owner removed.

## Recovery choices

1. **Prefer a compatible forward repair.** Preserve the current database/files and use a reviewed build that understands knowledge revisions, statuses, suppression and receipts. Rehearse startup on a disposable copy of the current checkpoint, verify immutable evidence and owner-scoped deletion, then follow the normal release review. A code change alone is not deployment approval.
2. **A pre-upgrade backup restore is a separate recovery operation.** Require a verified pre-Hermes database plus its matching files/profile checkpoint, exact compatible image/configuration, and explicit acceptance of data loss since that checkpoint. Keep the current checkpoint intact for reconciliation. An old backup may itself contain subsequently deleted accounts, forgotten facts or corrected memories: reconcile those changes before opening traffic, or refuse the restore. Reconcile uncertain/completed external actions separately so queued work cannot repeat sends or writes. Restoring a backup does not undo provider-side effects.
3. Verify database integrity/foreign keys, isolation, sessions, actual application reads/deletes and job recovery on the disposable destination before the owner releases traffic. Do not start two writers against the same account state. The checker supplies only knowledge-schema evidence; it never migrates a live database or approves a deployment.

There is no supported in-place downmigration or lossy conversion command. Tests in `tests/knowledge-schema.test.mts` exercise existing-trigger upgrade, retained evidence, the real account-deletion function, foreign-account preservation, transaction failure, and the pre-Hermes query/deletion incompatibility on disposable data. They are not a production restore qualification.
