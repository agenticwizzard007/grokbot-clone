# Fix PRD: make Swarm reliable for its first users

Version 1 — 2026-11-11.

**Document status:** ready to use as an implementation prompt. **Product status:** fixes and live qualification remain open. This document does not report that the implementation agents have started or that any fix has landed.

Give this entire document to the coordinating coding agent. Section 12 contains its launch prompt; section 13 contains the worker assignment template. The coordinator must spawn the bounded implementation workflow, integrate the changes and carry the work through the acceptance gates rather than return another plan.

Background: [first-user reliability master plan](first-user-reliability-master-plan.md), [broader fix plan](public-release-fix-plan.md), [source audit and scaling analysis](2000-user-release-prompt.md).

## 1. Product objective and current baseline

Deliver a reliable workflow in which a real user signs in, selects their model, delegates work among agents, reads a connected app, uses files on a computer, approves an external write, receives the actual result and resumes safely after interruption. Saved work must be recoverable, and the restored service must be usable.

The initial population is a small controlled group. The broader target is **2,000 registered users with fewer concurrently active**; this PRD does not substitute a first-user pass for fleet qualification.

Known source/evidence:

- Audited source: `7e67b384b6ecccf17f322b61a2a10e4de5a3d1d8`.
- Latest inspected coordinator receipt: standalone `swarm-team` v28 at `dbdbc1715d8349a32ad6f6344988a91507d0ae63`; health and Google sign-in redirect passed. This document did not freshly verify the live deployment or complete authenticated user journey.
- The intervening diff changes Google authentication/cleanup, a Composio cleanup helper and tests. It does not fix the audited default approval classifier or the other product paths addressed here.
- Existing audit tests/builds and coordinator receipts are baselines. They are not evidence of the changes this PRD requests.
- Preserve the landed Google sign-in/cleanup, durable admin-bootstrap marker, tenant companion readiness, session/revision locks, native consent guards, native CLI tools and truthful partial usage accounting.

Refresh actual main, open work, deployment, runtime images and configuration before editing. Start from current reviewed main that contains the latest auth fixes; do not implement against an obsolete audit checkout and accidentally revert newer work.

## 2. Scope and non-negotiable behavior

**In scope:** all F01–F13 first-user blockers below, including known standalone, isolated and native defects. Fix the identified code defects across the supported roles. Qualify every path promised to the initial users. Missing infrastructure or devices can block evidence, but must not halt unrelated implementation.

The coordinator cannot quietly reduce scope to a web-only, API-only or non-isolated product to mark the PRD complete. A narrower pilot requires an explicit recorded owner decision and stays separate from completion of the other supported paths.

**Outside this milestone unless newly necessary:** 2,000-user load qualification, multi-region operation, automatic fleet sizing, large-fleet retention redesign, a new payment product, push/offline/background voice and a custom updater. Existing-account migration remains separately gated; never treat a new-account test as proof that legacy cutover works.

Preserve these invariants:

1. No foreign account, connection, computer, credential, file or task is usable.
2. Connected-app writes/unknown actions require the current applicable approval policy; intentional saved grants and denials remain meaningful.
3. Browser/shell/desktop consent is a separate capability boundary. Do not introduce blanket approval prompts for every command.
4. No silent model, account, execution-host or billing fallback.
5. Durable actions are dispatched under current authorization. Lost responses produce reconciliation or explicit uncertainty, never blind external-write retries.
6. Cancellation stops queued work; an external write already accepted by a provider is not falsely described as undone.
7. No hidden account-wide generation queue or reduced subscription concurrency to conceal resource or race defects.
8. Host/platform secrets stay outside tenant app/desktop/CLI/MCP workloads. Keep required containment controls enabled.
9. Recovery preserves one authoritative writer, exact ownership and fresh readiness; restored pending actions and sensitive grants require reconciliation.
10. No fabricated provider, device, image, approval, backup or load receipts.

## 3. Requirements and coverage

Priority here is implementation/release urgency, not a CVSS score. Confirmed code defects must get reproducing regressions. Unqualified behavior must be exercised; fix newly demonstrated failures rather than rewriting working components speculatively.

| Requirement | Blocker / original audit | Required result | Ticket |
| --- | --- | --- | --- |
| FR01 | F01 / D01 | Default app authorization uses trusted pinned metadata and current policy, never read-like words inside an action name. | T01 |
| FR02 | F02 / D11 | Real supported hosted/bridge model accounts complete the latest native tool workflow on compatible versions. | T06 |
| FR03 | F03 | Coordinator/specialist delegation, approval pause, cancellation, disconnect and restart retain truthful durable state. | T06 |
| FR04 | F04 / D17–D19 | Native linking retains the initiating account/session; partial success reconciles; Google status and consent match the role/mode. | T02 |
| FR05 | F05 / D16 | Uploaded/Library input reaches the selected computer; computer output returns as an authorized downloadable file. | T04 |
| FR06 | F06 / D23 | Private direct-key catalog discovery and inference use the same account-bound credentials and base URL. | T05 |
| FR07 | F07 / D20 | The promised shared or private voice flow works in isolation with correct authorization, revocation and billing. | T05 |
| FR08 | F08 / D15/D05/D06 | Full-backup failure does not starve DB protection; supported data can be restored and safely returned to service. | T03 |
| FR09 | F09 / D03 | The supported one-user concurrent workload fits measured guest/container budgets with backup/recovery headroom. | T04 |
| FR10 | F10 / D12 | Actual selected-computer/native-client pairing, input, permissions, cancellation and resume work on the candidate. | T07 |
| FR11 | F11 / D10 | Task/computer/backup failures are visible, reach an accountable operator and have a tested recovery path. | T08 |
| FR12 | F12 / D09/D21 | An actual isolated account boots usable workloads under qualified images, provenance and containment. | T08 |
| FR13 | F13 / D14 | Users see truthful progress/error/cancel states; measured warm/cold task latency meets the agreed contract. | T06 |

