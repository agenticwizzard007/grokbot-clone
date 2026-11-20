# Swarm: full product completion specification

**Delivery plan · 11 November 2026 · Reviewed source `41ed36debc71a2e72d6817ed1f22f7e036e827dc`**

> **Objective: bring all 12 scored feature areas to 100% of their defined scope and finish the shared systems required to operate the complete paid product.** Completion requires working implementation, correct integration, safe failure behavior, and evidence from the actual shipping configuration. Writing this document does not change a feature's score or close a release gate.

This document turns the [commercial-readiness scorecard](commercial-readiness.md) into an execution specification. It contains 19 delivery packages: seven shared platform packages and 12 feature packages. Each package defines implementation requirements, acceptance cases, dependencies, source starting points, and the evidence needed for closure. The accompanying requirement tracker and gap map make every original missing-work bullet traceable.

## 1. What 100% means

### The completion boundary

The full product includes persistent teammates and memory; team coordination; API/OpenRouter and supported Codex/Claude subscription execution; supported local/cloud computers; connected apps and custom MCP tools; action permissions; routines/events; voice; messaging; tasks/files; web/Mac/iPhone/iPad clients; and usage/administration. Shared production hosting, recoverability, billing, support, privacy/retention execution, release delivery, and the migration capability described below must also be complete.

The target is a finite, published support matrix. “All apps” cannot mean every operation in every third-party catalog has been validated. Publish exactly which providers, models, integrations, device versions, data sizes, and workloads are supported. Catalog availability and supported production behavior are different claims.

The full-score plan retains the standalone and isolated-hosted paths, both official subscription CLIs, API access, the named native platforms, and the advertised voice/messaging channels. A restricted pilot can precede this outcome, but cannot silently replace it. Unsupported combinations must be visibly unavailable and documented; any removal from the scored scope requires a versioned scope decision and a revised scorecard.

### Conditions for awarding a full score

- Every mandatory requirement for the feature has an implementation or a demonstrated existing implementation that satisfies it.
- Every included account/provider/computer/client combination has the applicable acceptance evidence. A supported hosted path cannot borrow a standalone result.
- Known authorization, ownership, data-loss, billing, and correctness defects affecting the feature are closed. A high average cannot compensate for an open critical gate.
- Failure, cancellation, revocation, restart, recovery, and operator support are usable and tested for the supported scope.
- Customer-facing controls, status, errors, limits, documentation, and charges agree with actual behavior.
- Performance, quality, workload, cost, and recovery results meet a recorded acceptance contract on the release candidate.
- A named feature owner and an independent reviewer sign the evidence record. A test skip, simulation, or missing provider receipt is not a live pass.

The previous 40/20/20/20 rubric remains: core capability/usability, integration/deployment coverage, safeguards/recovery, and live validation/operability. A feature reaches 100 only when all four components satisfy their scope. Completion percentages are assessment scores, not time estimates or probabilities of safe launch.

### Optional extensions

Push notifications, offline chat, background voice, an automatic Mac updater, MCP resources/prompts, and enterprise organization features were not part of the previous full-score denominator. Section 10 defines their additional completion work so they are not forgotten. They remain separately tracked unless the product promise explicitly expands to include them.

## 2. Refreshed baseline: preserve what has already landed

The earlier scores and 153 missing-work bullets were assessed against `7e67b384b6ec`. The final reviewed baseline is `41ed36debc71`, with 35 changed paths from that original assessment; the core policy/voice/CLI review was performed at its ancestor `4c6efab9bf37`. A separate configuration snapshot, `0f78906c18a3`, was also inspected and tested while it was checked out. Its instruction-editor changes are not present in `41ed36debc71`; they are recorded as available integration work, not credited to the final baseline. Do not reopen a resolved implementation merely because an older plan calls it missing. Conversely, a merged change is not evidence of full production qualification.

| Area | Refreshed observation | Remaining completion treatment |
| --- | --- | --- |
| App approval defaults | The active chat execution path now calls `executionPolicyFor`, which uses exact connection/revision-bound provider metadata for `SWARM_APPS_EXECUTE`; dispatch retains a read-only constraint. | Preserve the fix. Complete path/reachability review and live witnesses. The old slug classifier still exists in the lower-level helper; its presence alone no longer proves the active path bypasses approval. |
| Voice execution | App work is routed through chat; stable tool-call IDs, durable assignment ordering, and stale direct-call refusal are implemented. | Validate the full live microphone → assigned agent → approval → actual result workflow and interrupted outcomes. |
| Speech/transcription | Routing/fallback behavior and unsupported-audio normalization were revised. | Verify real supported audio formats, billing source, privacy boundaries, and channel/device behavior. Do not undo intentional configured speech routing while preserving text-model billing rules. |
| Native CLI tools | Manifest integrity, browser capability exposure, failure propagation, and ownership checks for helper/routine controls were improved. | Retain the fixes and qualify the actual installed provider/runtime combination. |
| MCP capacity | Discovery enforces a 448-custom-tool budget per Bot, reserving 64 slots within the 512-tool runner limit; excess is rejected rather than silently truncated. | Validate upgrades, assignment changes, disabled servers, and real large manifests. |
| Google sign-in | Authentication restoration/cleanup changes are present. | Treat ordinary sign-in separately from the still-unfinished native linking/session contracts. |
| Teammate configuration, separate snapshot | In `0f78906c18a3`, responsibilities, execution settings, and generated files have separate views, with conflict-aware instruction editing and an owner/revision-checked prompt preview. These changes are absent from the final `41ed36debc71` baseline. | Integrate and revalidate the reviewed controls if adopted in the selected release. Qualify cross-device persistence, lifecycle, accessibility, and the complete customer workflow. A prompt preview is not proof of live task quality. |
| CLI bridge pairing | The final baseline rejects generated secrets with a leading dash, preventing the bridge option parser from treating a token as a new flag. | Preserve the correction and qualify real pairing/reconnect and credential revocation with the installed bridge. |
| Backup, files, model/voice parity, native linking, image admission, platform routing | The specific source paths underlying the earlier findings were unchanged in the inspected comparison. Source spot-checks still show the full-backup-first scheduler, private direct-key catalog mismatch, tenant-private voice selection, and single-serving-process routing constraint. | Continue the implementation work described below; refresh again at execution time. |

**Fresh local verification:** 63 tests passed, with zero failures or skips, across app policy, CLI app execution, CLI manifests/integrity/browser capability, MCP capacity, speech routing, and voice assignment queues. These use controlled fixtures and temporary state. They do not establish deployed production behavior, live provider permissions, signed-device behavior, or fleet capacity. The exact command appears in section 11.

The separate teammate-configuration review ran `tests/bot-creation.test.mts` against `0f78906c18a3`: **16 passed, zero failed, zero skipped**, including prompt-preview ownership and stale-edit conflict tests. These are receipts for that separate snapshot, not evidence that its controls are integrated into `41ed36debc71`. The final baseline's pairing-token regression also passed: **one test, no failures or skips**. None of these runs is a full application or browser/device test run.

Historical feature scores are retained only as the starting assessment: F01 70; F02 60; F03 65; F04 60; F05 65; F06 50; F07 65; F08 50; F09 65; F10 50; F11 60; F12 65. This document does not perform an unsupported numerical rescore after the recent changes.

## 3. Acceptance contract and decisions to close

The following are **proposed engineering acceptance targets**, not measured results or approved customer guarantees. They make the work concrete. The product/release owner must record the final values before qualification; changes require a dated rationale and re-evaluation of affected tests, costs, and claims.

| Contract item | Proposed starting target / decision required | Required record |
| --- | --- | --- |
| Population and active load | 2,000 registered/provisioned accounts; 250 active steady and 500 active during a 15-minute burst, followed by a 24-hour steady soak. Active numbers remain proposals inherited from planning. | Account count, task arrival rate, viewing mix, model/tool mix, background activity, and the separately measured running-host count. |
| Running-host exposure | Qualify the normal costed envelope and a controlled all-provisioned-host sensitivity case. Never assume that 250 active people imply 250 billed computers. | Running hours, stopped/rootfs/volume costs, provider quotas, wake rate, and an explicit maximum spend envelope. |
| Busy-account concurrency | Exercise one, two, four, and eight overlapping helpers plus browser/desktop work and backups; record which workload is supported at each machine size. | Actual peak memory/CPU/disk/PIDs and admission/resize behavior. Do not hide failures with an unadvertised subscription-generation queue. |
| Interactive feedback | Visible request acknowledgement within one second at p95; durable warm task admission within two seconds at p95; routine metadata APIs within 500 ms at p95. | Define timing start/end points and exclude long-poll/stream duration from ordinary API latency. Report p50/p95/p99 and error denominators. |
| Cold readiness | Proposed p95: stopped-host wake to usable task execution within 60 seconds; newly provisioned account ready within 180 seconds. | Include platform routing, app, companion, browser, and provider startup; show failures and retries separately. |
| Task correctness | At least 95% correct completion on each declared reference task class; 100% truthful success/failure/uncertain labeling; no unauthorized effects in the security matrix. | At least 100 controlled runs per declared profile/task class for the acceptance set, with independently checked results and per-profile reporting. Report confidence/coverage limits. |
| Task duration | Define a budget per task class; use ten minutes excluding explicit human waits as an initial budget for the reference workflow. | End-to-end time and stage timings including model effort, downstream APIs, computer work, and queue/wake. |
| Data envelope | Initial qualification dataset: up to 1 GiB database plus 4 GiB protected files/profiles, 10,000 inventory entries, depth 32. Broader support needs its own measured envelope. | Accepted upload limits, live/profile bytes, snapshot bytes, directory counts, pending uploads, restore scratch, volume size, and required free-space reserve. The existing 10 GiB default volume is not proof that this envelope fits. |
| Recovery | Database RPO at most five minutes; changing full-environment snapshot age at most 24 hours; one-tenant RTO at most 30 minutes for the qualified dataset. | Actual lost-data window, end-to-end restore time, ownership/readiness checks, and user-visible interruption. |
| Fleet recovery | Define priority accounts and outage scope. Planning proposal: 500 affected priority accounts usable within four hours and 2,000 within 24 hours. | A measured multi-tenant restore rate and justified extrapolation; label extrapolation separately from directly tested volume. |
| Availability and response | Proposed service target 99.9% monthly; critical alert delivered within five minutes and acknowledged within 15 minutes by the designated coverage team. | Coverage, exclusions, maintenance policy, escalation, independent monitoring failure detection, and support commitments. |
| Unit economics | Positive contribution margin for every sold plan at its stated workload, plus a proposed 60% target at reference usage. | Current vendor quotes and measured compute/storage/model/voice/messaging/connector/support/payment costs; owner-selected prices and subsidies. |

**DEC01 — Product and support matrix:** name supported execution modes, providers/models/efforts, integrations/actions, messaging channels, browsers/OS/architectures, locales, task classes, and device behavior.

