# Swarm public release: prioritized fix and qualification plan

Prepared 2026-11-11. Audited application commit: `7e67b384b6ecccf17f322b61a2a10e4de5a3d1d8`.

**Status: planning complete; remediation and release qualification remain open.** This file specifies what to fix, the order of work, and the evidence required to close each item. Writing this plan does not fix the application or certify a release.

The target is **2,000 registered users, with fewer simultaneously active users**, as confirmed by the owner. Peak concurrency remains unspecified. Use 250 active users steady and 500 during a burst as proposed planning scenarios until the owner accepts or replaces them. Track registered accounts, active users, and running computers separately. Without qualified idle suspension, all 2,000 computers could remain running even when few people are active.

Read this alongside the [full implementation and scaling audit](2000-user-release-prompt.md) and [baseline-to-current change inventory](2000-user-change-inventory.tsv). Finding IDs D01–D23 below refer to that audit. The audit contains the original three-commit baseline, source anchors, architecture, capacity arithmetic and historical evidence.

## 1. Severity and release consequences

These ranks express remediation urgency, not CVSS scores. A confirmed bug, an incomplete feature and missing live evidence are different states.

| Rank | Findings | Why this comes first | Release consequence |
| --- | --- | --- | --- |
| 1 | D01: connected-app approval bypass | Confirmed write actions can be auto-classified as read-only. | Fix and independently review before public exposure of affected action paths. |
| 2 | D09, D21: containment and release provenance | Actual host isolation is unqualified; runtime evidence validation is weaker than the operator verifier. No cross-user breach was demonstrated by the audit. | Do not claim or launch qualified isolated hosting without real containment and accepted image evidence. |
| 3 | D15, D04–D06, D22: backup reliability and sustainability | Confirmed full-backup failure can starve DB backups; cleanup, capacity and disk constraints undermine recovery. | Establish actual recoverability at supported data sizes and churn before relying on backups for public accounts. |
| 4 | D08: legacy migration safety | Complete writer freeze, restore/resume and retirement are unfinished. | Block existing-account cutover until proven; a separately agreed new-account-only launch can proceed without claiming migration complete. |
| 5 | D10: incident response and recovery | Alert delivery, PostgreSQL PITR and operational restore/deletion evidence are incomplete. | Require real drills, on-call ownership and recovery objectives before public operation. |
| 6 | D03: tenant resource budgets | Allowed app/desktop/helper memory ceilings can exceed host RAM. Actual simultaneous consumption has not been measured. | Qualify a supported workload and compatible host/container limits. |
| 7 | D02: platform routing and availability | Tenant tunnel ownership is process-local; another serving replica cannot route to it. | Multi-replica serving requires a fix. A measured single-instance launch requires an explicit availability/maintenance exception. |
| 8 | D17–D19: native linking and account state | Confirmed client/server mismatches reject links or report failure after partial success. | Fix before advertising the affected native account journeys. No account takeover was established by this audit. |
| Cost gate | D07: idle and capacity automation | Fewer active users do not automatically mean fewer billed running computers. | Approve realistic running-host economics; implement safe idle/wake or fund and staff an explicit manual policy. |
| Distribution gate | D12: iOS and Mac release | Build success does not establish signed-device behavior or public distribution. | Complete the actual release requirements for each launching native channel. |

D11, D13, D14, D16, D20 and D23 remain part of this plan even though they were not the eight highest-severity groups.

## 2. Execution rules and first actions

- [ ] Assign a named owner and independent reviewer to each workstream below. The roles listed here are proposed responsibilities, not claims that agents are already assigned.
- [ ] Reconcile current main, open PRs and uncommitted work; refresh the audit if application source has advanced.
- [ ] Record the actual production release, role topology and staging inventory. The last inspected receipt was standalone v27 at `68d5c4d`; current production was not freshly verified.
- [ ] Create a feature matrix for standalone, platform, tenant, hosted CLI, personal bridge, web, iOS and Mac. Identify the launch promise for each.
- [ ] Confirm peak-active workload, running-host envelope, supported account data sizes, recovery objectives, availability, regions and budget.
- [ ] Make focused changes in isolated branches/worktrees. Preserve other owners' work and integrate stable checkpoints against current main.
- [ ] Start the D01 and D15 regressions/fixes immediately. In parallel, prepare containment, recovery, auth-parity and native-test work that does not depend on missing infrastructure.