Two completion levels must stay distinct: **CODE CANDIDATE** means implemented and locally/integratively tested; **VERIFIED FOR USERS** additionally means all applicable real provider/device/infrastructure/recovery gates pass on the release candidate.

## 4. Agent team and scheduling

Use at most **four active agents total: one coordinator and up to three workers**. If fewer slots exist, serialize work. A reviewer occupies a worker slot. Reuse/follow up with workers where the environment supports it; do not recursively create uncontrolled agent trees.

| Agent role | Assignment | Responsibilities |
| --- | --- | --- |
| COORD | Integration/release coordinator | Source inventory, task ledger, file leases, interface decisions, common wiring, PR integration, exact-candidate validation, owner inputs and release decision. |
| SECURITY | T01 | App approval classification/dispatch correctness and regressions. |
| IDENTITY | T02 | Native linking, session binding, role response contracts and consent text. |
| DATA | T03 | Backup scheduling, bounded journals, recovery and scratch-space correctness. |
| FILES | T04 | File exchange and measured one-user runtime resources. |
| PROVIDERS | T05 | Private-key catalogs and isolated voice integration. |
| FLOW | T06 | Live tool/delegation lifecycle, fault handling, progress and the first-user harness. |
| CLIENT | T07 | Computer/native qualification, iOS runtime tests and distribution readiness for included channels. |
| FOUNDATION | T08 | Release provenance, actual isolated foundation, basic operations and recovery support. |
| REVIEW | T09 | Independent adversarial review and acceptance verification; does not approve its own implementation. |

These are roles scheduled over time, not ten simultaneous sessions.

**Launch sequence**

1. COORD records source/scope/input state and creates isolated task worktrees. Spawn SECURITY/T01, IDENTITY/T02 and DATA/T03 immediately for independent code work.
2. As each returns a stable commit and releases its leases, review/integrate it and use the slot for FILES/T04, PROVIDERS/T05 or FOUNDATION/T08 according to dependency readiness. Do not wait for missing live credentials to hand off an otherwise stable code increment.
3. Start FLOW/T06 after the approval contract and required file/provider interfaces are integrated. It can create the fixture/oracle specification earlier if it does not occupy a slot needed for blocking fixes.
4. Start CLIENT/T07 after IDENTITY stabilizes native-auth files. Client qualification can run alongside FLOW and FOUNDATION within the slot cap.
5. Use REVIEW/T09 on each security/data-sensitive increment and on the final candidate. Reserve a slot by finishing/freezing another worker first.
6. COORD integrates and reruns affected seams; assemble the compatible candidate; execute authorized live/device/recovery tests and close the evidence matrix.

Use native collaboration APIs actually available in the environment. If unavailable, use documented Conductor cloud session controls after checking their help/environment; give each session an explicit task-worktree path and scope. Do not invent tool calls, override models without instruction, or change the shared root to accommodate a worker.

## 5. File ownership and integration protocol

COORD alone manages the integration branch and common wiring. Workers operate in their assigned worktrees, never switch/reset/stash the shared checkout, and never change another task's files without an explicit recorded lease transfer.

| Surface | Owner / handoff rule |
| --- | --- |
| Root/server/web package manifests, lockfiles, shared test-runner lists, release status | COORD integrates worker requests; avoid dependency churn unless required. |
| Shared application/platform route mounts, deployment configuration, platform directory/schema | COORD owns integration. Workers supply exact schema/API/mount requests with compatibility and tests; COORD applies them before declaring integrated passes. |
| agent/tools.ts | SECURITY first for policy. FILES may then receive a scoped lease for truthful file-tool contracts; later changes require coordinator assignment. |
| agent/loop.ts | SECURITY first if approval integration needs it, then FLOW after the security commit is integrated. No simultaneous edits. |
| composio.ts / platform/composio-policy.ts | SECURITY. IDENTITY preserves Google cleanup changes and requests any shared helper changes through that owner. |
| AppModel.swift / SignInAttempt.swift / native-auth.ts / platform/auth.ts | IDENTITY first; CLIENT receives any necessary native-file lease only after IDENTITY freezes. |
| runtime/host.ts | DATA first if backup wiring needs it, then FILES for mounts/resources, then FOUNDATION only if readiness wiring requires a further change. Serialize and retest each handoff. |
| Provider catalog/key/voice modules | PROVIDERS. FLOW consumes their contract and requests changes rather than editing concurrently. |
| operations-metrics.ts / monitoring examples / release-policy and gate CLI | FOUNDATION, coordinating the backup-status contract with DATA. |
| .github/workflows/apple.yml / scripts/apple.sh / Apple test configuration | CLIENT. Shared workflow changes and required checks are reviewed by COORD before integration. |
| New first-user harness/fixtures | FLOW. REVIEW uses an independently checked outcome oracle and may add separate adversarial fixtures within an agreed scope. |
| Existing tests | Corresponding production-code owner; overlapping test-file changes require the same lease protocol. |