**DEC02 — Funding:** choose platform-funded versus customer-owned text, voice, computer, and messaging services. Document permitted transcription fallback separately from text-model no-fallback rules. Identify the responsible commercial provider-account owner.

**DEC03 — Quality and timing:** adopt or replace the proposed task-quality, responsiveness, cold-start, and task-duration targets. Publish how buffered answers and human waits are handled.

**DEC04 — Data and recovery:** select the supported data envelope, retention/deletion/export rules, one-tenant and fleet recovery targets, and backup/restore reserve policy.

**DEC05 — Billing:** select payment provider, currencies/markets, plan catalog, trial/usage policy, taxes/invoices, proration, grace periods, refunds, and cancellation timing.

**DEC06 — Capacity and budget:** record the active/running-host profile, geography, quotas, availability topology, machine/container budgets, and test/operating spend limits.

**DEC07 — Permissions:** document saved-permission scope/lifetime, sensitive computer access, and the exact authorization/revocation contract; retain current deliberate grants and deny precedence.

**DEC08 — Scheduling and delivery:** choose missed-run/catch-up policy, quiet/notification behavior, channel opt-out rules, and handling of uncertain external effects.

**DEC09 — Release and support:** assign named implementation owners, independent reviewers, on-call/support coverage, release authority, signing custody, and distribution URLs.

**DEC10 — Migration and extensions:** record legacy source inventory and cutover needs, and which section-10 extensions join the formal product promise. A new-account pilot does not certify existing-account migration.

## 4. Shared platform packages

These packages supply capabilities used by several features. Complete each dependency once and link its evidence to all affected features. They are not optional just because a UI is working.

### S01. Trusted hosting, identity, and release admission

**Owner role:** platform/security. **Dependencies:** DEC01, DEC06, DEC09. **Starting state:** foundations implemented; real deployment/containment and mandatory provenance qualification remain open. **Sources:** [host runtime](../server/src/runtime/host.ts), [platform auth](../server/src/platform/auth.ts), [image admission](../server/src/platform/release-policy.ts), [qualification harness](../infra/tenant-host/qualification/README.md).

- **S01-R01 — Reconcile the actual deployment.** Record exact source, platform/provisioner/gateway/tenant roles, regions, PostgreSQL endpoint/grants, KMS/storage resources, TLS origins, image digests, runtime versions, and secret ownership. Refresh health/readiness against that inventory; development environment files do not constitute production setup evidence.
- **S01-R02 — Enforce image provenance at admission.** Make required image/evidence digest, reviewer, authorization state, freshness/revocation policy, and exact-image matching mandatory on creation, update, and restore. Reject missing/malformed/stale/revoked evidence. Preserve approved rollback images and a documented compatibility rule.
- **S01-R03 — Prove containment on the real boundary.** Exercise non-root/read-only/capability/seccomp/cgroup/PID/memory policies, mounts, IPv4/IPv6, metadata access, and private networks on actual host images. Use two distinct tenant applications/volumes/networks and a deliberately compromised synthetic workload. Never disable enforcement to obtain a pass.
- **S01-R04 — Complete identity and revocation propagation.** Revalidate owner, session, generation, connection revision, and computer grant at admission/dispatch. Prove logout, session expiry, account deletion, and key revocation close relays and reject stale requests even across platform processes or reconnects.
- **S01-R05 — Keep trust boundaries explicit.** Platform/Fly/KMS/project credentials remain outside tenant app/desktop/runner containers. Use scoped short-lived delivery where required, encrypted persistent account secrets, restricted egress/file access, and redacted operational diagnostics.
- **S01-R06 — Exercise platform dependency failure.** Test PostgreSQL failover/LISTEN loss, KMS unavailability, interrupted provisioning, stale readiness, and delayed cloud responses. Fail closed for authorization uncertainty, reconcile resource outcomes, and publish a tenant only after fresh verified readiness.

**Acceptance cases**

- **S01-A01:** tenant A, including compromised workload root, cannot read/use tenant B's data, identity, network, tools, terminal, or viewer; host/platform credentials are inaccessible.
- **S01-A02:** invalid/revoked/wrong-image qualification cannot activate a runtime; an accepted image and its archived evidence match the exercised build.
- **S01-A03:** session/directory/KMS/provider failures trigger the expected refusal or recovery with no stale authorization window beyond the recorded contract.

**Closure evidence:** immutable image/SBOM/scan records, independent security review, source/configuration receipts, real two-tenant containment results, and deployment/rollback runbooks.

### S02. Backups, restore, retention, and data protection

**Owner role:** data/recovery. **Dependencies:** DEC04 and S01 for real infrastructure trials. **Starting state:** confirmed scheduling defect plus unqualified recovery/retention envelope. **Sources:** [host backups](../server/src/runtime/backups.ts), [backup format](../server/src/platform/backup.ts), [catalog/cleanup](../server/src/platform/backups.ts), [recovery](../server/src/platform/recovery.ts), [recovery operations](tenant-recovery-operations.md).

- **S02-R01 — Separate database protection from full-snapshot failure.** Give database-only and environment snapshots independent due/progress/retry state with bounded durable journals. A symlink/special file, profile failure, or stalled full upload must not indefinitely block fresh database snapshots. Preserve upload-attempt ownership and crash-safe acknowledgement.
- **S02-R02 — Admit only recoverable storage.** Reconcile the 12 GiB bundle/100,000-entry/depth-64 format bounds with volume-growth policy and the published supported envelope. Preflight live, database staging, encrypted pending data, restore-copy, and rollback space, with a measured reserve. Refuse unsafe growth or add a qualified larger format; do not remove bounds blindly.
- **S02-R03 — Sustain retention cleanup.** Implement fair leased/claimed work with deterministic progress, independent retries/backoff, and throughput above snapshot arrivals. Process object versions, multipart remnants, and retired volumes correctly; one held or failing account must not starve the fleet. Define safe metadata retention/indexing/pruning with recovery/migration holds.
- **S02-R04 — Make restore a complete transaction.** Verify manifest, hash, encryption context, owner, generation, compatibility, and destination before publication. Restore into an unpublished replacement, invalidate unsafe restored grants/jobs, reconcile uncertain effects, verify app/companion readiness, and authorize exactly one writer before routing traffic.
- **S02-R05 — Protect the platform directory separately.** Configure and test PostgreSQL backup/PITR, application credentials, LISTEN recovery, and restoration of identities, entitlements, ownership, and lifecycle records. Tenant SQLite bundles do not back up the control plane.
- **S02-R06 — Prove data lifecycle operations.** Measure RPO/RTO and maintenance pauses; test key rotation/revocation, storage outage, corrupt/missing parts, full disk, lost acknowledgements, interrupted restore, deletion/retention conflicts, and stopped-account checkpoints. Deliver alertable backup age and recoverable error state.

**Acceptance cases**

- **S02-A01:** repeated failed full snapshots and stalled full uploads still permit database protection within the accepted RPO; restart and old upload acknowledgements cannot corrupt successor state.
- **S02-A02:** a real encrypted dataset restores to one correct account/writer within RTO; corrupted, foreign, unsupported, or undecryptable backups never become live.
- **S02-A03:** a sustained aged retention workload drains faster than arrival under failures/holds, and separate tenant/platform restore and deletion drills meet policy.

**Closure evidence:** backup/restore artifacts and hashes, fault transcripts, disk/latency/cleanup measurements, PITR receipt, retention/deletion evidence, and a rehearsal completed by an operator other than the implementer.

### S03. Capacity, availability, idle/wake, and economics

**Owner role:** runtime/SRE/finance. **Dependencies:** DEC03/DEC06, S01/S02. **Starting state:** single-serving-process routing, incompatible possible memory ceilings, and incomplete automatic lifecycle savings. **Sources:** [tunnels](../server/src/platform/tunnel.ts), [capacity policy](../server/src/platform/tenant-capacity.ts), [host sizing](../server/src/platform/fly-tenants.ts), [container policy](../server/src/runtime/container-policy.ts), [capacity operations](tenant-capacity-operations.md).

- **S03-R01 — Measure and enforce a supported resource budget.** Collect trusted per-host/container CPU, RSS/pressure, PIDs, descriptors, disk, and sample freshness bound to the active machine/generation. Size app/desktop/CLI/MCP and backup overhead together; concurrent ceilings must be compatible with the qualified workload and host headroom.
- **S03-R02 — Complete safe idle/wake and capacity control.** Persist policy/decision/cooldown state; include jobs, approvals, routines, external events, viewer/control, transfers, and backups in idleness. Checkpoint before stop, durably retain new events, and gate readiness after wake. Protect against wake storms and preserve account data and chosen computer.
- **S03-R03 — Support the promised availability topology.** Replace process-local-only tunnel routing with owner-aware forwarding/routing and fenced ownership/reconnect semantics before multi-replica service. Prove stale-owner and split-brain behavior; stickiness alone is insufficient. A measured single-instance pilot does not close the full high-availability requirement.
- **S03-R04 — Scale the complete control plane.** Budget database pools, polling, relay/viewer buffers, backup traffic, lifecycle workers, provider calls, account/volume quotas, and aged metadata. Add pagination/fairness/indices/partitioning where measured; reject overload explicitly without losing accepted work.
- **S03-R05 — Reprice and meter the operating envelope.** Obtain current quotes and actual running/stop/storage/network/service measurements. Model registered, active, and running accounts separately, including worst supported concurrency and recovery. Establish pricing, entitlements, spend alarms, and a funded response to anomalous consumption.
- **S03-R06 — Qualify growth and fleet recovery.** Run staged account/concurrency increases, bursts, soak, viewer mixes, provider throttling, dependency failures, and multi-tenant recovery. Capture completion/error/latency distributions and cost; maintain abort thresholds and a safe rollback/traffic-reduction plan.

**Acceptance cases**

- **S03-A01:** the one/two/four/eight-helper workload and backup/browser overlap meet resource/latency targets without OOM, data loss, or hidden reduced concurrency.
- **S03-A02:** two serving replicas route correctly through restart, partition, owner change, and revocation; idle/wake preserves promised scheduled/event work.
- **S03-A03:** the agreed 2,000-account dataset/active/running-host mix, soak, cost model, and fleet restore demonstrate the recorded contract and quotas.

**Closure evidence:** reproducible workload configuration, raw metrics, quota receipts, updated unit economics, owner-routing failure results, and staged rollout/abort records.

### S04. Payments, entitlements, and the paid customer lifecycle

**Owner role:** product/payments/finance. **Dependencies:** DEC02/DEC05, S01/S03; coordinate the F12 ledger and account-UI contracts in parallel. **Starting state:** Swarm payment lifecycle not found in the reviewed application; provider subscription connection and usage accounting already exist.