Use existing authorization and complete independent code work while external inputs are pending. Real provider writes, paid resource creation, production migration/deployment and public publication need the applicable authorization and concrete inputs; this document does not supply them. Keep credentials in protected secret storage.

Preserve current tenant/session/revision checks, credential locks, one-writer fences, upload ownership tokens, permanent admin-bootstrap marker, Mac consent guards, explicit saved permissions and subscription concurrency. Never relax isolation or silently change billing/model selection to make a test pass.

Every workstream is initially **OPEN**. Required closure evidence: focused PR/commit, changed paths, regression results, exact source/image/configuration, independent review where specified, rollout/rollback procedure and updated finding status. Label fixture, source-review, real-provider, device and infrastructure evidence separately.

## 3. R1 — Fix connected-app authorization

**Findings:** D01. **Owner:** security + agent/tool execution. **Dependencies:** none for local implementation; controlled provider accounts for live witnesses.

**Implementation tasks**

- [ ] Add a failing regression for `GITHUB_CREATE_A_CHECK_RUN` and other mutating names containing GET/LIST/SEARCH/CHECK tokens. Show that an unset default policy previously permits the write.
- [ ] Replace substring inference for default authorization with trusted, pinned read/write metadata. Missing, conflicting or stale classification must require approval.
- [ ] Bind approval to the exact account, connection, action, arguments and relevant provider revision. Preserve explicit saved allow/deny policies and current revocation precedence.
- [ ] Review API text tools, native CLI MCP callbacks, onboarding, voice, pending approval/resume, retries and cancellation. Prevent a second dispatch when the first outcome is uncertain.
- [ ] Document browser/shell/desktop consent separately. This work does not require inventing a new approval prompt for every browser or shell action.

**Starting points:** [composio.ts](../server/src/composio.ts), [agent/tools.ts](../server/src/agent/tools.ts), [agent/loop.ts](../server/src/agent/loop.ts), [composio-policy.ts](../server/src/platform/composio-policy.ts).

**Acceptance**

- [ ] Regression fails on the audited implementation and passes after the fix.
- [ ] Unknown/newly discovered connected-app writes do not invoke the provider before approval; approved reads/writes honor explicit policies.
- [ ] Two users, multiple connections, changed arguments, stale approvals, revocation during waits and canceled native callbacks cannot reuse another authorization.
- [ ] Independent review and controlled provider-side witnesses confirm the outcome. Existing setup/read-only tests alone are insufficient.

**Rollout/rollback:** canary action decisions and approval UX with sanitized audit records. Do not roll back by restoring permissive classification; disable an affected integration path if a compatible secure rollback is unavailable.

## 4. R2 — Protect recoverable data and sustain backup cleanup

**Findings:** D15, D04, D05, D06, D22. **Owner:** backup/data/recovery. **Dependencies:** local scheduling/storage fixtures first; R3-qualified host and real KMS/object storage for final drills.

**Implementation tasks**

- [ ] Reproduce repeated full-snapshot failure starving database-only snapshots. Separate their scheduling/progress so a broken profile or pending full upload cannot indefinitely prevent current DB protection.
- [ ] Keep bounded durable journals, per-attempt upload ownership and exact account/generation/checkpoint bindings. Preserve failed-upload evidence and recovery material.
- [ ] Implement fair cleanup with safe claims/leases, deterministic progress through batches and independent retry/backoff. A held backup or failed tenant must not monopolize the first 100 candidates.
- [ ] Measure deletion capacity above the creation rate, including object versions and unfinished multipart uploads. Current nominal arrivals are running-host-count / 4 per minute; 500 running hosts exceed the current ideal 100/minute sweep ceiling.
- [ ] Define one supported envelope for live bytes, files/directories, depth, temporary data and restore space. Align volume-growth policy with it. Current 10,000 GiB volume allowance and 12 GiB bundle ceiling are incompatible.
- [ ] Add free-space preflight and reserve; measure full-backup pause, SQLite staging, encrypted pending data and restore-copy peaks. Jitter schedules and bound transfer concurrency and platform memory.
- [ ] Establish audit retention and prune/archive safely retired catalog/part metadata. Add indexes or partitioning based on measured aged queries, protecting migration/recovery holds.
- [ ] Make snapshot age, oldest pending upload, cleanup age/rate, bytes, disk reserve and failed restore visible and alertable.