A branch does not eliminate semantic conflicts. Before a handoff, record base SHA, commit, exact changed paths, public interfaces, tests, caveats and file hashes. Rebase/merge the next worker onto the integrated handoff through normal Git operations in its worktree. After resolution, validate the new exact source; never attach an earlier green result to changed code.

Required interface decisions, recorded before consumers implement:

- Authorization: source/identity of trusted metadata, pinned version, default-policy decision, explicit saved grant behavior and execution-time revalidation.
- Native identity: first-party initiating-session proof, expiry/replay rules and partial-link state.
- Backup: journal version, per-scope snapshot timestamp, bounded pending work, status compatibility, crash migration and ownership.
- File exchange: owner/generation/grant binding, canonical user-data root, path mapping, transfer atomicity and revocation.
- Providers: credential/base-URL resolution and cache invalidation per account; voice session authorization/funding.
- Task state: durable task/action IDs, terminal/uncertain/waiting states, visible progress and cancel semantics.

## 6. Implementation tickets

### T01 — Correct default approval and dispatch policy

**Priority:** first security fix. **Agent:** SECURITY.

**Starting code:** [policyFor in agent/tools.ts](../server/src/agent/tools.ts), [isReadOnlySlug in composio.ts](../server/src/composio.ts), [trustedReadOnly and ConnectionGateway](../server/src/platform/composio-policy.ts), [native callback processing](../server/src/agent/loop.ts).

**Fix exactly:**

- Reproduce the current auto-allow for a mutating slug containing GET/LIST/SEARCH/CHECK, including `GITHUB_CREATE_A_CHECK_RUN`. Include absent/conflicting metadata and a real execution-path test with a provider witness.
- Remove slug-name inference from default permission decisions. Reuse the trusted metadata concept already present for setup, but make the ordinary text/native CLI path obey it.
- Decide how synchronous `policyFor` receives a trusted version-bound snapshot or transitions to async authorization. Missing/stale metadata must ask; do not add a network wait to every UI label or treat a display cache as authoritative execution permission.
- Keep explicit saved grant/deny behavior and setup's stricter read-only requirement. Batch/wrapped app calls must inspect every contained action; one blocked action cannot be hidden inside a nominal read.
- Revalidate the connection owner/revision, selected action/arguments and applicable authorization after waits and at dispatch. A tool version or read/write classification change must not inherit stale default approval.
- Preserve one durable dispatch identity and exact stored-action resume. Report uncertainty on lost provider results.

**Tests:** expand [app-readonly](../tests/app-readonly.test.mts), [app-connections](../tests/app-connections.test.mts), [Composio](../tests/composio.test.mts), [native tools](../tests/cli-native-tools.test.mts) and the native transport seam as needed.

**Acceptance:** no unapproved default write/unknown tool reaches the witness; intentional saved grants still work; denies/revocation win; account/connection/argument substitutions fail; approval/resume has one accounted external outcome; independent reviewer clears the final patch.

### T02 — Fix native identity linking and truthful account state

**Agent:** IDENTITY. **Starting code:** [AppModel.swift](../apple/Swarm/AppModel.swift), [SignInAttempt.swift](../apple/Swarm/SignInAttempt.swift), [native-auth.ts](../server/src/native-auth.ts), [platform/auth.ts](../server/src/platform/auth.ts), [Google auth](../server/src/auth/google.ts), [AppSettings.tsx](../web/src/components/config/AppSettings.tsx).

**Fix exactly:**

- Native Google currently detects linking but only OpenRouter prepares an authenticated ticket. Add a secure account/server/session-bound native Google link flow in supported server roles.
- Retain the initiating first-party session binding through Apple completion and OpenRouter final exchange. Limit session material to the intended first-party origin; never forward the platform browser cookie to providers or tenant VMs.
- Recheck account, server origin and session/recent-auth status after async boundaries. Keep PKCE/state, one-use exchange, expiry and replay protections; do not replace missing binding by email-based merging or weakened server validation.
- Reconcile OpenRouter partial success: provider identity/key delivery may already be durable before native exchange fails. Retry/cancel must report actual state, avoid duplicate or foreign links and permit safe user recovery.
- Align standalone/platform auth response fields, including `googleLinked`; display OIDC-only versus Gmail-backed consent accurately.
- Preserve the latest Google cleanup claim/promotion transaction and immutable identity fixes on main.

**Tests:** [native auth](../tests/native-auth.test.mts), [platform native auth](../tests/platform-native-auth.test.mts), [Google auth](../tests/google-auth.test.mts), [Google/Composio auth](../tests/google-composio-auth.test.mts), [Apple auth](../tests/apple-auth.test.mts), plus native/client contract tests.

**Acceptance:** linking from an existing phone/Apple account retains its immutable account; collision, wrong session, expired/revoked session, server switch, cancel and replay are safe; partial OpenRouter success is recoverable and truthful; signed-device completion remains LIVE_PENDING until actually exercised.

### T03 — Remove backup starvation and prove safe recovery