- **S04-R01 — Define one authoritative commercial model.** Specify plans, trials, included services, quotas, add-ons/overages, prices/currencies, supported markets, taxes, grace periods, downgrade timing, refunds, and cancellation/retention policy. Separate a Swarm subscription from a customer's AI subscription and avoid unsupported “unlimited” promises.
- **S04-R02 — Implement durable billing records and verified events.** Record provider customer/subscription IDs, effective plan/version, invoice/payment state, entitlement changes, and event processing outcomes. Verify event signatures and ownership; make event processing idempotent and replayable, tolerant of out-of-order events and reconciliation with provider truth. Never grant access from an unverified browser success redirect.
- **S04-R03 — Enforce entitlements at service boundaries.** Resolve one account-scoped entitlement decision for task admission, funded inference/voice, computers, storage, routines, and messaging. Define soft/hard limits and how existing work finishes on downgrade/suspension; preserve access to billing/support/deletion as policy requires. Do not silently change provider or billing route.
- **S04-R04 — Complete customer self-service.** Deliver checkout, payment-method management, current plan/usage/renewal price, upgrade/downgrade, invoices, cancellation, and refund-request status. Show effective dates and consequences clearly on web and compatible native channels; align native payment mechanics with the applicable store rules before submission.
- **S04-R05 — Reconcile and support financial exceptions.** Handle failed payment, authentication challenge, grace expiry, duplicate/out-of-order webhooks, refunds, chargebacks, tax changes, provider outage, manual adjustments, and lost callbacks. Maintain attributable audit entries and a reconciliation job; financial correction must not delete customer work unexpectedly.
- **S04-R06 — Prove the money-to-service loop.** Use provider sandbox events to test the complete matrix, then perform the specifically authorized production activation/cancellation/refund checks on controlled accounts. Verify which billable resources/routines stop and what data remains at every state transition.

**Acceptance cases**

- **S04-A01:** paid access follows verified provider state once; repeated/forged/foreign/out-of-order events cannot grant another account access or double-apply changes.
- **S04-A02:** purchase, trial expiry, failure/grace, upgrade, downgrade, cancellation, refund, and reactivation yield the declared entitlement, invoice, and resource state.
- **S04-A03:** reconciliation repairs missed events; customer/support explanations match charges and retained/deleted data, including native channel policy.

**Closure evidence:** plan contract, billing schema/event design, sandbox matrix, reconciliation/audit records, supported tax/store decisions, and controlled live receipts. A manual pilot billing procedure is useful interim work, not closure of full paid self-service.

### S05. Monitoring, support, privacy, and customer trust

**Owner role:** operations/support/business/security. **Dependencies:** DEC04/DEC09, S01–S04. **Starting state:** controls, metrics, and runbooks exist; complete operational execution and customer commitments remain unqualified. **Sources:** [monitoring](tenant-monitoring.md), [operations metrics](../server/src/platform/operations-metrics.ts), [account lifecycle](../server/src/accounts.ts), [privacy manifest](../apple/Swarm/PrivacyInfo.xcprivacy).

- **S05-R01 — Deliver actionable observability.** Track account/task/computer health, latency/error denominators, queue age, authorization failures, provider quotas, backup/cleanup age, disk, payment events, and cost. Correlate diagnostic IDs without recording secret values or indiscriminately logging customer content. Bound label cardinality and document account-level diagnostic access.
- **S05-R02 — Close the alert-to-operator loop.** Configure collectors, alert routing, coverage, acknowledgement/escalation, and an independent monitor for collector/notification failure. Inject representative incidents and demonstrate delivery, resolution, and user communication under the agreed timings.
- **S05-R03 — Provide usable support and recovery procedures.** Publish a reachable support channel, service status, severity/response expectations, known limitations, and instructions for provider reconnect, stuck jobs, failed transfers, restore, cancellation, and deletion. Train an operator to use the runbooks without the original engineer.
- **S05-R04 — Implement the declared data lifecycle.** Inventory account/conversation/memory/file/audio/media/usage/billing/backup data and third-party processors. Deliver the promised access/export, retention, deletion, and consent-revocation behavior with retry/exception tracking and explicit legally necessary retention. Reflect actual behavior in privacy notices and native disclosures.
- **S05-R05 — Align terms and rights with delivery.** Publish terms, acceptable use where needed, provider responsibilities, support/refund commitments, and privacy policy. Retain MIT notices and third-party attribution; confirm asset/brand and hosted provider permissions separately from source licensing. Obtain appropriate business/legal review for the actual jurisdictions and offer.
- **S05-R06 — Exercise incident response and service continuity.** Rehearse unauthorized-action response, compromised credentials, provider outage, data-loss/restore, payment failure, and fleet disruption. Include containment, evidence preservation, credential rotation, customer notification, recovery, reconciliation, and a follow-up action owner.

**Acceptance cases**

- **S05-A01:** injected task/backup/payment/provider failures reach the assigned operator, while monitoring failure itself is detected independently.
- **S05-A02:** a controlled account export/deletion follows the declared policy across active data, backups, connected services, and exceptions; customer status remains accurate through retries.
- **S05-A03:** an independent operator resolves a staged incident using the documented access, escalation, restore, and customer communication process.

**Closure evidence:** delivered alerts, support/incident rehearsals, approved policy texts, data inventory and deletion/export receipts, scoped operational access, and published customer URLs.

### S06. Existing-account migration and continuity

**Owner role:** migration/data. **Dependencies:** DEC10, S01/S02/S05. **Starting state:** migration components exist; source-wide freeze, rollback/resume, and retirement are incomplete. **Sources:** [migration implementation](legacy-migration-implementation.md), [coordinator](../server/src/platform/migration-coordinator.ts), [source drain](../server/src/platform/legacy-process-drain.ts).

- **S06-R01 — Inventory exact ownership and writers.** Record source release/machine/volume/database/files/CLI profiles, all local/remote writers and pending starts, account mappings, credentials, routines/events, and ambiguous/shared resources. Do not infer credential ownership from a path or email match.
- **S06-R02 — Enforce a complete source freeze.** Stop new work before draining every relevant writer; use a source-wide maintenance pause or a proven per-account fence. A database-only receipt, stopped desktop, or current-process drain does not prove all files and remote writers are frozen.
- **S06-R03 — Bind checkpoint to transfer.** Create an exact manifest/inventory/checkpoint with hashes, ownership, schema and credential-rewrapping rules. Transfer only the intended account into an unpublished qualified destination; require relinking for ownership that cannot be proved.
- **S06-R04 — Activate one authoritative destination.** Validate import completeness, credentials, files, tasks, and fresh app/computer readiness before routing. Fence the source through every transition and recover safely from retries, crashes, and lost provider responses.
- **S06-R05 — Complete rollback and lost-resume reconciliation.** Define when rollback is safe, restore/merge source records/files and credentials as required, reverse routing without creating two writers, and reconcile whether an uncertain resume actually happened. Preserve recovery material and customer communication throughout.
- **S06-R06 — Retire the source deliberately.** Require verified destination ownership/use and an agreed retention window before deleting source resources. Track actual resource deletion and held backups, including external credentials/relink obligations and a customer-visible continuity plan.

**Acceptance cases**

- **S06-A01:** attempted late source writes and delayed starts are refused after freeze, and the imported checkpoint matches the source inventory.
- **S06-A02:** crash/retry at each cutover and rollback boundary never yields divergent data or two active writers; uncertain operations reconcile correctly.
- **S06-A03:** migrated users can authenticate, use their intended model/apps/files, and recover work; retirement removes only the authorized source resources after retention conditions pass.

**Closure evidence:** real staged migration/rollback receipts, manifest hashes, writer-fence evidence, credential/relink decisions, and retirement/deletion proof. New-account-only operation does not close this capability.

### S07. Release engineering, compatibility, and change control

**Owner role:** release engineering/quality. **Dependencies:** DEC09 and outputs of all applicable packages. **Starting state:** build/test/image/native workflows exist; complete release qualification remains open.

- **S07-R01 — Define the release unit.** Pin source, dependency lockfiles, database/schema versions, app/host/desktop/runner images, CLI versions, companion, native builds, and provider/tool versions relevant to qualification. Record compatibility constraints instead of assuming each independently latest component works together.
- **S07-R02 — Complete CI coverage.** Run relevant regressions and the integrated candidate suites, native targets, packaging checks, and evidence-contract validation. Use disposable data for destructive tests and distinguish fixtures, real infrastructure, live providers, and physical devices in reports.
- **S07-R03 — Stage changes safely.** Provide reversible database/config migration where possible, explicit one-way boundaries where not, old/new reader compatibility, startup refusal for unsupported versions, and update instructions for incompatible bridges/clients.
- **S07-R04 — Automate repeatable promotion.** Promote the same reviewed immutable artifacts through isolated staging, controlled canary, and production. Define rollout cohorts, health/quality/cost stop conditions, accountable release ownership, and retained rollback assets.
- **S07-R05 — Make rollback operationally valid.** Prove rollback/disablement with data and permission state intact. Never roll back into a known unsafe approval path, revoked image, stale writer, or schema-incompatible binary; disable the affected capability when no safe rollback exists.
- **S07-R06 — Keep product evidence current.** Update support matrix, README/configuration guidance, release notes, source findings, scores, and known limitations. Archive prior evidence as historical; requalify affected paths after code, image, provider, policy, or configuration changes.

**Acceptance cases**

- **S07-A01:** a fresh environment can build/deploy the pinned release from documented inputs, and each client/runner exposes the intended compatible tool set.
- **S07-A02:** a canary failure stops promotion and a rehearsed rollback or scoped disablement restores service without violating data/permission boundaries.
- **S07-A03:** release notes, scores, supported behavior, and archived evidence match the exact artifacts made available to customers.

**Closure evidence:** reproducible build/promotion records, compatibility matrix, migration/rollback rehearsals, release manifest, and independent gate review.

## 5. Feature-by-feature work required for 100%

Each feature package adds customer-specific completion work to the shared foundations. Its historical percentage is a reference, not a fresh statement about the newer source. Tests listed here are acceptance scenarios; existing regression files are useful starting points, not substitutes for missing live evidence.

### F01. Persistent AI teammates