**Starting points:** [runtime/backups.ts](../server/src/runtime/backups.ts), [platform/backups.ts](../server/src/platform/backups.ts), [backup.ts](../server/src/platform/backup.ts), [backup-storage.ts](../server/src/platform/backup-storage.ts), [tenant-capacity.ts](../server/src/platform/tenant-capacity.ts), [install-environment.ts](../server/src/runtime/install-environment.ts).

**Acceptance**

- [ ] Invalid profile files, symlinks/special files, full disk, stalled uploads, process restarts and lost acknowledgements do not indefinitely stop fresh DB backups.
- [ ] Old upload attempts cannot acknowledge, clear or overwrite a successor; account deletion and generation changes retain their existing fences.
- [ ] Sustained creation/expiry with aged data drains faster than arrivals, including failures and held backups; metadata queries remain bounded.
- [ ] Restore a real encrypted backup into an unpublished replacement, verify data/owner/hash and fresh readiness, then publish exactly one writer.
- [ ] Test wrong KMS context, revoked keys, corrupt/missing objects, interrupted restore and deletion of all relevant object versions. Failures remain visible and retryable.
- [ ] Meet agreed recovery objectives. Proposed targets are DB RPO at most five minutes, changing full-environment snapshot age at most 24 hours and single-tenant restore within 30 minutes for a specified dataset. These are acceptance proposals, not achieved guarantees.
- [ ] Stopped accounts have a verified checkpoint covering pre-stop changes and durable handling of new external events.

**Rollout/rollback:** test schema/reader compatibility before enabling new schedules; canary a small staged cohort. Retain the last verified recoverable copy. Preserve manifest v1 reads and correct rejection by old readers of unsupported newer formats. Never prune recovery material merely to conceal backlog.

## 5. R3 — Qualify tenant containment and enforce image provenance

**Findings:** D09, D21. **Owner:** infrastructure + runtime security. **Dependencies:** approved staging inventory, image publishing/signing custody, KMS/storage, qualified host.

**Implementation tasks**

- [ ] Refresh actual platform/provisioner/gateway/PostgreSQL resources, TLS, migration/application grants, session-capable LISTEN and scoped secret configuration.
- [ ] Build a compatible host/app/desktop/runner image set; record immutable digests, dependencies, SBOMs and fresh vulnerability scans.
- [ ] Remediate fixable high-risk findings. Any residual exception needs an independent decision, explicit scope, expiry and compensating evidence.
- [ ] Require the evidence digest and reviewer/provenance checks at mandatory release admission, not only in an optional operator verification command.
- [ ] Reject missing, malformed, wrong-image, stale or revoked evidence. A matching URI or green fixture must not stand in for qualification.
- [ ] Run the actual-host containment harness on a host with working cgroup domain controllers and all required limits. Check CPU/memory/PIDs/swap, namespaces, seccomp, filesystem mounts, IPv4/IPv6, metadata endpoints and private-network isolation.
- [ ] Attempt cross-tenant access from a deliberately compromised synthetic workload. Keep Fly/KMS/project keys out of app, desktop and runner containers.

**Starting points:** [release-policy.ts](../server/src/platform/release-policy.ts), [release-gates-cli.ts](../server/src/platform/release-gates-cli.ts), [image tooling](../infra/tenant-host), [qualification harness](../infra/tenant-host/qualification/README.md).

**Acceptance**

- [ ] Two real staged tenants cannot read, impersonate, connect to or mount each other's protected resources.
- [ ] The exact images admitted are the images built, scanned, reviewed and exercised. Runtime/provider behavior matches the declared control guarantees.
- [ ] Failed enforcement or invalid provenance prevents readiness/activation. Limits are never relaxed to manufacture a pass.
- [ ] An independent security assessment covers the deployed boundary and reports no unresolved in-scope critical/high findings.

**Rollout/rollback:** promote signed digests through staged canaries; retain a compatible qualified image set. A rollback must not reactivate a revoked or unqualified image.

## 6. R4 — Make incidents detectable and recovery demonstrable

**Finding:** D10. **Owner:** operations/SRE + database. **Dependencies:** owner-selected alert destination and on-call contacts; R2/R3 infrastructure for final recovery drills.