**Agent:** DATA. **Starting code:** [HostBackups](../server/src/runtime/backups.ts), [backup format](../server/src/platform/backup.ts), [upload fencing](../server/src/platform/backup-upload.ts), [storage](../server/src/platform/backup-storage.ts), [environment recovery](../server/src/platform/environment-operations.ts), [installer](../server/src/runtime/install-environment.ts).

**Fix exactly:**

- Reproduce full-profile failure repeatedly selecting environment snapshots while DB timestamps never advance; reproduce a stalled full upload occupying the sole pending slot.
- Replace this priority coupling with bounded durable per-scope scheduling/journaling. A failing full backup must not indefinitely block DB snapshots when their own key/database/storage prerequisites are available. A versioned two-lane journal is a candidate, not permission for unbounded queues.
- Preserve each pending bundle's snapshot time and ownership. A late full upload must not regress a newer DB watermark; completion time must not misrepresent snapshot freshness.
- Safely migrate the old journal, resume pending bytes after restart, protect every active pending directory from orphan cleanup, and retain per-attempt upload fences.
- Bound retry, pending bytes and scratch use; preflight space and reserve enough for the declared supported workload. Align growth policy with the recoverable-data envelope. Do not remove encryption, path checks or size bounds to hide failures.
- Coordinate any status/API/schema changes with COORD and FOUNDATION so backup health cannot report stale data as healthy.
- Exercise restore into an unpublished target. Reconcile sensitive grants and pending actions, fence original writer/background dispatch, establish replacement identity/readiness, activate the correct route and complete a new controlled task.
- For the standalone pilot, provide an actual selected-path backup/restore procedure and staged recovery proof; the isolated scheduler fix alone does not qualify shared SQLite recovery.

**Tests:** [backup lifecycle](../tests/backup-lifecycle.test.mts), [uploads](../tests/backup-upload.test.mts), [storage](../tests/backup-storage.test.mts), [environment operations](../tests/environment-operations.test.mts) and relevant migration/manifest compatibility suites.

**Acceptance:** failing full backup does not starve DB protection; restarts and late acknowledgements preserve current state; disk failures are visible; supported data restores correctly; exactly one serving writer returns; user retrieves saved output and completes a new task without replaying restored writes. Real storage/PITR evidence stays pending until measured.

### T04 — Connect Library to the computer and fit one busy user

**Agent:** FILES. **Dependencies:** DATA's host handoff; SECURITY's tool-contract handoff where needed.

**Starting code:** [runtime host mounts](../server/src/runtime/host.ts), [computer adapter](../server/src/computers/local.ts), [file tools](../server/src/agent/tools.ts), [companion](../companion/swarm-companion.mjs), [container policy](../server/src/runtime/container-policy.ts), [tenant sizing](../server/src/platform/fly-tenants.ts).

**Fix exactly:**

- Replace the isolated gap between app `/files` and desktop `/home/agent` with a narrow owner-bound exchange: a dedicated user-file mount or authenticated transfer mechanism with explicit read/write behavior. Choose and document the design before implementing both ends.
- Make tool descriptions and actual paths agree. Support uploaded input → desktop operation → downloadable output across the supported computer paths.
- Bind access to owner/current runtime and applicable grants. Canonicalize paths, reject traversal/symlink escapes, prevent database/credential/profile-secret exposure, and use atomic completed-output publication.
- Recheck authorization after uploads/transfers/waits. A revoked grant or switched account/computer cannot finish publishing to the old context unnoticed.
- Measure app, desktop, CLI/MCP and host overhead for coordinator + specialist + browser/viewer + backup. Current isolated ceilings can exceed a 4 GiB guest; also measure the actual standalone configuration.
- Set documented compatible budgets or a safe reviewed resize path from measurements. Preserve subscription concurrency and per-Bot ordering. Do not just raise host RAM while leaving incompatible runner limits unnoticed.

**Tests:** [tenant desktop](../tests/tenant-desktop.test.mts), [MCP folders](../tests/mcp-folders.test.mts), [native computer](../tests/native-computer.test.mts), [tenant capacity](../tests/tenant-capacity.test.mts), new file-exchange regression cases.

**Acceptance:** input/output hashes and expected contents match; unauthorized/path-escape/revoked access fails; no application secrets enter shared files; chosen concurrent workload completes without unexplained OOM or disk exhaustion. Real mount/kernel claims require the FOUNDATION host test.

### T05 — Align model discovery and isolated voice

**Agent:** PROVIDERS. **Starting code:** [routes-models.ts](../server/src/routes-models.ts), [lib/llm.ts](../server/src/lib/llm.ts), [private keys](../server/src/providers/private-keys.ts), [provider routes](../server/src/providers/routes.ts), [voice provider](../server/src/lib/voice-provider.ts), [voice.ts](../server/src/voice.ts).

**Fix exactly:**

- Route private direct-key model discovery through the same account-bound credential/base-URL resolution used for inference. Do not require a forbidden shared tenant environment key.
- Scope catalog caches to the correct provider/account/credential version; invalidate safely on rotation/revocation/account switch. Never log keys or let an old catalog response overwrite a newer selection.
- Preserve direct, personal OpenRouter and CLI modes and selected-model/effort semantics. An empty/error catalog gets a truthful state and retry path, not hidden billing/model fallback.
- Preserve the intended shared-admin voice experience for isolation unless the owner explicitly chooses per-user-key voice. Implement a trusted platform-mediated voice session/transport with user authorization, quotas/usage attribution, expiry and revocation; keep the shared long-lived key out of tenants.
- Use provider-supported short-lived credentials if suitable, otherwise a scoped authenticated transport. Verify actual provider capabilities; do not invent token endpoints or distribute a root key as a shortcut.
- Keep private-key voice working and make funding mode visible. COORD owns shared route mounting; propose the complete authenticated API contract and denial cases.

