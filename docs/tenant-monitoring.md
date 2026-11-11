# Platform operational monitoring

Platform and provisioner processes can export aggregate Prometheus metrics on a
dedicated loopback listener. This implements export and alert rules; it does not
prove live alert delivery, containment, recovery or capacity.

## Configure each platform and provisioner instance

Set `OPERATIONS_METRICS_TOKEN_FILE` to an absolute path containing a separately
generated token with at least 32 random bytes, encoded as hexadecimal or base64url.
The regular file must belong to the service user, have mode `0600`, and have no
symlinks or additional hard links. An optional trailing newline is accepted.
Use a secret store or private file creation; do not put tokens in command arguments,
URLs, images, logs or chat. The exporter loads its token once at startup; rotate
the exporter and collector copies together and restart the service.

`OPERATIONS_METRICS_PORT` defaults to `9464` and accepts ports 1024–65535.
The listener always binds **127.0.0.1**. There is no configurable public bind.
Both services use the same default port when hosted separately; use different
ports if they share one network namespace. Missing token configuration disables
the listener. A port without a token file or invalid configured credentials
fails startup. Production rollout must explicitly configure and verify every
platform/provisioner replica; disabled telemetry is not a passing release gate.
The exporter port differs from Prometheus's default web listener (9090). Start
the local collector with `--web.listen-address=127.0.0.1:9090` to keep its API
private as well; change that port if another local process already owns it.

Run a collector in each service's network namespace, with its own private copy of
the token owned by the collector user. `GET /metrics` requires the dedicated bearer
token. Browser sessions, tenant/runtime tokens and query-string tokens do not
authenticate it. Browser Origin requests are rejected. Do not expose the port
through a public proxy, Fly service, tenant network, or Docker socket.

Use [the sample scrape configuration](../infra/monitoring/prometheus.example.yml)
and [alert rules](../infra/monitoring/swarm-alerts.yml). Review the deployment/role
labels and paths. Assign a unique non-sensitive `instance` label and external
`collector` label to EVERY replica; every collector targets localhost, so its
default target address is not a usable replica identity. Never use tenant/user
IDs for these labels. Forward through an approved authenticated TLS transport when
using central rule evaluation. The Alertmanager destination is intentionally an
invalid placeholder; replace it and its separate credentials only in the reviewed
staging/production configuration. No notification is sent by installing these
files. Monitor collector/Alertmanager health and an independent dead-man signal.

## What the metrics establish

The exporter reads one read-only PostgreSQL snapshot with a five-second statement
limit. Concurrent scrapes share the current in-flight collection. Failed database
collection returns HTTP 503, never cached success. Platform readiness tracks the
existing broker/replica revocation listener; lost PostgreSQL LISTEN continuity
therefore exports readiness zero. The provisioner counts unexpected tick and
retention failures and records the last sweep whose top-level tasks resolved.
It also measures each in-flight tick with a monotonic clock, so a hung dependency
can alert after 30 minutes even when leases and unrelated retention remain healthy.

Every directory gauge contains only aggregate counts with fixed names. It emits
no tenant/user IDs, emails, phone numbers, provider names, resource identifiers,
SQL errors, tokens, file paths or private content. Identifying affected tenants
requires an authorized operator using the existing directory/runbooks.

Backup status must be from the **current generation**. Snapshot freshness requires
a host-reported snapshot time and a completed catalog backup admitted within the
same threshold. Normally that backup is from the current generation. A completed
image update can retain prior-generation backup evidence only through an explicit
chain of update records preserving the exact current volume; incomplete updates,
restores and different-volume histories cannot grant that lineage. This matches
the host journal, which retains its 23-hour full-backup schedule on a same-volume
image update. Catalog generations are never rewritten to make an alert resolve.
A recent
upload acknowledgement alone cannot hide an old snapshot. Reports are stale after
three minutes; database snapshots are overdue after five minutes and environment
snapshots after 24 hours. Active tenants with no report or completed backup count
as unhealthy. Suspended/deleted tenants do not count toward backup freshness.
An environment snapshot also covers the database. These metadata checks do not
prove remote object durability, decryptability, available disk space or measured
RPO/RTO; scheduled real restore drills remain required.

Host readiness matches machine, generation, desired/observed state and policy
revision, with the same four-minute report window used by the host controller.
Other gauges cover backup/volume cleanup, lifecycle failures and expired leases,
queued actionable lifecycle work five minutes past retry time, recovery/update
operations over 30 minutes, migration reconciliation or phase
inactivity over 30 minutes, host checkpoints over 30 minutes, cloud actions
unobserved for ten minutes, and uncertain provider writes. Terminal operations
do not contribute to pending-operation gauges. Confirmed deleted tenants no longer
contribute historical migration/checkpoint delay counts. A deleting tenant still
does, and an unknown writer remains a safety alert even in deleted metadata.

A successful retention sweep means all top-level retention calls resolved;
individual retired-volume failures are recorded internally and may still be
pending. The overdue-volume gauge remains authoritative for those failures even
when the sweep timestamp advances. A worker's valid lease is not proof of forward
progress. Migration phase timestamps and aggregate alerts support investigation;
they do not attest completed or safe migration.

Directory gauges are repeated on each exporter. Rules use `max by (deployment)`
instead of summing replicas. This conservatively reports any observed unhealthy
snapshot while avoiding multiplication of tenant counts. Local process health
and counters remain per instance. Do not attach tenant labels to scrape targets.
State enums are not emitted as arbitrary metric labels.

Alert `for` durations add grace beyond the metric's age threshold and scrape/
evaluation interval. For example, the database alert fires after the five-minute
threshold remains exceeded for two minutes; it is not a five-minute recovery
guarantee. A persistent aggregate can also reflect different affected tenants
over time. Use scoped operator diagnosis before taking action.

## Operator response and qualification

For backup/storage failures, retain admitted ciphertext and outstanding leases;
inspect storage/IAM, host journals and the catalog. Follow
[recovery operations](tenant-recovery-operations.md). For migration, unknown cloud
effects or provider dispatches, preserve writer holds and reconcile outcomes;
never issue blind duplicate creates/writes or synthesize source-retirement proof.
See [migration boundaries](legacy-migration-implementation.md).

Before accepting monitoring as operational:

1. Validate configuration/rules with the deployed Prometheus version (`promtool
   check config` and `promtool check rules`). From `infra/monitoring`, run
   `promtool test rules swarm-alerts.test.yml`. CI checks the example's syntax and
   the rules with checksum-pinned Prometheus 3.5.0; real secret paths/destinations
   still need validation in the deployment environment.
2. Verify every platform/provisioner replica is scraped and labels match the
   approved inventory. Confirm unauthorized requests fail and metrics contain no
   private data.
3. In disposable staging, interrupt a listener, fail collection and delay backup/
   cleanup work. Observe the expected alert reach the approved on-call destination
   and recover after the fault is resolved.
4. Stop a collector and Alertmanager separately and prove independent detection.
   Record delivery latency, acknowledgement, escalation, and recovery evidence.

Unit/HTTP/PostgreSQL tests and synthetic Prometheus rules are not live alert
delivery evidence. No production resource or real provider account is needed for
those deterministic checks.