- [ ] Deploy authenticated collectors, central metrics and alert routing; include independent detection of collector/notification failure.
- [ ] Add latency/error denominators, PG waits, tunnel pressure, lifecycle backlog, backup age/cleanup, disk pressure, provider throttling and cost indicators.
- [ ] Keep credentials, message contents and unbounded tenant labels out of telemetry; provide a separately authorized account-level diagnostic path.
- [ ] Verify managed PostgreSQL backup/PITR capabilities through an actual restore to a separate target. Exercise application and LISTEN recovery after failover.
- [ ] Run tenant restore, account deletion and storage interruption drills; measure actual lost-data window, recovery time, pause and temporary disk.
- [ ] Agree a separate fleet-outage scope and recovery objective: affected registered accounts, running computers, data volume, required service restoration order and fleet RTO. Set safe restore concurrency against cloud API, storage, KMS, PostgreSQL and control-plane limits.
- [ ] Document detection, acknowledgement, escalation, user communication, credential revocation, containment, recovery and post-incident reconciliation.

**Acceptance:** injected failures deliver, escalate and resolve real alerts; an operator can recover using the runbook; directory recovery and tenant SQLite recovery are each demonstrated; unavailable monitoring is itself detected. Agree monthly availability, recovery objectives and support coverage.

**Fleet-recovery acceptance:** staged multi-tenant recovery measures sustained restore throughput, retries, resource headroom and end-to-end completion at the approved outage scope. Supply raw evidence and a justified completion estimate for the affected population; mark any extrapolation separately from directly tested scale. A single successful 30-minute tenant restore does not establish fleet RTO. Use controlled staging drills, not destructive production tests.

**Starting points:** [tenant-monitoring.md](tenant-monitoring.md), [tenant-recovery-operations.md](tenant-recovery-operations.md), [operations-metrics.ts](../server/src/platform/operations-metrics.ts), [monitoring configuration](../infra/monitoring).

## 7. R5 — Finish legacy cutover, or explicitly exclude it from initial launch

**Finding:** D08. **Owner:** migration/data. **Dependencies:** reviewed source topology and enforceable maintenance decision; qualified target/recovery from R2/R3.

- [ ] Inventory exact source app/machine/image/volume/database/files/CLI roots, local and remote writers, pending starts and shared-data ownership.
- [ ] Choose and implement a source-wide maintenance pause or a demonstrably enforced per-account boundary. Block new work before draining existing work.
- [ ] Observe every relevant writer stopped; take and bind the source checkpoint, inventory digest, file copy and credential ownership evidence.
- [ ] Integrate target transfer/install, fresh readiness, routing activation and a single authoritative writer throughout cutover.
- [ ] Complete source record/file restoration, reverse credential preparation, routing rollback and lost-resume reconciliation.
- [ ] Require explicit source-retirement proof and retention policy before source deletion. Re-link unknown or ambiguously owned credentials rather than guessing.

**Acceptance:** real staged migration/rollback/deletion survives crashes before and after every transition, repeated requests, delayed responses and an attempted late writer without diverging data or two active writers. Database-only, current-process-only or desktop-stop receipts do not close the source-wide freeze gate.

**Starting points:** [legacy-migration-implementation.md](legacy-migration-implementation.md), [migration-coordinator.ts](../server/src/platform/migration-coordinator.ts), [legacy-process-drain.ts](../server/src/platform/legacy-process-drain.ts), [legacy-cloud-drain.ts](../server/src/platform/legacy-cloud-drain.ts).

**Launch alternative:** document a new-account-only release with an explicit existing-user service and migration/relink policy. Do not label migration complete under that alternative.

## 8. R6 — Set safe resource budgets and operating economics

**Findings:** D03, D07. **Owner:** runtime/capacity. **Dependencies:** R3 actual-host measurements; R2 backup/storage envelope; agreed workload and budget.