**Tests:** [models](../tests/models.test.mts), existing voice/usage/provider tests, new platform/tenant voice contract tests and account/cache race regressions.

**Acceptance:** key save/select → catalog → selected-model inference agrees across two accounts; rotation/revocation invalidates access; included shared/private voice flows work without secret leakage or wrong billing. If provider/service inputs are missing, finish local code/contracts and report LIVE_PENDING; do not silently force BYOK and mark FR07 done.

### T06 — Close the real coordinator workflow and fault handling

**Agent:** FLOW. **Dependencies:** T01 and required T04/T05 interfaces integrated; consume T02 contract for included clients.

**Starting code:** [agent/jobs.ts](../server/src/agent/jobs.ts), [agent/loop.ts](../server/src/agent/loop.ts), [native tools](../server/src/cli/native-tools.ts), [tool callbacks](../server/src/cli/tool-callback.ts), [runtime subscription transport](../server/src/runtime/subscription-client.ts), [bridge](../companion/cli-bridge.mjs), [Transcript.tsx](../web/src/components/Transcript.tsx).

**Fix/qualify exactly:**

- Build an automated first-user harness with independent fixture truth and outcome observation. Use actual application HTTP/tool/job paths and fixture providers for deterministic failure injection, then a separately authorized real-provider mode.
- Pin compatible application/runner/bridge versions. Reject unsupported old bridge/native tool capabilities with an update instruction.
- Prove coordinator → specialist → coordinator completion, correct context/account/computer and genuine use of the returned result.
- Exercise approval pause/resume, concurrent supported Bots, reconnect and restart. Every acknowledged job must have a truthful durable state; fix any demonstrated gap in persistence/reconciliation.
- Cancel queued callbacks; reconcile in-flight outcomes. Test lost success responses and duplicate callback/dispatch IDs without repeat external writes.
- Preserve provider expiry, policy refusal, quota and unavailable-usage semantics; no hidden API fallback.
- Instrument actual task admission, cold wake, catalog, model/tool and final response stages. Render real queued/running/waiting/completed/error/canceled/uncertain states with useful next actions.
- Final subscription text is currently buffered. If incremental text is promised, implement and test it across all applicable transports; otherwise explicitly document buffering while meeting the approved responsiveness contract. Never synthesize fake progress.

**Tests:** [CLI HTTP chat](../tests/cli-chat.mjs), [native transport](../tests/cli-native-transport.test.mts), [isolated native transport](../tests/cli-native-isolated-transport.test.mts), [CLI concurrency](../tests/cli-concurrency.test.mts), new first-user harness/fixtures with declared paths.

**Acceptance:** the section 8 journey and failure matrix pass on the integrated candidate; output facts/files/provider effects match independent expectations; real-account receipts name the actual provider/model/effort and both device sessions. Previously passing older CLI live tests cannot close the newest path automatically.

### T07 — Qualify computer/native behavior and public delivery

**Agent:** CLIENT. **Dependencies:** IDENTITY handoff, applicable FILES interface and candidate backend.

**Fix/qualify exactly:**

- Extend [scripts/apple.sh](../scripts/apple.sh) and/or [Apple CI](../.github/workflows/apple.yml) to execute the iOS XCTest target on a supported simulator, retaining Mac lifecycle/policy tests.
- Test the actual selected computer identity/readiness, browser/file use, screenshot/input, denial/revocation, Stop/Disconnect/logout, sleep/reconnect and existing-browser preservation. Repair reproduced faults within the assigned modules.
- Qualify final native auth/linking, files, microphone/audio, Action Button and resume on supported physical devices where included.
- Run the reviewed [Mac distribution workflow](../.github/workflows/release-mac.yml) with protected credentials only when authorized; qualify the actual quarantined download and advertised architectures. Keep credential cleanup and credential-free smoke separation.
- Provide a repeatable iOS archive/export/TestFlight path and complete the actual public distribution gates if those channels are launching.
- Correct old signing instructions to point to [mac-distribution.md](mac-distribution.md). Do not replace the reviewed workflow with the incomplete legacy sign helper.

**Acceptance:** candidate-specific device receipts cover the included journeys. Simulator build/ad-hoc signing is not real signing, Intel runtime or physical-device evidence. Missing hardware/signing access is an explicit gate; finish CI/code/docs while it is pending.

### T08 — Make the isolated foundation and basic operations real

**Agent:** FOUNDATION. **Dependencies:** approved infrastructure/image inputs; DATA/FILES host contracts; provider witness inputs.

**Starting code:** [release-policy.ts](../server/src/platform/release-policy.ts), [release-gates-cli.ts](../server/src/platform/release-gates-cli.ts), [platform roles](../infra/platform), [tenant image tooling](../infra/tenant-host), [operations metrics](../server/src/platform/operations-metrics.ts), [monitoring](../infra/monitoring).

**Fix/qualify exactly:**