**Historical score:** 70% → target 100%. **Owner role:** agent product/runtime. **Dependencies:** S01/S02/S05, F03/F06. **Sources:** [setup](../server/src/bot-setup.ts), [memory](../server/src/agent/memory.ts), [configuration](../web/src/components/config/BotSettingsModal.tsx), [agent setup UI](../web/src/components/config/AgentConfiguration.tsx), [separately reviewed instruction controls at 0f78906](https://github.com/agenticwizzard007/grokbot-clone/blob/0f78906c18a38ee19945672827ce902da28d5fb0/web/src/components/config/AgentHarness.tsx).

- **F01-R01 — Complete creation through useful activation.** Make the chat-created and UI-created teammate journeys converge on one durable setup contract: identity, role, instructions, resources, permitted tools, activation state, and selected model/computer. Repeated requests/reloads must not create unintended duplicates. Incomplete setup must expose the missing input and retain its restricted tools until activation conditions are satisfied.
- **F01-R02 — Preserve and apply configuration correctly.** Integrate and revalidate the instruction editor, conflict detection, and owner/revision-checked prompt preview inspected in the separate configuration snapshot, or deliver the same agreed customer controls through the selected implementation. Test updates to names, primary designation, instructions, skills, resource references, models, and effort across devices and restarts. Version relevant changes so subsequent work uses the current configuration and a running job's treatment is explicit. Deleted/revoked resources must not remain silently usable from a stale setup.
- **F01-R03 — Qualify memory and compaction quality.** Create a reference conversation corpus containing facts, corrections, conflicts, dates, preferences, images, tool results, and long histories. Measure recall and summary fidelity on supported providers. Prevent invented facts being treated as authoritative stored state; report consolidation failure without losing the original durable conversation.
- **F01-R04 — Finish memory control semantics.** Document and test the difference between deleting a saved memory, retaining its source chat, exporting data, and deleting an account. Decide whether forgotten facts may be relearned from retained chat and implement that policy consistently. Preserve owner checks and make failed deletions visible rather than leaving a misleading successful UI.
- **F01-R05 — Close the teammate lifecycle.** Deactivate/delete while jobs, helpers, routines, approvals, files, and memory maintenance exist; stop or reconcile each resource under its ownership rules. Link saved state to S02's tested restore path, including restored configuration and any grants requiring reauthorization.
- **F01-R06 — Deliver a usable first-session experience.** Provide truthful setup/activation/provisioning progress, retry/cancel/reconnect actions, and accessible controls. Run representative role-specific tasks against the reference quality/latency contract; make unsupported capability or missing connection obvious before customers depend on it.

**Acceptance cases**

- **F01-A01:** create a specialist from a primary Bot, interrupt setup at each stage, activate once, and complete a verified task from a second client using the saved role/resources.
- **F01-A02:** long-history compaction preserves the required facts/corrections; forget/search/consolidate and cross-account tests match the recorded memory policy.
- **F01-A03:** delete/deactivate and restore scenarios leave no incorrectly running work or foreign/stale grants, and recover the intended saved state.

**100% evidence:** accepted setup/lifecycle matrix, task/recall benchmark, memory-policy tests, accessible UI evidence, and S02 restore receipt for teammate data.

### F02. Team coordination

**Historical score:** 60% → target 100%. **Owner role:** agent execution/quality. **Dependencies:** S01–S03, F01/F03/F06/F10. **Sources:** [jobs](../server/src/agent/jobs.ts), [loop](../server/src/agent/loop.ts), [subagents](../server/src/agent/subagents.ts), [rooms](../server/src/agent/rooms.ts).

- **F02-R01 — Prove the complete handoff contract.** A delegated job must carry a stable parent/job relationship, the intended specialist, owner context, goal, resources, selected provider/computer, and result destination. Demonstrate actual specialist execution and incorporation of its observed result into the coordinator's answer; avoid declaring success from delegation acknowledgement.
- **F02-R02 — Finish durable job recovery.** Preserve the existing queued/running/completed/uncertain/cancelled machinery and exercise every acknowledgement/start/finish transition under crash and lost responses. Every accepted job must remain discoverable with a truthful state. Queued work may resume under current authorization; uncertain external effects require reconciliation rather than blind replay.
- **F02-R03 — Bind decisions and cancellation to the correct work.** Route a child's question/approval to the right user and resume the exact continuation. Parent/child stop, account logout, deletion, and session/connection revocation must prevent queued actions; accurately explain in-flight operations that cannot be undone. Preserve the newly corrected ownership check before interrupting a helper.
- **F02-R04 — Reconcile repeated and late results.** Deduplicate callbacks and job results, reject changed payloads under the same identity, and prevent stale results from replacing a newer job's outcome. Propagate tool-level failure through journals, native MCP responses, activity, and final task state; preserve the recent failure-propagation fix.
- **F02-R05 — Bound collaboration without hiding concurrency.** Exercise circular delegation, unresponsive children, repeated handoffs, desktop contention, and agreed helper overlap. Enforce intentional depth/step/deadline/resource limits with actionable failures; release orphaned helpers/screens/processes and retain useful outcome history.
- **F02-R06 — Make coordinated work understandable.** Show parent/subtask progress, waiting decisions, partial results, canceled work, and uncertainty in conversation/task surfaces. Measure real completion quality, handoff latency, and supportability under the reference workload, including group @mention/member routing.

**Acceptance cases**

- **F02-A01:** coordinator → specialist → coordinator creates an independently verified result with the correct account/computer and visible lineage.
- **F02-A02:** crash, duplicate callback, lost write success, stale child reply, and parent cancellation produce accurate durable outcomes without duplicate effects.
- **F02-A03:** group conversations and overlapping helpers meet the concurrency contract; failed/deleted specialists clean up and leave actionable status.

**100% evidence:** real-provider coordination receipts, fault-injection matrix, lineage/state audit, resource measurements, and task UI review.

### F03. Choice of AI connection

**Historical score:** 65% → target 100%. **Owner role:** model/CLI integrations. **Dependencies:** S01/S03/S04/S07, F06. **Sources:** [model discovery](../server/src/routes-models.ts), [inference routing](../server/src/lib/llm.ts), [private keys](../server/src/providers/private-keys.ts), [CLI runtime](../server/src/cli), [native CLI design](cli-native-mcp.md).

- **F03-R01 — Unify private credential/catalog/inference contracts.** Repair isolated direct-key discovery so save/validation, catalog retrieval, model selection, and inference use the same owner-bound key and base URL. Key rotation/revocation must invalidate relevant caches and reject foreign ownership. Empty/error catalogs need an accurate user remedy, not a fabricated model or fallback charge.
- **F03-R02 — Publish the supported model/provider matrix.** Record actual provider/model IDs, capabilities, images/tools/structured output, effort controls, context limits, supported CLI versions, hosted/bridge modes, and commercial permission/quota evidence. Remove misleading affordances for unsupported combinations while preserving explicit provider choice.
- **F03-R03 — Qualify the real CLI tool path.** Preserve native manifest registration, capability exposure, error propagation, and tool capacity enforcement. Exercise exact callable tools with real supported CLI accounts, compatible application/runner/bridge versions, and two device sessions using the same private hosted profile.
- **F03-R04 — Complete authentication and failure behavior.** Test initial login, cancellation, concurrent login/execution, profile refresh, key/session expiry, provider refusal, model removal, and throttling. Text generation must not silently change the selected provider/model/billing route. An offline personal bridge must not silently switch execution hosts.
- **F03-R05 — Preserve truthful usage and funding.** Record observed usage/cost and distinguish partial/unavailable counters, subscription fees, provider extra usage, shared funding, and customer-owned keys. If administrator-funded hosted text is included, implement a trusted scoped delivery/proxy contract with entitlement and spend attribution; keep platform credentials outside untrusted tenant workloads. Reconcile approved pause/resume and cancellation cases; keep configured speech routing explicit rather than conflating it with text billing.
- **F03-R06 — Meet the responsiveness contract.** Instrument catalog, admission, cold start, model, tool, and final-response stages. Keep real tool/progress feedback when final subscription text is buffered; implement incremental text if adopted in DEC03 and test every transport. Do not simulate progress, downgrade effort, or replace models to hide latency.

**Acceptance cases**

- **F03-A01:** each supported provider/mode completes login → exact model/effort → image/tool task → correct result from two devices, with provider-side evidence.
- **F03-A02:** invalid/rotated/revoked credentials, unavailable catalogs/models, exhausted quotas, and outdated bridges produce the declared failure and no hidden billing/host switch.
- **F03-A03:** usage and latency measurements match the observed execution, including partial counters and approval interruption on the pinned release.

**100% evidence:** real model/tool matrix, permission/quota records, version manifest, account isolation/rotation results, and usage/latency receipts.

### F04. Computer and browser work

**Historical score:** 60% → target 100%. **Owner role:** computer runtime/native integration. **Dependencies:** S01–S03/S07, F06/F10/F11. **Sources:** [computer providers](../server/src/computers), [companion](../companion/swarm-companion.mjs), [host runtime](../server/src/runtime/host.ts), [browser recovery](browser-recovery.md).

- **F04-R01 — Make provider selection an executable contract.** Publish supported local-browser, personal-desktop, and cloud modes, their OS/browser requirements, tool capabilities, shared-resource behavior, and limits. Verify that exposed tools match the selected computer, including the recently fixed isolated browser capability. No silent fallback to another computer is acceptable.
- **F04-R02 — Finish the file-based computer workflow.** Integrate F10's narrow owner-bound exchange so a selected input is actually usable by the computer and a real output returns to Library. Correct misleading legacy paths. Expose only granted files, never app databases, host credentials, or another account's directories.
- **F04-R03 — Qualify consent, viewing, and ownership.** Prove watch-only input suppression, authorized takeover, desktop turn-taking, browser/profile isolation, pairing, and revocation. Signed Mac permission changes, stop/disconnect, account/server switching, and companion restart must preserve the user's selected access boundary.
- **F04-R04 — Complete browser failure recovery.** Test known reference sites plus unfamiliar/localized screens, lost snapshots, dialogs, CAPTCHA/MFA, and ineffective repeated actions. The Bot must verify the intended account and visible completion before resuming. Explain the current turn-scoped polling/reply-to-resume contract; add durable monitoring only if explicitly adopted.
- **F04-R05 — Integrate lifecycle and resource protection.** Meet S03's budgets and wake/readiness rules; exercise browser/desktop/helper overlap, resize, update, full-snapshot quiescence, process loss, and disk exhaustion. Show when work is paused, interrupted, uncertain, or ready rather than leaving an indefinite loading screen.
- **F04-R06 — Prove practical usability and cost.** Measure warm/cold computer action latency, viewer performance/bandwidth, successful task completion, input accuracy, supported key/clipboard behavior, and recovery on real devices/providers. Document known restrictions and operator/user recovery instructions.

**Acceptance cases**

- **F04-A01:** the authorized user can start/watch/control the selected computer, use a granted file, produce a verified download, stop access, and resume correctly.
- **F04-A02:** foreign owners, watch clients, stale grants, denied OS permissions, and switched accounts cannot control or inspect unauthorized resources.
- **F04-A03:** login handoff, crash, wake, resource pressure, and maintenance scenarios meet the recorded behavior and timing/resource budget.

**100% evidence:** provider/device matrix, containment/consent receipts, complete file round trip, recovery cases, and measured viewing/task cost.

### F05. Connected apps and custom tools

**Historical score:** 65% → target 100%. **Owner role:** connections/MCP integrations. **Dependencies:** S01/S03/S05, F06/F07. **Sources:** [Composio](../server/src/composio.ts), [gateway](../server/src/platform/composio-gateway.ts), [MCP](../server/src/mcp), [connection isolation](connections-isolation.md).

- **F05-R01 — Establish the supported connection contract.** Identify qualified toolkits/actions and required OAuth configuration, scopes, account types, versions, and provider limits. Distinguish catalog results from supported integrations. Test explicit/default account selection for two users and two same-user connections without toolkit-only ownership assumptions.
- **F05-R02 — Finish OAuth and credential lifecycle.** Exercise connection start, consent cancellation, callback replay/session binding, refresh, expiry, disconnect, and provider-side revocation for Composio and supported remote MCP servers. Keep tokens/configuration encrypted and excluded from user/model-facing metadata and ordinary logs.
- **F05-R03 — Enforce correct action execution.** Preserve the new metadata-based automatic-read path and complete F06's permissions contract. Validate exact account/tool/schema/arguments/revision and downstream success/error envelopes. Handle rate limits, tool version drift, malformed/large results, and uncertain effects without invented success or blind write retry.
- **F05-R04 — Complete custom MCP containment and capacity.** Qualify HTTP/SSE/stdio, selected folders, process environment, network restrictions, credential changes, session teardown, and agent assignment. Preserve the 448-custom/512-total tool limit without silent truncation; reject oversized updates while retaining the last accepted discovery and report a clear corrective action.
- **F05-R05 — Reconcile revoked/stale configurations.** Disable or invalidate changed endpoints, credentials, tools, assignments, saved grants, pending approvals, and associated event routines as required. Surface stale trigger/connection state and reconnect/removal instructions, including after restart and account deletion.
- **F05-R06 — Prove real integration operation.** Obtain provider permissions/quotas and controlled witness accounts; run the supported read/write/refresh/revoke matrix on the pinned release. Update stale documentation about MCP OAuth, encryption, and support limits. Document expected outage behavior and who supports each dependency.

**Acceptance cases**

- **F05-A01:** each declared integration completes connect → exact account/action → independently witnessed result → revoke/reconnect for the appropriate owners.
- **F05-A02:** stale/foreign revisions, changed assignments, folder replacement, revoked credentials, and oversized manifests fail safely and visibly.
- **F05-A03:** rate limits, malformed tool responses, schema changes, and provider outages yield accurate states and bounded resources without duplicate external writes.

**100% evidence:** launch integration matrix, provider witnesses/quotas, MCP transport/capacity/containment tests, and current setup/support documentation.

### F06. Action approvals and permissions

**Historical score:** 50% → target 100%. **Owner role:** security/agent execution. **Dependencies:** S01/S07, DEC07. **Starting state:** the active metadata-based policy change has landed and selected local regressions pass; complete release qualification remains open. **Sources:** [execution policy](../server/src/agent/tools.ts), [dispatch loop](../server/src/agent/loop.ts), [gateway policy](../server/src/platform/composio-policy.ts), [policy regressions](../tests/app-text-policy.test.mts).

- **F06-R01 — Audit every reachable authorization entry.** Preserve `executionPolicyFor` and exact provider metadata validation. Enumerate API chat, native CLI, setup, voice-assigned chat, legacy/resumed native operations, MCP, and any direct/meta-tool dispatch. For each, prove unset permissions cannot auto-authorize a write/unknown action through residual name-based helpers; remove or fail closed any unsafe reachable alternative.
- **F06-R02 — Bind decisions to exact actions.** Persist and revalidate owner, agent/job, account/connection, tool/version, canonical arguments, relevant revision, decision identity, and applicable expiry. Preserve explicit saved allow/deny semantics and define the scope/lifetime shown to the user. A changed operation must not consume an unrelated approval.
- **F06-R03 — Close revocation races.** Recheck decisions and resource ownership after asynchronous discovery, after a human wait, and immediately before dispatch. Test revoked sessions/connections/folders, disabled tools, changed policy, logout, account deletion, and altered arguments while work is pending.
- **F06-R04 — Make duplicate/cancel behavior reliable.** A repeat answer or callback must not authorize a second effect. Cancel queued work, expire stale cards/tokens, and reconcile in-flight outcomes accurately. A denied action must remain denied; an external effect already accepted by a provider must not be reported as undone.
- **F06-R05 — Finish permission usability and diagnostics.** Display the account, intended effect, relevant parameters, and enduring permission scope without exposing secrets. Make revocation/dispute history accessible. Document browser/shell/desktop consent separately; do not imply all computer-mediated writes have individual Composio cards.
- **F06-R06 — Obtain independent policy evidence.** Use controlled read/write/ambiguous tool metadata, mutating names with read-like words, multiple connections, and hostile timing. Record provider-side non-execution before approval and exactly the intended effect afterward across every offered channel.

**Acceptance cases**

- **F06-A01:** the audited CHECK-name example and unknown/conflicting metadata require the correct policy on every reachable path; no provider invocation occurs before a required approval.
- **F06-A02:** changing owner/session/account/revision/arguments or revoking access while waiting prevents stale dispatch; valid intentional saved permissions still work.
- **F06-A03:** duplicate decisions, cancellation, denied retries, and lost provider success responses preserve one authorized effect or explicit uncertainty with an attributable record.

**100% evidence:** independently reviewed path inventory, regression/race matrix, real provider witnesses, permissions UX review, and compatibility-safe rollout/disablement instructions.

### F07. Recurring and event-driven work

**Historical score:** 65% → target 100%. **Owner role:** automation/runtime. **Dependencies:** S02–S05, F02/F03/F05/F06. **Sources:** [routines](../server/src/routines.ts), [limits](../server/src/routine-limits.ts), [triggers](../server/src/triggers.ts), [event inbox](../server/src/runtime/event-inbox.ts).

- **F07-R01 — Define schedule and missed-run semantics.** Persist timezone, schedule version, enabled state, next/due occurrence identity, and adopted catch-up policy. Establish behavior for clock/DST changes, downtime, edits, manual runs, and overdue jobs. The default proposal is bounded catch-up/coalescing with visible skipped occurrences, not unbounded replay; DEC08 must settle exact behavior.
- **F07-R02 — Make event acceptance durable and bounded.** Persist authenticated event identity and ownership before acknowledgement, deduplicate redelivery, bound bursts, and track processing/retry/dead-letter outcomes. Prevent one noisy account/provider from monopolizing delivery, and make exhausted retries inspectable without creating duplicate effects.
- **F07-R03 — Integrate stopped-host scheduling.** A trusted platform scheduler/event path must wake the correct tenant when the promised work is due, retain events while it is unavailable, and wait for fresh readiness. Handle updates/restores/deletion and wake races. In-process cron on an inactive host is not an always-on service.
- **F07-R04 — Enforce run and cost limits consistently.** Apply count/frequency/daily-run/overlap/inactivity controls atomically under concurrent events and restarts. Connect funded services to entitlements/budgets and implement explicit pause/resume behavior; report why a run is rejected or skipped.
- **F07-R05 — Preserve current permissions and decisions.** Revalidate model/app access and activation at execution time; expired credentials or revoked triggers produce actionable failure/pause. Approval waits must remain visible without spawning uncontrolled overlapping work. Retain the recent routine-deletion ownership protection.
- **F07-R06 — Expose a reliable run history.** Show schedule occurrence, accepted job, start/end, outcome, skip/failure reason, needed decision, actual result, and notification destination. Verify routine/check-in delivery across web/messaging preferences and provide a manual recovery path with explicit duplicate-effect safeguards.

**Acceptance cases**

- **F07-A01:** DST/timezone changes, downtime, edits, restart, and manual overlaps follow the recorded schedule/catch-up policy without unintended duplicates.
- **F07-A02:** stopped tenants receive authenticated events after wake, while duplicates/bursts and revoked/deleted accounts respect ownership and caps.
- **F07-A03:** a 24-hour unattended run with provider failure, approval waits, and wake cycles produces traceable results and measured backlog/cost within contract.

**100% evidence:** deterministic timing/event tests, real trigger/wake/delivery receipts, durable run history, entitlement checks, and unattended soak measurements.

### F08. Voice

**Historical score:** 50% → target 100%. **Owner role:** voice/native/integrations. **Dependencies:** S01/S03–S05, F02/F03/F06/F11. **Sources:** [voice server](../server/src/voice.ts), [voice credential selection](../server/src/lib/voice-provider.ts), [speech routing](../server/src/lib/speech.ts), [voice client](../web/src/voice/call.ts), [platform voice](platform-voice.md).

- **F08-R01 — Complete isolated funding and authorization.** Implement the chosen account-scoped shared voice-token/transport service or a fully supported per-user key path. Shared master keys stay outside tenant workloads. Bind eligibility, quota, revocation, short-lived session credentials, and usage attribution to the correct account; expose configuration failures clearly.
- **F08-R02 — Qualify voice-to-team execution.** Preserve the new chat assignment path, stable tool-call IDs, durable FIFO, and stale direct-call refusal. A spoken correction must target the intended job/agent; questions/approvals and final results must retain lineage and actual completion state. Repeated client delivery cannot create duplicate work.
- **F08-R03 — Complete audio format and speech quality coverage.** Test supported microphone recordings, iMessage CAF and other declared input formats, normalization, transcription routing/fallback, TTS previews/speed, and live speech output. Measure intelligibility, transcription errors, accents/locales, background noise, and end-to-end speech latency under DEC01/DEC03.
- **F08-R04 — Define and test session interruption.** Handle microphone denial/revocation, network loss, token expiry, device/audio-route changes, interruption/barge-in, hangup, and foreground/background transitions. State whether delegated work continues and how its result is recovered. Suppress stale audio and release sockets, captures, and server state reliably.
- **F08-R05 — Finish cost, limit, and privacy behavior.** Meter calls/transcription/synthesis, preserve unknown/partial usage, enforce adopted entitlements, and explain when a configured speech provider differs from text generation. Bound long/concurrent calls and publish audio/transcript retention, deletion, and support guidance.
- **F08-R06 — Prove the advertised voice experience on devices.** Run real microphone calls and dictated/voiced tasks on each supported browser and signed native platform. Include provider outage/quota and accessibility alternatives, correct pending approval controls, measured long-call stability, and truthful task feedback.

**Acceptance cases**

- **F08-A01:** an eligible new account starts a real call, delegates a verified app/file task, handles a decision, and hears the actual result under the intended funding source.
- **F08-A02:** retries, interruption, client disconnect, and provider failure cannot duplicate tasks, bypass approval, or leave misleading success/audio state.
- **F08-A03:** supported formats/devices/locales meet quality/latency limits, and usage/retention/permissions remain correct for partial and long calls.

**100% evidence:** signed-device/microphone receipts, provider billing/authorization evidence, speech corpus results, delegation fault matrix, and privacy/support documentation.

### F09. Messaging

**Historical score:** 65% → target 100%. **Owner role:** messaging/integrations. **Dependencies:** S01–S05, F02/F05–F08/F11. **Sources:** [messaging bridge](../server/src/messaging/bridge.ts), [inbox](../server/src/messaging/inbox.ts), [Inkbox adapter](../server/src/messaging/inkbox/adapter.ts), [messaging guide](messaging.md).

- **F09-R01 — Complete real channel onboarding and ownership.** Provision/authorize the offered iMessage/SMS/WhatsApp channels and qualify invite signup, phone verification/linking, account collision, number changes, unlink/relink, Bot selection, and reconnect. Invalid/reused invites and verification bursts must not bind another person's account.
- **F09-R02 — Finish inbound reliability and operations.** Preserve signature verification, durable-before-ack acceptance, deduplication, ordering policy, and bounded retries. Inject replay, delay, out-of-order delivery, malformed events, restart, and tenant sleep/restore. Expose exhausted retries and safe manual resolution with retention that preserves required deduplication evidence.
- **F09-R03 — Reconcile outbound delivery truthfully.** Distinguish queued, provider-accepted, delivered where observable, failed, and uncertain states. Use provider idempotency/delivery lookup where available; if a lost response cannot be resolved, do not blindly repeat a possible send. Preserve message splitting/ordering and define recovery when only part of a long response was sent.
- **F09-R04 — Qualify decisions and connection handoffs.** Exercise multiple Bots/approvals, quoted and bare replies, expired tokens, changed sessions, denied actions, and mobile app-connection links. Return to the intended account and exact pending job; do not activate an agent or grant new access simply because a message contained a link.
- **F09-R05 — Complete media handling safely.** Test declared image/audio types, maximum size, normalization/transcription, corrupted or expired media, private download origins, and credential isolation. Store and delete temporary/media data according to policy and expose useful user errors rather than dropping attachments silently.
- **F09-R06 — Close channel rules, preferences, and costs.** Confirm applicable consent/opt-out, sender/number approval, messaging-window/template, throughput, and provider terms. Implement promised quiet/notification preferences and web-versus-channel routing. Measure split-message/media costs, quota headroom, and account deletion across local and external records.

**Acceptance cases**

- **F09-A01:** each offered real channel carries signup/link → task/media → decision → independently verified result, with correct owner/Bot and expected notifications.
- **F09-A02:** duplicate/reordered events, sleeping tenants, partial sends, lost success responses, and exhausted retries yield bounded, attributable outcomes without blind duplicates.
- **F09-A03:** channel changes, opt-out/preferences, quotas, billing, retention, and deletion match the published provider-compatible policy.

**100% evidence:** real line/channel receipts, provider delivery observations, media corpus/fault tests, cost/rate measurements, and operating/retention rules.

### F10. Task board and file Library

**Historical score:** 50% → target 100%. **Owner role:** application/files/runtime. **Dependencies:** S01/S02/S04, F02/F04/F06/F11. **Sources:** [task board](../web/src/components/config/TasksView.tsx), [Library](../web/src/components/config/LibraryTab.tsx), [config/file routes](../server/src/routes-config.ts), [file policy](../server/src/security/files.ts), [host mounts](../server/src/runtime/host.ts).

- **F10-R01 — Make task state a faithful projection.** Define how queued, running, awaiting user/approval, partial, failed, canceled, uncertain, and completed jobs appear in the existing board. Extend the state model or expose an explicit outcome/recovery field where necessary; never label uncertainty/failure as Done. Preserve owner filtering, ordering, stale-refresh behavior, and conversation linkage.
- **F10-R02 — Implement narrow file exchange.** Provide an owner-checked input/output transfer contract containing opaque file/transfer ID, owning account/Bot/job, logical name/type/bytes/hash, source/destination grant, revision/expiry, and transfer state. Stage into permitted computer locations and return outputs through Library; use bounded temporary storage, idempotent transfer identity, verified completion, and atomic publication. Align tool descriptions and customer-facing paths with the actual exchange and mounts.
- **F10-R03 — Verify results before completion.** A completed file task must refer to the actual accessible artifact with expected content/hash and any externally witnessed effect. Persist the relation among task, job, file, and result link. Missing/partial/corrupt outputs keep the task incomplete or explicitly failed, regardless of the model's prose.
- **F10-R04 — Enforce filesystem and access boundaries.** Revalidate owner/session/grant/revision before copy/download and after relevant waits. Test path traversal, symlinks, directory swaps, foreign IDs, revoked folders, misleading filenames, and changed source files. Do not solve exchange by mounting all application data into the desktop.
- **F10-R05 — Complete the data envelope and recovery behavior.** Enforce declared file types/sizes/counts, total protected storage, retention, and free-space reserve compatible with S02. Handle interrupted uploads/transfers, duplicates, full disk, expired links, backup pause, restore, and account deletion without losing a completed artifact or leaving unlimited scratch data.
- **F10-R06 — Qualify customer access and usability.** Test web/native uploads/downloads, reconnect/retry, deleted Bots, long names/content, sorting/filtering, keyboard/screen-reader use, mobile layouts, and large histories. Show transfer progress, failure, and recovery actions with correct paths and permission expectations.

**Acceptance cases**

- **F10-A01:** a known input is uploaded, used by the selected computer, transformed, and downloaded with independently checked content/hash; the board references that real output.
- **F10-A02:** interruption, disk pressure, duplicate transfer, grant revocation, and adversarial paths do not corrupt published output or expose unauthorized files.
- **F10-A03:** task state and file access remain correct through native/web refresh, failure, cancellation, restore, and deletion under the supported data envelope.

**100% evidence:** real file round trip on each supported computer mode, path/ownership tests, task-state contract, device/accessibility tests, and backup/restore receipt for the dataset.

### F11. Web, Mac, and iPhone/iPad access

**Historical score:** 60% → target 100%. **Owner role:** native/web/release. **Dependencies:** S01/S04/S05/S07, F03/F04/F08/F10. **Sources:** [native client](../apple/Swarm/AppModel.swift), [native auth](../server/src/native-auth.ts), [platform auth](../server/src/platform/auth.ts), [Apple build script](../scripts/apple.sh), [Mac release](../.github/workflows/release-mac.yml), [native guide](apple-apps.md).

- **F11-R01 — Repair native linking and account truth.** Carry authenticated Google linking intent, revalidate the initiating session through isolated Apple/OpenRouter completion, and reconcile partial OpenRouter success without unsafe merging or silent account switching. Align `googleLinked`/provider status and consent text with the actual auth mode. Preserve ordinary Google sign-in fixes.
- **F11-R02 — Complete session/client lifecycle.** Test sign-in, cancellation, collision, logout, expiry, replay, account/server switch, multiple windows/devices, and reconnect in each supported role. Keep cookies/tokens bound to the correct origin/account; revoke computer/voice/tool access when required. Never weaken server ownership checks to fix native UX.
- **F11-R03 — Qualify native feature parity.** On physical devices and signed builds, exercise hosted model selection, app authorization, file upload/download, computer viewer/control where supported, microphone/voice, shortcuts, and background/resume. Permission denial/revocation and unavailable-network states must have usable recovery paths.
- **F11-R04 — Finish native test and artifact pipelines.** Execute the iOS test target as well as the Mac scheme; build pinned app/companion/runtime payloads for advertised architectures. Test compatibility and packaged runtime behavior without leaking signing material, then exercise signed-device behavior rather than treating simulator builds as final qualification.
- **F11-R05 — Complete public delivery.** Run real Developer ID signing/notarization/stapling/Gatekeeper verification and publish accessible versioned Mac assets/checksums. Produce a repeatable iOS signed archive/export/upload, TestFlight validation, and App Store submission/review. Supply actual privacy/support URLs, screenshots, reviewer access, payment/sign-in/deletion compliance, and retained rollback assets.
- **F11-R06 — Finish usability and supportability.** Validate accessibility, keyboard navigation, supported display sizes/locales, long content, native/web navigation, low connectivity, and app/backend/companion upgrades. Publish minimum OS/browser versions, update/reinstall/rollback instructions, known limitations, and a support channel.

**Acceptance cases**

- **F11-A01:** every included sign-in/linking path returns to the intended account, handles collision/revocation/cancel correctly, and shows accurate linked state on another device.
- **F11-A02:** actual supported signed devices pass the reference model/app/file/voice/computer journeys, permissions, interruption, and accessibility checks.
- **F11-A03:** the exact public Mac and iOS release artifacts pass delivery/installation/review requirements and have a tested upgrade/recovery/support path.

**100% evidence:** auth/device matrix, signed-artifact provenance and installation records, iOS tests/TestFlight/store outcome, accessible download/checksum/support pages, and native policy disclosures.

### F12. Usage visibility and administration

**Historical score:** 65% → target 100%. **Owner role:** usage/admin/product operations. **Dependencies:** S01–S05/S07, F03/F08/F09. **Sources:** [usage](../server/src/usage.ts), [computer usage](../server/src/usage-vm.ts), [usage UI](../web/src/components/config/UsageSection.tsx), [analytics](../server/src/analytics.ts), [accounts](../server/src/accounts.ts).

- **F12-R01 — Reconcile the usage ledger.** Retain per-request/job/account/provider attribution, observed tokens/units/cost source, complete/partial/unavailable status, and exported provenance. Compare actual provider records across retries, caching, approval stops, errors, and cancellation; distinguish subscription fees/extra usage from zero recorded model API charges.
- **F12-R02 — Connect usage to explicit budgets.** Distinguish display-only estimates from enforceable plan limits. Provide the adopted account-scoped budget/entitlement decisions for funded models, voice, computers, storage, routines, and messaging, with warnings and understandable exhausted-limit behavior. Unknown cost cannot be treated as unlimited free capacity.
- **F12-R03 — Qualify administration and secret lifecycle.** Prove customer report/export isolation and intended administrator visibility. Test role changes, persistent bootstrap rules, key validation/rotation/revocation, concurrent credential mutation, restart, session revocation, and account deletion. Provide attributable redacted audit records and safe administrator recovery procedures.
- **F12-R04 — Complete billing and account self-service surfaces.** Integrate S04's plans, payment/invoice state, renewal/usage explanation, change/cancel/refund path, and S05's export/deletion/support controls. Present effective dates and resource/data consequences consistently across clients; do not label third-party AI subscriptions as a paid Swarm plan.
- **F12-R05 — Make cost and operational diagnosis usable.** Reconcile computer running/stopped/volume charges and all other included services, exposing estimation and freshness. Supply authorized account-level task/backup/connection/payment diagnostics and links to operator runbooks; alert on stalled work, recovery risk, quota/cost anomalies, and delayed billing reconciliation.
- **F12-R06 — Qualify scale, reporting, and claims.** Test aged usage/history data, filters, timezones, CSV correctness, accessibility, and concurrent export/query load. Keep time-saved estimates explainable and separate from demonstrated productivity or guaranteed ROI. Update prices, support materials, and cost models from actual measured invoices/usage.

**Acceptance cases**

- **F12-A01:** customer views/CSV and administrator views reconcile with controlled provider/computer/billing records, including unknown/partial values and pricing changes.
- **F12-A02:** foreign users, removed administrators, revoked keys/sessions, and concurrent mutations cannot access unauthorized data or bypass budget/entitlement rules.
- **F12-A03:** customers and operators can understand charges, resolve failures, cancel, export/delete, and support an aged account at the qualified scale.

**100% evidence:** reconciled ledger/CSV samples, ownership/admin tests, paid lifecycle receipts, query/load measurements, support drill, and reviewed customer-facing claims.

## 6. Integrated acceptance protocol and release gates

### The reference customer workflow

Use controlled synthetic customers A and B with separate identities, private files, and provider accounts. Give A two connections to the same app so account-selection errors are observable. Record the exact release and authorization boundaries. Live writes must target disposable records within the authorized test inventory; this document itself performs no deployment, charge, or provider transaction.

1. Create the intended account through each offered signup path. Complete a trial or purchase according to the adopted billing design; verify effective entitlements from provider/server state.
2. Sign in from a second supported client. Link an additional identity without switching/merging into another account; inspect accurate linked-state disclosure.
3. Connect the selected API or official CLI subscription. Observe the real catalog, choose a supported model/effort, and verify its use rather than trusting a UI label alone.
4. Create and activate a specialist teammate from the coordinator, with a known role, resource, and memory fact. Reload during setup and verify a single intended teammate.
5. Connect a controlled app and discover a real read action. Confirm A's chosen connection is used and B's resources are unreachable.
6. Upload a known input file. Record its hash and transfer it to the selected computer through the authorized exchange.
7. Ask the coordinator to delegate a bounded task requiring that app read and file input. Observe actual specialist execution and lineage.
8. Introduce a write that requires a decision. Verify no provider effect occurs before approval; inspect the displayed account/operation, then approve the exact action once.
9. Independently inspect the provider effect and generated output file. Download and validate the result; confirm task completion references those actual outputs.
10. Return from another device and after an application restart. Confirm role, history, memory, task state, provider selection, and file access remain correct.
11. Repeat with voice: real microphone → assigned agent → approval/question → verified outcome. Repeat with a supported messaging channel and image/audio input.
12. Run a scheduled occurrence and a real app event while the browser is closed and, where supported, the tenant is stopped. Observe wake, deduplication, execution, and notification.
13. Revoke the app/model/session or computer grant during a pending operation. Verify refusal or truthful in-flight reconciliation; reconnect without ownership or billing drift.
14. Cancel a queued job and interrupt a running job after a possible external effect. Confirm no blind replay, stale speech/result, or false “undone” claim.
15. Restore actual encrypted customer data to an unpublished replacement and publish one writer. Verify recovered files, histories, settings, identities, and required reauthorization.
16. Complete a plan change, payment failure/grace, cancellation, and authorized refund/reconciliation scenario. Check resource/routine behavior and customer invoices/status.
17. Export and delete the test account under policy. Verify local/external/backup treatment and any declared retained financial records without affecting B.
18. For migration scope, perform source freeze → transfer → activate and a separate rollback rehearsal before source retirement.

Run each critical ownership/authorization/billing case on every applicable path. Use a documented matrix to avoid substituting one successful provider, standalone server, browser emulator, or signed device for the whole offer. Noncritical cross-product combinations may use a justified sampling strategy, but its coverage limits must be visible.

### Required failure matrix

| Failure family | Injection points | Expected invariant |
| --- | --- | --- |
| Identity and ownership | Foreign account, same-user second connection, expired/revoked/switched session, forged callback, stale generation | No unauthorized read, action, file, terminal, viewer, entitlement, or credential use. |
| Uncertain effects | Provider accepted a write/send/payment event but response or acknowledgement is lost | Reconciliation or explicit uncertainty; no blind repeat and no invented success. |
| Lifecycle | Before/after durable acceptance, queue start, approval, transfer, snapshot, activation, migration, rollback | Accepted state remains attributable; at most one authoritative writer; retries preserve ownership. |
| Connectivity | Browser/mobile disconnect, bridge loss, tenant tunnel reconnect, provider timeout, webhook redelivery | Correct selected execution/billing host, bounded queues, truthful stale/error state, safe reconnection. |
| Capacity | CPU/RAM/PIDs/disk pressure, large histories/tool catalogs/files, event bursts, view traffic | Declared limits and backpressure; no silent truncation, lost accepted work, or hidden concurrency reduction. |
| Data protection | Broken profile file, stuck upload, corrupt/missing backup part, wrong KMS context, storage outage | Continued DB protection where possible; invalid restore cannot activate; recoverable material is retained. |
| Commercial lifecycle | Trial expiry, payment failure, reordered events, downgrade, cancellation, refund, account deletion | Exactly the documented entitlement/resource/data/invoice result, with auditable reconciliation. |
| Client/distribution | Permission deny/revoke, OS/device change, native callback, outdated bridge/client, upgrade/rollback | Accurate account binding, safe capability refusal, useful recovery, and supported version behavior. |

### Gates that must all close

| Gate | Closure requirement | Evidence owner |
| --- | --- | --- |
| G01 — Scope and baseline | DEC01–DEC10 recorded; exact source/configuration/support matrix; no ambiguity about funded services, limits, or what “complete” means. | Product/release |
| G02 — Implementation and deterministic behavior | All required changes integrated; existing working behavior preserved; reproducing regressions, schema/API contracts, unit/integration checks, and feature UI checks pass. | Feature owners/quality |
| G03 — Authorization and containment | F06 and S01 pass independent path/race/real-host review, including actual cross-tenant boundaries. | Security/platform |
| G04 — Complete user value | All F01–F12 acceptance cases and the reference customer workflow pass for the supported provider/computer/client/channel matrix. | Product/quality |
| G05 — Recovery and operations | Real tenant/PITR/fleet recovery, retention/deletion, monitoring delivery, incident response, and support rehearsals meet contract. | Operations/data |
| G06 — Money and scale | Full payment/entitlement lifecycle, current cost/margin model, quota/capacity limits, bursts/soak, and overload behavior meet the adopted envelope. | Payments/runtime/finance |
| G07 — Native and release delivery | Shipping Mac/iOS artifacts, required store approval, public distribution/support, compatibility, and rollout/rollback evidence match the release manifest. | Native/release |
| G08 — Final evidence and score review | Every mandatory requirement has accepted evidence; all 12 features score 40/20/20/20 across their four components; shared packages close; no unresolved critical release condition or unacknowledged scope reduction. | Release owner + independent reviewers |

An all-green fixture suite can close portions of G02, not G03–G08 by itself. A limited pilot may proceed under its own recorded acceptance boundary; it must not be presented as completion of this full specification.

## 7. Delivery sequence, responsibilities, and dependencies

Dependencies identify interfaces/evidence needed for closure, not a command to wait for an entire neighboring package before doing independent work. Design the billing/usage, file/computer, and authentication/native contracts together, then implement against agreed fixtures in parallel.

| Wave | Deliverables | Parallel work and exit condition |
| --- | --- | --- |
| 0 — Establish the candidate | Refresh HEAD/deployed inventory; preserve latest fixes; assign named owners/reviewers; record decisions and test inventories; open requirement tickets. | Source review, cost/provider research, native access, and support policy preparation can proceed together. Exit: stable baseline and recorded contract. |
| 1 — Repair trust and data boundaries | F06 complete path review; S02 backup independence/envelope; F10 exchange contract; F03 private model catalog; F11 linking; S01 image/admission/containment preparation. | Keep edits separated by owned modules/interfaces. Exit: focused code candidates with regressions and no known unsafe dependency used for live qualification. |
| 2 — Integrate complete customer workflows | F01–F10 runtime/UI integration, isolated voice, client parity, S04 billing, F12 ledger/admin, and S05 operational/customer surfaces. | Use controlled fixtures while provider/device/infrastructure inputs are prepared. Exit: deterministic reference workflow and fault matrix on integrated candidate. |
| 3 — Qualify real environments | Real hosted boundary, model/app/voice/messaging accounts, signed devices, encrypted restore/PITR, payments, alert delivery, and migration. | Security/provider/native/recovery tracks can proceed once their prerequisites pass. Exit: accepted exact-release live/device/infrastructure receipts. |
| 4 — Qualify sustained operation | S03 population/concurrency/running-host tests, bursts/soak, aged metadata, resource/idle/HA behavior, cost reconciliation, and fleet recovery. | Measure actual margins and support load; fix newly demonstrated failures and rerun affected cases. Exit: contract/quotas/economics satisfied. |
| 5 — Publish the qualified release | S07 canary/promotion, F11 public native delivery, finalized policies/docs/support, controlled paid onboarding, and G08 review. | Release owner reviews the concrete manifest and evidence. Exit: all applicable gates closed and users receive the qualified artifacts. |

Recommended responsibility groups are agent runtime, models/connections/security, data/platform, native/web, payments/usage, and operations/quality. These are proposed ownership areas, not claims that people or agents have been assigned. Name one accountable owner per requirement and an independent reviewer for security, data integrity, billing, and final release.

If implementation uses a four-slot agent team, use one coordinator and up to three bounded workers; a reviewer occupies a worker slot. Work in isolated branches/worktrees when edits overlap, coordinate shared schemas/APIs, integrate small reviewed changes, and preserve unrelated work. This document does not start that implementation team.

**Do not estimate completion from the number of checked boxes.** A small interface fix and a fleet restore drill have very different effort and dependencies. Estimate each ticket only after its implementation boundary, external inputs, and test environment are known. Publish milestone forecasts with confidence and dependency assumptions rather than an unsupported delivery date.

## 8. Closure records and how scores advance

### Requirement state

Use `OPEN`, `DECISION_REQUIRED`, `IMPLEMENTING`, `PARTIAL_LOCAL_EVIDENCE`, `LOCAL_PASS`, `INTEGRATED_PASS`, `LIVE_PASS`, `VERIFIED`, or `BLOCKED_EXTERNAL`. These track delivery, not automatically awarded score points. An external dependency may block a live test while independent code work continues. Scope exclusions require an explicit versioned record; they cannot quietly turn required work into a pass.

`PARTIAL_LOCAL_EVIDENCE` is the initial classification for requirements with specifically inspected recent changes and passing selected fixtures but incomplete acceptance. All other requirements start `OPEN` unless a reviewed current receipt establishes more. `OPEN` does not mean the entire implementation is absent.

### Required evidence record

For each requirement, store: requirement ID; current behavior and remaining work; accountable owner; reviewer; decision dependencies; implementation PR/commit; exact source/images/schema/configuration; applicable accounts/providers/devices/data envelope; test IDs and pass/fail/skip results; sanitized output/artifact hashes; observed effects and metrics; residual limitations; rollout/rollback procedure; closure date; and reviewer disposition.

Evidence types must remain distinct: source inspection, deterministic fixture, integration on real components, live provider, actual infrastructure, signed device, production operational receipt, and approved business/policy record. A historical receipt is reusable only if the relevant implementation/configuration remains compatible and that reuse is justified.

### Full-score review worksheet

| Component | Maximum points at completion | Required review question |
| --- | ---: | --- |
| Core capability and usability | 40 | Does the promised customer job work correctly with complete controls, outputs, error/retry/cancel states, and accessibility? |
| Integration and deployment | 20 | Does it work on every included provider/account/computer/client path, with compatible versions and accurate capability presentation? |
| Safeguards and recovery | 20 | Are ownership, authorization, revocation, uncertainty, durability, and relevant restore/deletion behavior proven? |
| Live validation and operability | 20 | Are the exact shipping paths, quality/latency/cost limits, support, and operational response independently evidenced? |

The feature owner proposes a component score with evidence links; the reviewer accepts or rejects it. To move a feature to 100, every row must receive full points and its shared dependencies must close. Repeating the earlier arithmetic or completing a coding ticket cannot substitute for this review. All 12 reaching 100 still requires G05–G08 and shared commerce/operations/release completion before declaring the entire paid product finished.

### Traceability deliverables

- [Requirement tracker](full-completion-tracker.csv): one row per S/F requirement, with owner role, dependencies, acceptance cases, current baseline disposition, and blank ticket/reviewer/evidence/closure fields for execution.
- [Original gap map](full-completion-gap-map.csv): all 153 missing-work bullets from the previous scorecard, assigned stable `Fxx-Gyy` IDs and mapped to a primary requirement plus shared dependencies. It preserves the older wording and separately notes recent implemented changes.
- [Earlier assessment](commercial-readiness.md): historical scored feature descriptions and evidence vocabulary. This specification's refreshed baseline supersedes stale implementation statements for the newer source; it does not erase the historical audit.

No gap is dropped because it overlaps another feature. Shared implementation is completed once and its evidence linked to each dependency. Optional extensions have separate IDs and cannot inflate completion of mandatory requirements.

## 9. Inputs required to execute the complete plan

| Input | Specific requirement | Used by |
| --- | --- | --- |
| Release/deployment inventory | Exact app/runtime/image/schema versions, real roles, URLs, regions, resources, and current deployment state | S01/S07 and all acceptance records |
| Controlled infrastructure | Real containment-capable host, separate tenant boundaries, PostgreSQL/PITR, KMS/IAM, versioned storage, signing custody, and scoped credentials | S01–S03/S06 |
| Provider test identities | Authorized model subscriptions/API accounts, two same-user app connections, OAuth configs, app witness records, voice permissions, messaging lines and media fixtures | F03/F05/F08/F09 |
| Device/release access | Physical supported iPhones/iPads/Macs, signing/provisioning/notary assets, store access, supported architecture/OS matrix, final backend and public URLs | F04/F08/F10/F11/S07 |
| Commercial decisions | Plans/prices/funding, payments/tax/store policy, provider permission/quotas, gross-margin/spend envelope | S03/S04/F03/F08/F09/F12 |
| Operating owners | Alert destination and coverage, support channel, independent reviewers, release authority, incident/retention policy owners | S05/S07/G08 |
| Migration inventory | Exact legacy writers/data/credentials/resources, continuity window, checkpoint/rollback/retirement rules | S06 |
| Versioned acceptance contract | Final DEC01–DEC10 decisions, workload/dataset, timing/quality/recovery targets, controlled test inventory, permitted live actions/spend | Every qualification track |

Keep secrets in protected storage and reference their location/owner in tickets, not their values in this document. Missing external inputs should produce a concrete blocked-evidence entry; they do not prevent independent local implementation or fixture tests. No tests in this document should be run against uncontrolled customer data by default.

## 10. Additional extensions beyond the original full-score scope

These are explicit additional projects if “everything” is expanded beyond the originally scored product. Their absence is not used to depress the previous scores; adding them changes the supported scope and test matrix.

- **O01 — Push notifications:** implement device-token registration/rotation/revocation, account-bound delivery, user preferences, safe payloads, deep links, duplicate suppression, and OS permission/error states. Complete only after signed-device foreground/background/terminated-app, logout/account switch, and sensitive-data tests pass on the actual delivery service.
- **O02 — Offline chat:** define exactly what can be read/composed offline; add encrypted local data, account separation, durable pending sends, reconnect ordering/deduplication, conflict policy, and explicit offline status. Complete only when airplane-mode/restart/storage-pressure/account-switch tests show no lost drafts, duplicate tasks, or foreign cached content. Do not imply model execution works offline unless separately implemented.
- **O03 — Background voice:** implement only platform-permitted audio/session behavior, interruptions/audio routing, lock-screen controls where appropriate, permission/privacy indicators, task continuity, and bounded battery/network use. Complete with signed-device background/lock/phone-call/OS-termination tests and store acceptance; a web background timer is insufficient.
- **O04 — Automatic Mac updates:** add signed update metadata/artifacts, compatibility checks, staged rollout, failure recovery, and a secure rollback/reinstall path. Test compromised/invalid metadata, interrupted download/install, data/schema compatibility, architecture selection, and notarized upgrade on supported Macs.
- **O05 — MCP resources and prompts:** define authorization, discovery/pagination, size/content limits, model-context placement, cache/revision behavior, and UI exposure for resources and prompt templates. Validate ownership, revocation, malformed/malicious content handling, and HTTP/SSE/stdio compatibility without bypassing the existing tool/folder boundaries.
- **O06 — Organization/enterprise scope:** separately specify team membership/roles, organization-owned connections/data, SSO/provisioning if offered, shared billing, audit/export/retention controls, offboarding, and support commitments. Prove tenant-versus-organization boundaries and role changes; the current concept of collaborating Bots is not itself an enterprise user-permission system.

## 11. Evidence, source anchors, and verification boundary

### Checks performed while preparing this specification

- Inspected `4c6efab9bf377249f153f7f0c54d86215bebc8da`, the separate configuration snapshot `0f78906c18a38ee19945672827ce902da28d5fb0`, and the final baseline `41ed36debc71a2e72d6817ed1f22f7e036e827dc`. The final comparison with the earlier assessment covers 35 changed paths. Separate-snapshot work is explicitly distinguished from integrated baseline work.
- Re-read changed execution policy, dispatch, voice/transcription, MCP capacity, and native tool-manifest behavior; spot-checked remaining backup, model catalog, voice-key, image-admission, and routing constraints.
- Ran the eight suites below: **63 passed, zero failed, zero skipped**. Full local output is retained in `.context/full-completion-baseline-tests.log`.
- Ran `node --import tsx --test --test-concurrency=1 tests/bot-creation.test.mts` at the separate configuration snapshot: **16 passed, zero failed, zero skipped**; output is in `.context/full-completion-configuration-tests.log`.
- Ran `node --import tsx --test tests/pairing-token.test.mts` at the final baseline: **one passed, zero failed, zero skipped**; output is in `.context/full-completion-pairing-tests.log`.
- Checked the document/trackers for requirement IDs, acceptance/dependency links, complete coverage of the previous 153 gaps, and valid source references; checked the generated HTML/PDF for usable navigation and layout.

```bash
node --import tsx --test --test-concurrency=1 \
  tests/app-text-policy.test.mts \
  tests/cli-apps.test.mts \
  tests/cli-tool-integrity-regressions.test.mts \
  tests/cli-tool-manifest.test.mts \
  tests/cli-tenant-browser-capability.test.mts \
  tests/mcp-capacity.test.mts \
  tests/speech-routing.test.mts \
  tests/voice-assignment-queue.test.mts
```

This work creates the specification and its review artifacts. It does not implement the remaining application requirements, make a paid transaction, deploy infrastructure, conduct a live-provider/device trial, certify capacity, or award a full score. Before implementation begins, refresh the source and evidence again; other work can advance independently of this document.

### Engineering starting points

| Work area | Sources and existing test foundations |
| --- | --- |
| Agent creation/memory/coordination | [setup](../server/src/bot-setup.ts), [memory](../server/src/agent/memory.ts), [jobs](../server/src/agent/jobs.ts), [loop](../server/src/agent/loop.ts), [onboarding tests](../tests/onboarding.test.mts), [CLI integrity regressions](../tests/cli-tool-integrity-regressions.test.mts) |
| Model/CLI execution | [model routes](../server/src/routes-models.ts), [model client](../server/src/lib/llm.ts), [CLI](../server/src/cli), [CLI app tests](../tests/cli-apps.test.mts), [manifest tests](../tests/cli-tool-manifest.test.mts), [provider qualification](provider-qualification.md) |
| Authorization/connections/MCP | [tool policy](../server/src/agent/tools.ts), [Composio](../server/src/composio.ts), [gateway policy](../server/src/platform/composio-policy.ts), [MCP](../server/src/mcp), [policy tests](../tests/app-text-policy.test.mts), [capacity tests](../tests/mcp-capacity.test.mts), [gateway tests](../tests/gateway-isolation.test.mts) |
| Computers/files | [computer providers](../server/src/computers), [host mounts](../server/src/runtime/host.ts), [file policy](../server/src/security/files.ts), [companion](../companion/swarm-companion.mjs), [browser recovery](browser-recovery.md), [task board](task-board.md) |
| Voice/messaging/routines | [voice](../server/src/voice.ts), [speech](../server/src/lib/speech.ts), [messaging](../server/src/messaging), [routines](../server/src/routines.ts), [voice queue tests](../tests/voice-assignment-queue.test.mts), [speech tests](../tests/speech-routing.test.mts), [routine limits tests](../tests/routine-limits.test.mts) |
| Isolation/backup/recovery | [qualification guide](tenant-qualification.md), [release gates](../server/src/platform/release-policy.ts), [backup scheduler](../server/src/runtime/backups.ts), [backup lifecycle tests](../tests/backup-lifecycle.test.mts), [containment tests](../tests/container-containment.test.mts), [recovery operations](tenant-recovery-operations.md) |
| Capacity/operations/migration | [capacity operations](tenant-capacity-operations.md), [monitoring](tenant-monitoring.md), [migration implementation](legacy-migration-implementation.md), [capacity tests](../tests/tenant-capacity.test.mts), [migration tests](../tests/migration-coordinator.test.mts), [operations tests](../tests/operations-metrics.test.mts) |
| Clients/distribution | [native client](../apple/Swarm/AppModel.swift), [Apple script](../scripts/apple.sh), [Mac workflow](../.github/workflows/release-mac.yml), [native guide](apple-apps.md), [Mac distribution](mac-distribution.md), [platform native auth tests](../tests/platform-native-auth.test.mts) |
| Usage/administration/commercial policy | [usage](../server/src/usage.ts), [accounts](../server/src/accounts.ts), [usage tests](../tests/usage.test.mts), [MIT license](../LICENSE), [third-party notices](../THIRD_PARTY_NOTICES.md); payment implementation must be designed under S04 |
| Historical planning and traceability | [scorecard](commercial-readiness.md), [first-user PRD](first-user-fix-prd.md), [first-user reliability plan](first-user-reliability-master-plan.md), [public-release fix plan](public-release-fix-plan.md), [original audit](2000-user-release-prompt.md) |

Existing test commands requiring PostgreSQL, containers, paid providers, or Apple tooling need the appropriate isolated environment. Tests that skip those dependencies cannot be counted as qualification of those paths. The final declaration is **100% for the versioned supported product only after all mandatory requirements and G01–G08 have accepted evidence**.