- [ ] Capture trusted host/container CPU, RSS/pressure, PIDs, file descriptors, disk, startup and backup peaks with current machine/generation ownership and sample freshness.
- [ ] Measure 1/2/4/8 helpers, multiple Bots, browser/desktop overlap, local MCP and hosted CLI. Choose compatible guest and container limits with host overhead and recovery reserve.
- [ ] Preserve advertised subscription concurrency; do not hide resource errors by imposing new account-wide generation queues. State the existing API-mode ordering/64-job bound separately.
- [ ] Implement durable capacity decisions, cooldowns, notification, spending/storage ceilings and safe replacement/growth, or define a staffed measured manual process.
- [ ] Implement isolated idle-stop/wake if the economics depend on it. Account for active streams, viewers, CLI, tools, routines, messaging, pending writes and backup work.
- [ ] Make wake durable and idempotent across external events, scheduled work, restarts and provider delays; prevent accepted work from disappearing during sleep transitions.
- [ ] Confirm Fly inventory/API/regional quotas, including recovery and rollout spares, separately from running-machine quotas.
- [ ] Reprice compute, persistent volumes, stopped rootfs, PG, storage requests/versions, KMS, transfer, providers, voice and support. Connecting a subscription does not fund these costs.

**Acceptance:** supported workloads avoid unexplained OOMs; pressure failures are contained and visible; resizing/wake preserves ownership and accepted jobs; measured average/peak running computers and cost meet the approved envelope. Do not claim idle savings until computers actually stop safely.

**Starting points:** [fly-tenants.ts](../server/src/platform/fly-tenants.ts), [runtime/host.ts](../server/src/runtime/host.ts), [container-policy.ts](../server/src/runtime/container-policy.ts), [tenant-capacity-operations.md](tenant-capacity-operations.md).

## 9. R7 — Remove routing and shared-service bottlenecks

**Finding:** D02; associated polling, pool, streaming and worker limits. **Owner:** platform/control plane. **Dependencies:** agreed availability; deterministic tests can precede R3 staging.

- [ ] Implement tenant connection ownership discovery and forwarding with leases/fences, bounded internal authentication, stale-owner handling and safe reconnect.
- [ ] Prove load-balancer behavior for HTTP, SSE, viewer and companion traffic across multiple serving replicas.
- [ ] Preserve authoritative session/connection revocation and failure on lost notification guarantees; avoid stale-cache authorization.
- [ ] Add aggregate connection, byte and queue budgets with backpressure. Measure copies/base64 framing and slow-consumer behavior alongside per-tenant request limits.
- [ ] Measure five-second host/event polling, heartbeats, KMS refresh and per-stream authorization; reduce/batch/jitter only while retaining freshness guarantees.
- [ ] Budget PostgreSQL pools and timeouts across platform, provisioner, gateway, migrations and operations. LISTEN requires a compatible direct/session connection.
- [ ] Add fair worker scheduling so onboarding/lifecycle backlog cannot indefinitely delay recovery/update. Qualify provisioning bursts and retries under actual Fly limits.

**Acceptance:** two replicas route tenants connected to either; process loss, ownership split, listener failure, reconnect storms and rolling deploys produce bounded recoverable errors without foreign routing or unsafe duplicate effects. Memory/queues and PG waits remain within the measured budget.

**Starting points:** [tunnel.ts](../server/src/platform/tunnel.ts), [directory.ts](../server/src/platform/directory.ts), [provisioner.ts](../server/src/platform/provisioner.ts), [platform manifest](../infra/platform/fly.platform.toml).

**Limited-launch option:** a measured single-serving-instance release needs an explicit availability/maintenance exception. Do not enable another replica before routing correctness is established.

## 10. R8 — Repair account linking and isolated product parity

**Findings:** D16–D20, D23. **Owner:** auth/product/runtime. **Dependencies:** local regressions first; R3 roles and R9 accounts for full integration; R10 signed clients.

| Finding | Implementation tasks | Required proof |
| --- | --- | --- |
| D17: native Google linking | Preserve link intent with an authenticated account/session-bound exchange in each supported role; prevent email-based account merging. | Phone/Apple account links Google; collisions, changed/revoked sessions, cancellation and replay are safely handled. |
| D18: native Apple/OpenRouter session binding | Carry and revalidate the initiating session through native completion. Reconcile OpenRouter linking/key delivery that may succeed before the final exchange reports failure. | Success, expiry, revocation, retry/cancel and partial success preserve the intended account and report truthful state. Do not weaken the server's session checks. |
| D19: Google status/disclosure | Align standalone/platform auth responses, including googleLinked, and render consent text for actual OIDC versus Gmail-backed configuration. | Correct linked/unlinked state after refresh/restart/link/delete; disclosures match requested scopes. |
| D16: Library/desktop exchange | Implement a narrow owner-bound transfer or mount path and truthful save_file paths; support inputs and downloadable outputs. | Upload → desktop use → Library download works; path traversal, symlink escape, revocation and foreign access fail; app database/credentials remain outside the share. |
| D20: isolated voice | Choose shared platform-mediated voice or explicit per-user voice keys. For shared voice, implement scoped authorization, usage/quota and revocation while keeping the key outside tenants. | The advertised new-user voice journey works with correct billing attribution and no secret distribution or silent fallback. |
| D23: private direct-key models | Use the same owner-bound key/base-URL contract for save/select, model discovery and inference. | Two tenants, rotation/revocation, empty/error catalogs and selected-model inference work without cross-user keys or fallback charges. |