- Unify required provenance validation between runtime admission and the operator verifier. Validate required image-bound approved gates, digest/reviewer shape and the applicable withdrawal/freshness rules consistently.
- Treat old unprovenanced rows as requiring reconciliation. Do not populate gates from fixtures, invent approval, or fetch arbitrary evidence URLs from tenant-controlled input during admission. Evidence needs a trusted archived/reviewed path.
- Refresh actual platform/provisioner/gateway/PG/TLS/LISTEN, KMS/IAM/storage and provider configuration; do not recreate existing paid resources based on stale docs.
- Build compatible immutable images, scan/remediate and obtain reviewed dispositions. Keep publication/admission fail-closed on unmet policy.
- Run actual host cgroup/resource/network/mount/metadata/namespace tests; boot app plus authenticated companion readiness and verify owner/generation bindings.
- Deploy the minimal real monitoring/alert path: task/computer availability, backup age/pending errors, disk/resource pressure and independent monitor failure. Test delivered alert, acknowledgement and resolution with the named operator.
- Coordinate actual tenant restore and platform PostgreSQL recovery for the isolated path, plus selected standalone recovery where relevant. Record achieved recovery objectives.

**Tests:** [release gates](../tests/release-gates.test.mts), [containment qualification](../tests/containment-qualification.test.mts), [operations metrics](../tests/operations-metrics.test.mts), [runtime operations](../tests/runtime-operations.test.mts), actual [host qualification harness](../infra/tenant-host/qualification/README.md).

**Acceptance:** a real isolated account is usable under accepted images and enforced controls; a second synthetic account cannot access its resources; real failures alert and recover; fixture evidence remains separate. No production mutation or paid provisioning occurs without the applicable authorization.

### T09 — Independent adversarial review and final acceptance

**Agent:** REVIEW. **Dependencies:** stable increments and final candidate; read-only source review unless separately assigned test files.

- Check authorization metadata/saved policy/dispatch seams; reproduce the original unsafe case and challenge revocation/argument/connection races.
- Check native linking account/session/server boundaries and OpenRouter partial success.
- Check backup journal migration, late upload acknowledgements, orphan cleanup, disk reserve and one-writer restored activation.
- Check file exchange path/grant boundaries, provider cache identity and shared-voice credentials.
- Review code/source/image/config provenance and required gate closure; verify exact checked commits and hashes.
- Independently inspect fixture truth, downloaded artifacts and provider witnesses. Execute bounded adversarial tests; return concrete findings to the responsible owner.
- Recheck corrected findings and publish a scoped disposition. Never approve your own implementation or substitute a source review for live qualification.

## 7. Coordinator launch and handoff artifacts

Create a task-specific working directory outside product code, for example a new `.context/first-user-fixes/<run-id>/`. The coordinator chooses a unique identifier; do not overwrite previous evidence.

Required records:

| Record | Contents |
| --- | --- |
| scope.md | User-visible promise, supported paths/providers/devices, accepted exclusions, concurrency/data/latency/recovery contract, named owners. |
| inventory.json | Current main/deployed receipts, worktrees/uncommitted owners, image/client/runner/config/schema versions, available test resources. |
| tasks.md | FR/F coverage, agent, worktree/base, priority, dependencies, state, blocked input, next action and review result. |
| ownership.json | Exclusive path leases and ordered handoffs; shared wiring requests. |
| briefs/ | Self-contained assignments produced from section 13 and the exact ticket text. |
| handoffs/ | Stable commit/PR, changed paths/hashes, interfaces, test commands/results, evidence limitations and rollback notes. |
| evidence/ | Sanitized fixture/live/device/recovery receipts with candidate identity and independent oracle outcomes. |
| release-decision.md | Exact GO/NO-GO scope, requirement closure, remaining accepted limitations, operator and rollout/rollback action. |

These record names are proposed artifacts to create during execution, not files that already exist.

Use task states **OPEN → IMPLEMENTING → LOCAL_PASS → INTEGRATED_PASS → LIVE_PENDING → VERIFIED** as applicable. Track **BLOCKED_EXTERNAL** for an individual missing input and continue other work; do not claim code completion satisfies a live gate. Only the owner can approve scope exclusions, and excluded requirements remain explicitly unverified.

Every worker handoff must include a stable offline increment even when live inputs are unavailable. Release its source leases while waiting. If later evidence requires edits, reacquire the lease and invalidate affected old receipts.

## 8. Acceptance contract and required workflow

Before qualification, record the supported dataset/file/profile size, coordinator/specialist/helper concurrency, chosen client/computer/provider mix, warm/cold wait and task-completion limits, recoverable-data window, restore time and allowed interruption. Define treatment of human approval wait and external model duration; report both end-to-end and stage timings.

The coordinator can propose values, but must not invent owner approval or silently redefine limits after seeing results. Missing numbers do not prevent local bug fixes; they prevent a readiness decision based on those measurements.

**Fixture/oracle:** a test brief, a controlled connected-app source, known comparison facts, required summary content, exact permitted external-record fields, expected file hashes where deterministic, and a provider-side outcome witness. Assistant claims are not the correctness oracle.

**Canonical user task**

> Read the uploaded test brief and designated connected-app source. Delegate the comparison to Researcher and return its findings to the coordinator. Produce a summary document using the selected computer. Show the exact proposed creation of one record in the designated private test destination and request approval. After approval, create it and return its URL and the downloadable summary.