**Starting points:** [AppModel.swift](../apple/Swarm/AppModel.swift), [native-auth.ts](../server/src/native-auth.ts), [platform/auth.ts](../server/src/platform/auth.ts), [AppSettings.tsx](../web/src/components/config/AppSettings.tsx), [voice-provider.ts](../server/src/lib/voice-provider.ts), [routes-models.ts](../server/src/routes-models.ts), [lib/llm.ts](../server/src/lib/llm.ts), [runtime/host.ts](../server/src/runtime/host.ts).

**Rollout/rollback:** canary by explicit role/provider/client matrix. Preserve account identities and durable link state across retries and rollback. If a journey is excluded from initial scope, remove the corresponding launch promise rather than presenting a broken control.

## 11. R9 — Qualify providers and measure task latency

**Findings:** D11, D14. **Owner:** integrations/CLI + performance. **Dependencies:** controlled accounts/subscriptions and witness services; R1 authorization; R3 isolated path; R8 parity fixes.

- [ ] Test real Claude/Codex login, profile reuse, exact selected models/efforts/images and the newest native MCP tool loop on hosted and bridge paths.
- [ ] Use two tenants and multiple provider accounts for one tenant. Exercise explicit/default connection selection, OAuth refresh, expiry, provider-side disconnect/revocation, pending approvals and canceled actions.
- [ ] Verify Google modes, Apple/OpenRouter, custom MCP and each advertised messaging channel, including attachment/audio and replay behavior.
- [ ] Confirm provider hosted-use support, quotas and rate limits. Missing quota information must stay unknown; show partial/unavailable usage honestly and prohibit hidden API fallback.
- [ ] Instrument admission, wake, catalog, model first-event, tool, approval wait, provider response and final text times. Report p50/p95/p99 by warm/cold, provider/model/effort and workload.
- [ ] If incremental assistant text is part of the launch promise, implement and test it through every CLI transport; otherwise disclose buffering and still meet agreed responsiveness targets.

**Acceptance:** independent provider-side identity/outcome witnesses show the correct account and authorized action; failures do not duplicate uncertain writes or change billing sources. Fixtures remain separate from live evidence. Real task latency and provider constraints meet the approved contract.

**Starting points:** [provider-qualification.md](provider-qualification.md), [cli-native-mcp.md](cli-native-mcp.md), [native-tools.ts](../server/src/cli/native-tools.ts), [tool-callback.ts](../server/src/cli/tool-callback.ts).

## 12. R10 — Finish public iOS and Mac delivery

**Finding:** D12. **Owner:** Apple/release. **Dependencies:** R8 linking, approved backend/version/build, protected signing inputs and physical-device testers.

- [ ] Run the iOS XCTest target in CI; the current Apple test command selects only the Mac scheme. Keep existing Mac lifecycle/consent tests.
- [ ] Provide a repeatable signed iOS archive/export/upload path; produce and test the exact TestFlight candidate.
- [ ] Test supported iPhone/iPad and Mac devices: Apple new/returning/Hide My Email/link/delete, configured provider returns, microphone/audio routes, Action Button, files, cold start/resume and offline recovery.
- [ ] Test same-account phone-to-Mac pairing, screenshots/input, denial/revocation, cancellation, Stop/Disconnect/logout and preservation of an explicitly attached existing browser.
- [ ] Configure the protected Mac release environment and use the reviewed Developer ID/profile/hardened signing/notary/staple/Gatekeeper workflow. Keep runtime smoke credential-free.
- [ ] Download the actual release with quarantine intact and test installation/upgrade/auth/permissions on each advertised architecture.
- [ ] Complete App Store privacy, account-deletion evidence, screenshots, support/privacy URLs, reviewer access and actual pricing/payment disclosures; obtain approval.
- [ ] Publish a public versioned Mac ZIP/checksum location and retain compatible rollback assets. A private repository asset is not public delivery.