Test with a fresh policy requiring the controlled write's approval; exercise saved grants in separate cases.

| Check | Required result |
| --- | --- |
| Account/provider | Same immutable account on two supported devices; actual selected provider/model/effort/host and billing source. |
| Read/delegate | Correct selected connection; real specialist handoff and returned result used by coordinator; no foreign context. |
| Computer/files | Uploaded input usable on the selected computer; output downloadable with expected facts/content. |
| Approval | Exact target/action/arguments displayed; no provider effect before required approval; decline/revoke prevents dispatch. |
| Approved write | One accounted outcome for the durable action; actual external URL/fields match the approved operation. |
| Refresh/reconnect | Pending approval/task/output state reconstructs correctly; missing streamed events do not become lost durable work. |
| Cancellation | Queued work stops; already-dispatched effects are recorded/reconciled or explicitly uncertain; no blind retry. |
| Provider failure | Expiry/quota/policy refusal is actionable and truthful; no account/model/API-billing fallback. |
| Restart | Every acknowledged job accounted for; no unsafe replay or indefinite invisible task. |
| Backup/recovery | Current recoverable data, supported disk/pause behavior, verified unpublished restore, original-writer fencing, replacement readiness/routing and a successful new task. |
| Resources/latency | Supported workload and measured timings meet the agreed contract, with no unexplained OOM or fabricated progress. |
| Ownership/operations | Second synthetic account access denied; actionable status and real alert/recovery owner. |

Required failure injections: canceled/declined approval, revocation during awaits, duplicate callback/dispatch ID, lost provider success response, disconnect before/after dispatch, expired login, quota refusal, server/runner restart, computer permission loss, invalid full-backup file, stalled upload, disk pressure and restore interruption.

Proposed first-user repeatability minimum: ten consecutive normal journeys including two cold starts and two same-account client devices, every applicable failure case, one verified staged recovery and one supervised working day. Agree this before execution. A repeatability pass is scoped to the named workload; it is not a fleet availability or 2,000-user claim.

## 9. Test/integration/rollout procedure

1. Each worker adds a failing regression for a confirmed defect, applies a minimal fix and runs the relevant suites in its isolated environment. For an unqualified path, add/execute the harness and fix observed failures.
2. COORD reviews handoffs, integrates dependencies and shared wiring into a clean candidate. Resolve conflicts semantically; rerun changed seams and preserve newer auth/security work.
3. Run locked-dependency server/web typecheck and build, deployment/admin, CLI/native transport, app/Composio, model/auth, backup/recovery and isolation tests appropriate to the candidate. Include newly added tests in the shared runners/CI.
4. Use a separate disposable PostgreSQL database per concurrent test run. Do not run integration suites against production or allow agents to share fixed ports/databases/node_modules while mutating them.
5. Run native simulator/macOS suites on the appropriate runners; record physical-device evidence separately.
6. Build matching application/runner/host/desktop/client artifacts. Run REVIEW against the exact candidate; fix findings and rerun affected checks.
7. Perform authorized staged live provider, computer, containment, alert and recovery qualification. Record each result against exact versions/configuration.
8. Freeze the passing candidate and evidence. Any subsequent source/image/config change invalidates relevant receipts until checked again.
9. Prepare reviewable PR(s), deployment steps, data compatibility, rollback and scoped stop conditions. Deploy/publish only under existing applicable authorization or obtain the missing final decision after the candidate is concrete.
10. On approved rollout, canary the named controlled user/path, verify the canonical journey and monitor the agreed period. Stop for unauthorized actions, foreign access, lost acknowledged work, corrupt output, uncontrolled duplicates or failed required recovery.

Existing entrypoints include:

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
npm run test:isolation
python3 -m unittest discover -s scripts/mac-release -p 'test_*.py' -v
node --test tests/provider-qualification.test.mjs
```

Run the isolation suite only with `TEST_DATABASE_URL` configured to the assigned disposable database. Verify commands against current package scripts. Add focused tests where these suites do not reproduce the defect; do not treat their current passing counts as the acceptance oracle.

Rollback must preserve compatible data and one writer. Do not restore a known approval bypass, weaken containment, delete the only recoverable copy or replay uncertain writes. If no secure compatible rollback exists, disable the affected path and report the limitation.

## 10. External inputs and blocked-work policy

Collect only the missing items, reusing valid prior authorization:

- Supported first-user path, real test-account aliases/subscriptions, selected model/app/computer and controlled write fixtures.
- Agreed correctness/workload/latency/recovery contract; operator and alert destination.
- Approved staging inventory/budget, qualified host, image signing/scanning policy, KMS/IAM/object storage, PG and provider configuration for isolation.
- Native devices, signing/provisioning/notarization access, candidate version/backend and public delivery decisions where applicable.

Secrets belong in protected stores, never in prompts, source, manifests or logs. Ask for names/status/access configuration, not raw private keys.

When a live prerequisite is absent: document the exact input, impacted requirements and next verification command; finish code, deterministic tests, integration and review; return a stable increment and free the slot. Do not mark the requirement verified or end the overall workflow while independent assigned work remains. Do not manufacture a receipt, use customer credentials without authorization, provision paid resources speculatively or bypass a fail-closed gate.

## 11. Definition of done

**Code candidate is complete only when:**

- All identified first-user code defects across the supported paths are fixed with reproducing regressions.
- Demonstrated workflow failures found during T06 are corrected, and known existing fixes remain preserved.
- Every FR has an implementation/qualification disposition, owner and exact evidence.
- Integrated build/tests and independent security/data review pass on the exact candidate.
- Compatible artifacts, instructions, data changes and rollback are reviewable in PR(s).

**Verified first-user readiness additionally requires:**

- Every promised path passes the actual canonical journey and failure cases.
- Output correctness, latency, supported workload, recovery window/time and interruption meet the pre-agreed contract.
- Live account/provider identity and effects, installed-computer behavior, actual recovery/return to service and operational alerts are demonstrated.
- Included native public-distribution and isolated-infrastructure gates pass.
- The release owner and independent reviewer sign a scoped GO with candidate identity and accepted limitations. Otherwise report NO-GO and precise remaining gates.

Final report: PR links/commits, coverage table, test/evidence matrix, unverified inputs, security review, measured first-user results and next safe rollout action. Do not report that the app is “fully fixed” when only the plan, fixtures or a narrower pilot are complete.

## 12. Copy-paste coordinator launch prompt

```text
You are the implementation coordinator for the attached Swarm first-user fix PRD.
Execute it. Do not respond with another plan or stop after delegating.

1. Read the complete PRD and repository instructions. Reconcile current main,
   deployment receipts and active owners before editing. The historical audit
   SHA is 7e67b384b6ecccf17f322b61a2a10e4de5a3d1d8; the latest inspected report
   was standalone v28/dbdbc17. Refresh these facts; preserve later auth fixes.
2. Create a unique run ledger and isolated task worktrees. Keep the shared root
   and unrelated user/agent work intact. Record source/file ownership and the
   acceptance contract. All F01-F13/FR01-FR13 remain tracked.
3. Spawn the available equivalent of SECURITY/T01, IDENTITY/T02 and DATA/T03.
   You plus workers may use at most four active slots total, or fewer if the
   environment permits fewer. No recursive unbounded spawning or model override.
   Give each worker the section 13 brief plus its complete ticket and invariants.
4. Continue orchestration and common wiring while they work. Inspect every
   result; require stable commits, source hashes, tests and caveats. Schedule
   FILES, PROVIDERS, FOUNDATION, FLOW and CLIENT as prerequisites and slots allow.
   Follow the path-lease and interface handoffs; never let two owners edit the
   shared agent loop, tool policy, native auth or tenant host simultaneously.
5. Require reproducing tests for confirmed defects, minimal fixes and exact-source
   revalidation. Do not rewrite working flows merely because live evidence is
   absent. Preserve approval, account/session/revision, one-writer, backup upload,
   native consent and no-billing-fallback invariants.
6. Schedule an independent REVIEW agent within the same slot budget. Route
   findings back, integrate corrections, and recheck affected seams. Authors
   cannot approve their own security/data changes.
7. Build the actual repeatable first-user harness with independent expected
   facts/files/provider effects. Test delegation, approval, file round trip,
   cancellation, provider expiry, lost responses, restart and safe recovery
   activation. Run the relevant integrated suites and compatible image/client
   builds, then authorized live/device/infrastructure tests.
8. Ask only for genuinely missing inputs and decisions, with the exact blocker.
   Reuse prior authorization. Never request secrets in chat or fabricate live
   qualification. Missing credentials must not stop unrelated code, tests or
   review. Mark live gates pending and return stable offline increments.
9. Create reviewable fix PRs and a final evidence/coverage matrix. Complete
   authorized integration. Do not merge, spend, deploy, publish or mutate real
   accounts beyond the authorization actually provided.
10. Finish with CODE CANDIDATE and VERIFIED FOR USERS stated separately, exact
    candidate identity, completed requirements, remaining gates, measured
    correctness/latency/recovery results and the next safe rollout action.
    Do not silently drop native/isolated/voice features to claim all issues fixed.
```

## 13. Worker assignment template

COORD fills every bracketed field with observed values before spawning; these placeholders are not executable commands or permission to guess IDs.

```text
Role: [agent role]. Ticket: [Txx plus the full ticket text].
Goal: implement and verify this ticket under the attached fix PRD.
Worktree: [absolute assigned path]. Base: [verified integrated commit].
Owned paths: [explicit lease list]. Shared paths: [owners/handoff rules].
Required interfaces: [approved contract or exact decision still needed].
Dependencies already integrated: [commits and evidence].
Acceptance: [ticket criteria plus applicable section 8 cases].

Read current code and preserve newer fixes. Add a reproducing regression for a
confirmed bug, then implement a focused correction. For unqualified behavior,
exercise the harness and repair actual failures. Do not weaken guards, invent
provider behavior, silently change billing/concurrency or fabricate receipts.
Work only in the assigned checkout and path leases. Do not change the shared
root, another owner's files, common dependencies or shared test databases.
Request a lease/interface decision through COORD when required; continue
independent work meanwhile. Do not spawn more agents.

Return a stable handoff: commit/PR, base, changed paths and SHA-256 hashes,
interface/schema changes, failing-before/passing-after evidence, exact commands
and results/skips, compatibility/rollback notes, remaining live/device inputs
and the precise next check. Do not claim a fixture is real provider evidence.
If external inputs are missing, finish the offline increment, report LIVE_PENDING,
and release your leases. Stop source edits after handoff until COORD reassigns them.
```