**Acceptance:** receipts identify client build, source, architecture, backend and configuration; iOS approval and actual Mac notarized distribution are complete for the launching channels.

**Starting points:** [apple.sh](../scripts/apple.sh), [Apple workflow](../.github/workflows/apple.yml), [Mac release workflow](../.github/workflows/release-mac.yml), [mac-distribution.md](mac-distribution.md).

Push, offline chat, background voice and a custom Mac updater can remain explicit v1 limitations if they are not promised. iOS is a hosted client, not a local iOS desktop companion.

## 13. R11 — Reconcile instructions, economics and launch promises

**Finding:** D13; remaining product/operating limits. **Owner:** release coordinator + product.

- [ ] Replace stale current-state claims about staging, old population targets, MCP support and production signing. Preserve historical receipts with their original scope.
- [ ] Link public Mac signing instructions to the reviewed workflow; distinguish simulator build, development signing, ad-hoc dry run and actual distribution.
- [ ] Document API/subscription concurrency differences, single physical-desktop control, login burst bounds, MCP/folder/routine limits, SSE reconnect behavior and supported data sizes.
- [ ] Agree whether paid hosted compute is launching. If so, implement/test payment, entitlement, cancellation/refund and spending policy; usage reporting alone does not provide these.
- [ ] Agree voice funding, supported providers/models, availability, support coverage, retention/deletion and existing-account migration policy.
- [ ] Keep one live readiness record that maps each finding to open/fixed/qualified/explicitly accepted with PR, evidence, owner and date. Accepted limitations must specify affected users and expiry/review conditions.

**Acceptance:** product promises match tested behavior, instructions execute on the candidate, current infrastructure/cost statements have dated evidence, and no historical fixture is represented as a current production pass.

## 14. Dependency order and final qualification

1. **Establish source and contracts:** source/inventory reconciliation, R11 launch scope, workload/data/availability/budget decisions.
2. **Start independent fixes:** R1 approval, R2 scheduling/cleanup, R8 role parity, R10 iOS tests; prepare R3 images and actual-host qualification.
3. **Establish the staged foundation:** R3 containment/provenance and R4 observability; perform actual resource measurements for R6 and staged routing tests for R7.
4. **Prove user journeys and recovery:** R2/R4 real recovery, R8/R9 real providers, R10 signed clients. Run R5 migration only after source topology and target enforcement are qualified.
5. **Run the population/workload qualification:** representative aged accounts, agreed concurrent activity, background work, failure injection and rollout/rollback.
6. **Promote a qualified candidate:** independent review, evidence manifest, native/store gates, approved release decision and staged production rollout.

For 2,000 registered users, the final qualification must include:

- [ ] Representative account identities, aged databases, files/profiles, subscriptions and permissions across the full population; synthetic directory rows alone are insufficient.
- [ ] One real contained tenant, then two mutually hostile synthetic tenants, before broader ramp.
- [ ] Proposed active-user ramp 25 → 100 → 250 and proposed burst 500, replaced by the approved contract before execution. Record running computers continuously and rotate activity across accounts.
- [ ] A 24-hour soak at the agreed workload; extend aging tests beyond retention/recurrence windows where needed.
- [ ] Cold wakes, routines, messaging, viewer/device mix, slow consumers, backup/cleanup, login/refresh surges and provider throttling.
- [ ] Platform/worker/tenant crash, PG/LISTEN loss, delayed/duplicate responses, interrupted storage, disk/memory pressure and revocation during actions.
- [ ] Staged fleet recovery at the R4-approved outage scope, with measured restore throughput/concurrency and a supported fleet completion estimate.
- [ ] Signed compatible image rollout, schema compatibility, rollback, account deletion, retirement where applicable and complete test-resource/cost reconciliation.

**Proposed acceptance thresholds to agree:** zero cross-account access or unauthorized connected-app dispatch; all acknowledged jobs accounted for without duplicate unsafe writes; p95 authenticated control operations under 500 ms; p95 warm task admission under two seconds; under 1% unexpected platform failures for each specified steady workload; the R2 recovery objectives; stable queues/cleanup with measurable headroom; no unexplained OOMs; cost inside budget. External model latency, cold startup and expected policy/provider refusals must be reported separately, not hidden.

Budget connection pools, polling, tunnel buffers, backup bandwidth, per-account SQLite growth and provisioner/recovery fairness as part of this test. Passing at 250 active users does not prove every running-host envelope, and 2,000 idle accounts do not establish active capacity.

Beyond the initial population, prioritize safe multi-replica/cell routing, bandwidth-heavy transfer separation, fair durable workers, PostgreSQL aging/partitioning where measured, economical idle/capacity policies and qualified regional/provider failover. Each expansion needs updated quotas, costs and evidence.

## 15. Inputs, validation and closure record

The following external inputs must have named owners; they are not requests to paste secrets into chat:

| Input/decision | Unblocks |
| --- | --- |
| Agreed active/running-host profile, data sizes, single-tenant and fleet recovery objectives, availability, budget and test spend ceiling | R2, R4, R6, R7 and final workload qualification |
| Fresh Fly organization/region/inventory/quota evidence and qualified staging host | R3, R6, R7 |
| KMS/IAM and scoped versioned object storage; supported credential/endpoint design | R2/R3/R4; an alternative storage provider is not automatically a configuration-only replacement |
| Managed PG TLS, application/migration roles, direct/session LISTEN and real PITR access | R3/R4/R7 |
| Image signing custody and vulnerability policy | R3 |
| Controlled provider identities/subscriptions, OAuth/Inkbox/Composio configuration and witness fixtures | R8/R9 |
| Legacy source topology, writer ownership and maintenance/retirement decision | R5 |
| Alert destination, on-call coverage and incident contacts | R4 |
| Apple signing/profiles/notary access, physical testers, public URLs and approved build/backend | R10 |
| Pricing, payment/voice funding, retention, support and scope exceptions | R6/R10/R11 |

Use existing regression suites as a foundation, adding tests that reproduce each substantive defect. On a clean candidate with locked dependencies:

```bash
npm ci
npm run typecheck
npm run build
npm run test:deployment
npm run test:cli
npm run test:composio
npm run test:models
npm run test:google-auth
npm run test:apple-auth
npm run test:native-auth
python3 -m unittest discover -s scripts/mac-release -p 'test_*.py' -v
node --test tests/provider-qualification.test.mjs
```

Run `npm run test:isolation` with `TEST_DATABASE_URL` pointing only to an explicitly disposable PostgreSQL database. Existing suites include backup lifecycle/upload/storage, migration, tenant capacity, release gates, sessions, platform native auth and operations. Test the relevant changed paths first, then run the integrated candidate suites. Xcode/device tests need macOS and the appropriate devices; actual provider/storage/containment/load qualification needs its separately scoped environment.

The original audit recorded passing typecheck/build, 211 CLI tests plus hosted/bridge HTTP fixture smoke, and 90 selected auth/app/deployment tests. These are baseline receipts, not evidence that the fixes in this plan exist. This planning task adds no new application test result.

**Required traceability:**

| Finding | Closure workstream |
| --- | --- |
| D01 | R1 |
| D02 | R7 |
| D03 | R6 |
| D04 | R2 |
| D05 | R2 |
| D06 | R2 |
| D07 | R6 |
| D08 | R5 |
| D09 | R3 |
| D10 | R4 |
| D11 | R9 |
| D12 | R10 |
| D13 | R11 |
| D14 | R9 |
| D15 | R2 |
| D16 | R8 |
| D17 | R8 |
| D18 | R8 |
| D19 | R8 |
| D20 | R8 |
| D21 | R3 |
| D22 | R2 |
| D23 | R8 |

For each row retain: implementation status, PR/commit, reviewer, fixture result, required live/device result, exact image/configuration, remaining limitation, rollout/rollback action and closure date.

The final GO decision requires closed in-scope security/data-integrity defects, qualified advertised user journeys, real containment/recovery/alert evidence, approved capacity/cost results, applicable native distribution approval and an accountable release owner. If a gate is unresolved, report the exact blocked capability and continue independent work. Completion of this document is not completion of those gates.
