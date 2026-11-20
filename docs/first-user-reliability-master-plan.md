# Swarm first-user reliability master plan

Prepared: 2026-11-11. Status: **OPEN — implementation and qualification required**.

This is the shared execution plan for making one person's real Swarm workflow safe, repeatable and recoverable. It describes the known blockers, how to close them and what evidence permits a first-user readiness decision. It does not claim that every feature is broken or that all listed workflows have failed in production.

The broader product target remains 2,000 registered users with fewer active concurrently. Fleet capacity is covered by the [public-release fix plan](public-release-fix-plan.md) and [full audit](2000-user-release-prompt.md). This milestone establishes a reliable first-user workflow before fleet qualification.

## 1. The outcome we must deliver

One named test user can:

1. Sign in to the intended account and return to it from a second supported device.
2. Connect their supported model subscription or API provider and select the intended model.
3. Ask a coordinator agent to delegate useful work to another agent.
4. Read an approved connected-app resource and use an uploaded input on the selected computer.
5. Review and approve a specific external write when required by their permission policy.
6. Receive a correct, downloadable result and a verifiable link to any external output.
7. Refresh, disconnect, cancel or encounter an expired provider session without losing account identity, silently changing billing or blindly repeating external writes.
8. Return after a process restart and see an accurate durable task state.
9. Recover their saved work from a tested backup if the application or storage fails.

Every supported outcome must be visible: completed, failed with an actionable reason, canceled, awaiting approval, or uncertain and awaiting reconciliation. A task must not appear successful merely because a model said it was successful.

## 2. Current evidence and deployment boundaries

| Fact | Evidence boundary |
| --- | --- |
| Audited local application source | Commit `7e67b384b6ecccf17f322b61a2a10e4de5a3d1d8`; no application fixes were made by this planning task. |
| Latest inspected deployment report | The release coordinator reports standalone `swarm-team` v28 at `dbdbc1715d8349a32ad6f6344988a91507d0ae63`, with passing health and the Google button reaching Google's sign-in through Composio. This is a coordinator receipt, not a fresh authenticated production journey performed for this document. |
| Intervening source changes | The local Git comparison from the audit SHA to the reported deployment SHA changes Google authentication/cleanup, a Composio cleanup helper and their tests. The connected-app approval classifier remains unchanged. The other audited product paths discussed here were not repaired by that diff. |
| Existing validation | The audit recorded typecheck/build, 211 CLI tests plus fixture HTTP smoke, and 90 selected auth/app/deployment tests passing. The coordinator also reports later integrated suites and earlier live model checks. These are scoped evidence; they do not certify the entire latest workflow on a signed-in user's devices. |
| Known completed fixes | Google sign-in restoration/cleanup and the earlier isolated companion handshake/readiness fix have landed according to the coordinator. Do not reopen them as missing implementation without a new regression. |

The older v27 deployment statements in historical audit documents are superseded by the v28 coordination receipt above. Refresh actual deployed release, images, configuration and source before implementation or qualification.

**Choose and record the first-user deployment explicitly:**

| Path | Meaning | Additional requirement |
| --- | --- | --- |
| Existing standalone service | Shared application/database/runtime with legacy per-user computers. Suitable for evaluating a controlled workflow if its own security and recovery requirements pass. | A successful pilot does not establish independently isolated application/runtime tenancy. |
| New isolated platform | Separate control plane and tenant application/desktop/CLI/MCP workloads. | Must first close the isolated infrastructure, containment, image, readiness and product-parity gates below. |
| User's Mac/personal bridge | Execution on a consenting user's machine. The selected computer and CLI execution host are separate settings. | Verify the actual installed versions, permissions and supported host combination. Do not silently switch between hosted and personal execution. |

Record the approved path, model provider, connected apps, computer, client versions and included voice/native features. An excluded feature must be clearly outside the first-user promise; do not count it as tested or silently leave a broken control in the promised journey.

**Agree the named workflow's acceptance contract before qualification:** supported input/file/profile sizes, agent/helper concurrency, warm response and cold-start limits, task-class completion limits, recoverable-data window, recovery time and permitted interruption. Define whether each timing includes provider execution and human approval waits; retain both end-to-end user timing and stage timings. Values remain owner decisions, not inferred guarantees. Results must meet the recorded limits to receive GO, or have an explicit approved deviation identifying the affected promise and decision owner.

## 3. What currently prevents a reliable workflow

The finding IDs refer to the full audit. “Unqualified” means adequate evidence is missing, not that a new failure has been reproduced.

| Blocker | Status and scope | Effect on the first user | Closure |
| --- | --- | --- | --- |
| F01 — Connected-app approval | Confirmed code defect, D01; general agent execution, including the native CLI callback path. | A mutating action with a read-like name can run under the default read-only classification. | Replace name-based default authorization, preserve explicit saved permissions and prove the write is blocked before required approval. |
| F02 — Latest model/tool workflow | Unqualified complete live journey, D11. Earlier model checks and latest fixture/control probes cover different portions. | We cannot yet establish that the actual selected account/model can discover apps, execute tools and finish the task on the latest transport. | Exercise real supported accounts and provider-side witnesses on the exact application/runner/bridge versions. |
| F03 — Coordination and failure recovery | Implemented components, incomplete end-to-end first-user evidence. No new coordination bug is asserted. | Delegation, an approval pause, disconnect or restart could leave the user unsure what ran or what needs attention. | Prove durable task state, handoff completion, cancellation boundaries and safe handling of uncertain external effects. |
| F04 — Native identity linking | Confirmed source defects D17–D19. Google native linking loses intent; isolated Apple/OpenRouter completion loses session binding; platform Google status is incomplete. | The wrong flow opens, linking fails, or the UI reports failure after OpenRouter has already linked. | Repair account-bound exchanges and reconcile partial success; verify the included native providers and roles on signed devices. |
| F05 — Files and desktop | Confirmed isolated integration gap D16; standalone/local file journeys still need end-to-end qualification. | A Library input is not automatically usable at its app path on the isolated desktop, and desktop output does not automatically become a Library download. | Implement a narrow owner-bound exchange and prove input → computer → output download. |
| F06 — Private API model discovery | Confirmed isolated direct-key defect D23. Personal OpenRouter/CLI catalogs are not implicated by this finding. | A valid private direct key can support inference while its model picker is empty. | Use the same owner-bound key/base-URL contract for save, catalog and inference. |
| F07 — Voice funding/configuration | Missing isolated shared-voice integration D20. | A new isolated user cannot assume that the administrator's shared key provides voice. | Deliver a trusted platform voice service or explicitly select per-user keys; test the advertised path and billing. |
| F08 — Recoverable work | Confirmed isolated backup starvation D15 plus disk/pause concerns D05/D06; real restore is unqualified for the chosen deployment. | A failing full snapshot can prevent current DB backups; work may not be recoverable when needed. | Fix scheduler independence where applicable, set a supported data envelope and restore an actual backup. |
| F09 — One busy user's resources | Capacity risk D03, not an observed universal crash. Isolated limits can exceed the default host; actual standalone sizing also needs measurement. | Multiple agents, CLI generation, browser work and backups may contend or terminate processes. | Measure the chosen workload and set compatible machine/container limits with headroom. |
| F10 — Computer control and native installation | Installed-device qualification missing, D12. Earlier development installs and CI do not establish the final native build's behavior. | Pairing, permissions, input, screenshots, cancellation or reconnect may not behave as the UI promises. | Test the actual client, companion and selected computer; complete public signing/store gates if distributing publicly. |
| F11 — Detecting and recovering failures | Operational evidence incomplete, D10. | A stuck computer, failed backup or dead server can leave the user without a clear explanation or recovery owner. | Deliver actionable status, basic alerting, a named operator and tested restart/restore instructions. |
| F12 — First isolated account foundation | Missing/unqualified live prerequisites D09/D21; historical staging inventory must be refreshed. | Even one account cannot be called a qualified isolated environment from templates or fixture passes. | Prove actual platform/PG/KMS/storage/provider/image configuration, fresh app/companion readiness, containment and enforced image provenance. |
| F13 — Response feedback | Known buffering limitation and unmeasured latency D14. | Final subscription text can appear only after generation completes, making long tasks feel stalled. | Show truthful task/tool progress, measure warm/cold timings and provide useful cancel/error states. Add incremental text if it is part of the agreed promise. |

Connected-app approval is distinct from browser/shell/desktop consent. Those capabilities can perform writes under their own granted scope. This plan preserves that distinction rather than inventing a per-action approval system for every command.

## 4. Fix and qualification workstreams

All workstreams start **OPEN**. Assign actual names before execution; the roles below are responsibilities, not existing assignments.

### A. Make external actions safe

**Owner:** security + agent execution. **Covers:** F01. **Dependency:** none for local fixes.

- [ ] Reproduce the current unsafe default with mutating tool names containing GET/SEARCH/CHECK, including the audited CHECK example.
- [ ] Use trusted, pinned read/write metadata; unknown/conflicting classification requires approval. Preserve deliberate saved grants, deny rules and revocation.
- [ ] Keep approval bound to the account, connection, action, arguments and current authorization revision.
- [ ] Cover API-model execution, subscription native MCP, setup, voice where included, approval/resume and canceled callbacks.
- [ ] Prove no invocation before required approval; one approved action has one accounted outcome. Uncertain provider outcomes require reconciliation instead of blind retry.
- [ ] Obtain independent review and a controlled provider-side witness.

**Source:** [composio.ts](../server/src/composio.ts), [agent/tools.ts](../server/src/agent/tools.ts), [agent/loop.ts](../server/src/agent/loop.ts), [composio-policy.ts](../server/src/platform/composio-policy.ts).

### B. Prove the coordinator can finish a real task

**Owner:** agents/CLI + integrations. **Covers:** F02/F03/F13. **Dependency:** A before testing writes.

- [ ] Pin compatible application, CLI runner and companion/bridge versions; record the actual provider, model, effort and execution host. An old personal bridge must receive an update instruction.
- [ ] Run a real account through login/profile reuse and a read-only tool task, then the approved-write journey below.
- [ ] Verify coordinator → specialist → coordinator handoff with a useful result and correct account/computer context.
- [ ] Inspect provider-side outcomes and produced files; match them to durable action/task records rather than relying on assistant text.
- [ ] Exercise same-account access from two devices, browser refresh, approval pause, cancellation, provider expiry and application restart.
- [ ] Prevent canceled queued calls from starting; record/reconcile already-dispatched calls honestly. Cancellation does not undo a write already accepted by a provider.
- [ ] Record admission, wake, model, tool, approval-wait and final-response timings; expose genuine activity and actionable errors. Preserve selected model/effort and billing source.

**Source:** [native-tools.ts](../server/src/cli/native-tools.ts), [tool-callback.ts](../server/src/cli/tool-callback.ts), [agent/jobs.ts](../server/src/agent/jobs.ts), [native MCP contract](cli-native-mcp.md), [provider qualification](provider-qualification.md).

### C. Repair identity and product integration for the chosen path

**Owner:** auth/product + runtime. **Covers:** F04/F05/F06/F07.

- [ ] Fix native Google linking with a secure initiating-account/session binding; do not merge accounts by matching email addresses.
- [ ] Fix isolated native completion binding and reconcile OpenRouter partial success. Test changed/expired/revoked sessions, collisions, replay, retry and cancellation.
- [ ] Return accurate Google-linked state and consent wording for the actual auth mode.
- [ ] Implement isolated Library/desktop file exchange with truthful paths, owner checks, path/symlink defenses and grant revocation. Keep app databases and credentials outside shared file access.
- [ ] Align isolated private direct-key model discovery and inference; test key rotation, empty/error catalogs and two synthetic accounts.
- [ ] Decide and implement the included voice funding path; keep shared platform credentials outside tenant workloads.
- [ ] Demonstrate each included feature on its actual server role and client. Web-only tests do not close native-client defects.

**Source:** [AppModel.swift](../apple/Swarm/AppModel.swift), [native-auth.ts](../server/src/native-auth.ts), [platform/auth.ts](../server/src/platform/auth.ts), [runtime/host.ts](../server/src/runtime/host.ts), [routes-models.ts](../server/src/routes-models.ts), [voice-provider.ts](../server/src/lib/voice-provider.ts).

### D. Preserve work and keep a busy user's session running

**Owner:** data/runtime + operations. **Covers:** F08/F09/F11.

- [ ] For isolated hosting, separate DB backup progress from failing full snapshots and pending full uploads without weakening upload ownership or generation fences.
- [ ] For the selected deployment, establish an actual backup of saved work and the necessary settings/credential recovery path. Define provider reauthentication where restoration intentionally resets access.
- [ ] Restore into a separate non-serving target; verify input/output hashes, history, task records and owner. Avoid replaying restored pending writes automatically.
- [ ] In an approved staged recovery drill, fence/stop the original serving writer and background dispatch; verify the replacement's readiness and account identity before activating the correct route. Keep the initial restored target unpublished until these checks pass.
- [ ] After activation, have the user retrieve saved outputs and complete a new controlled task. Prove one authoritative writer and no replay of restored external writes; record required reauthentication and consent.
- [ ] Measure temporary backup/restore space, interruption and failed-upload behavior at the supported data size. Check cleanup for this account; do not infer fleet cleanup throughput from it.
- [ ] Measure concurrent coordinator/specialist, CLI, browser, viewer and backup usage; fix resource incompatibilities rather than adding hidden account-wide generation queues.
- [ ] Surface failed/stuck work, backup age and computer/server readiness. Test a real alert and the operator's restart/restore procedure.
- [ ] Document the backup frequency, recoverable-data window, restore time and user-visible interruption actually achieved, and check them against the pre-agreed acceptance contract.

**Source:** [runtime/backups.ts](../server/src/runtime/backups.ts), [backup.ts](../server/src/platform/backup.ts), [install-environment.ts](../server/src/runtime/install-environment.ts), [container-policy.ts](../server/src/runtime/container-policy.ts), [recovery runbook](tenant-recovery-operations.md).

### E. Prove the selected computer and clients

**Owner:** computer/runtime + Apple client. **Covers:** F10 and device-dependent parts of F04/F05.

- [ ] Pair the intended computer and verify its live identity/readiness before declaring it available.
- [ ] Test screenshot, input, browser/file task and returned output on the installed candidate.
- [ ] Test permission denial/revocation, Stop, Disconnect, logout, sleep/reconnect and cancellation. Preserve an existing browser unless its owner explicitly grants the relevant access.
- [ ] If using native apps, validate new/returning auth, linking, files, microphone and resume on real supported hardware. Run iOS XCTest as well as the existing Mac tests.
- [ ] For a controlled internal native test, identify its development/TestFlight distribution and limits. For public delivery, complete the reviewed Mac Developer ID/notary/download process and applicable iOS App Store requirements.

**Source:** [native-computer tests](../tests/native-computer.test.mts), [Apple clients](../apple/Swarm), [Mac control guide](mac-control.md), [reviewed Mac distribution guide](mac-distribution.md).

### F. Qualify the isolated path when that is the first-user promise

**Owner:** infrastructure + runtime security. **Covers:** F12. **Dependency:** approved staging resources, images and secrets.

- [ ] Inventory working platform/provisioner/gateway roles, PostgreSQL TLS/grants/LISTEN, KMS context/IAM, versioned backup storage and provider configuration.
- [ ] Publish a compatible signed image set with fresh scans and reviewed dispositions; enforce the required provenance at admission.
- [ ] Boot a tenant through hold/bootstrap/refresh and fresh application plus authenticated companion readiness.
- [ ] Run actual-host network, namespace, cgroup, resource, filesystem/mount and metadata-endpoint tests. Keep required controls enabled.
- [ ] Use a second synthetic account to challenge owner/session/connection/resource separation. This is a boundary test, not a fleet load test.
- [ ] Complete this path's real provider, backup/restore and user journey; standalone evidence cannot close these rows.

**Source:** [tenant qualification](tenant-qualification.md), [containment harness](../infra/tenant-host/qualification/README.md), [release policy](../server/src/platform/release-policy.ts), [infrastructure decisions](tenant-infrastructure-decisions.md).

## 5. The repeatable acceptance journey

Use approved disposable data, a private test destination and an authorized provider account. Do not use an uncontrolled customer workflow as a test fixture.

**Record before each run:** run ID/time, source/image/client/bridge versions, server role, region, test-account alias, selected model/effort, CLI host, selected computer, connection alias, permission state and input hashes. Store credentials separately and sanitize logs.

Prepare a fixture pack with known source facts, expected comparison points, required output content, the exact permitted external-record fields and a provider-side outcome check. Evaluate the downloaded artifact and external state against those expectations. A plausible summary or the assistant's own success claim is not the correctness oracle.

**Representative task prompt**

> Read the uploaded test brief and the designated connected-app source. Ask the Researcher agent to compare them, then return its findings to the coordinator. Produce a summary document using the selected computer. Show me the exact proposed creation of one test record in the designated private destination and request approval. After approval, create that record and return its URL and the downloadable summary.

Use a fresh permission policy requiring approval for that controlled write; test explicit saved grants separately. Record provider outcomes independently.

| Step | Pass condition |
| --- | --- |
| Sign in and reconnect | The same immutable account is used on both supported devices; no unexpected new account or link confusion. |
| Select provider/model | Actual provider/model/effort and billing source match the selection; unavailable entitlement produces an actionable error. |
| Read source and upload | The agent reads only the selected authorized connection and can use the uploaded test input on the selected computer. |
| Delegate and return | The specialist receives the intended task/context, returns a useful result, and the coordinator incorporates it without duplicating the requested external action. |
| Prepare write | Exact target/action/arguments are visible; the provider witness confirms no write occurred before required approval. |
| Pause and resume | Refresh or close/reopen the client while approval is pending; the stored action and state remain correct. |
| Approve | The approved action has one accounted provider outcome; its real URL/content matches the requested test record. |
| Deliver output | The summary is downloadable, opens correctly and satisfies the fixture's expected facts/content; the external output matches the exact approved fields. |
| Return later | History, result links, files and task status survive application restart as designed. |
| Restore and return to service | Verify saved data and owner in an unpublished replacement; fence the original writer/dispatch, establish replacement readiness, activate the correct route, then retrieve saved output and complete a new task without replaying restored writes. |

**Proposed minimum repeatability evidence, to agree before execution:** ten consecutive normal runs on the exact candidate, including two cold starts and two same-account client devices, plus every applicable failure case below and one supervised working day. These are bounded first-user acceptance checks, not a statistical availability guarantee or a substitute for later fleet tests.

## 6. Failure cases that must be accounted for

| Injection | Required behavior |
| --- | --- |
| Decline approval | No provider write; task state and next choices are clear. |
| Revoke connection/session while waiting | The stored request cannot bypass current authorization. |
| Cancel before dispatch | Queued callbacks stop; no later hidden action starts. |
| Cancel or disconnect after dispatch | The result is recorded or marked uncertain; no blind duplicate write or false claim that an accepted write was undone. |
| Lose acknowledgement after provider success | Reconcile via durable/provider evidence where available; otherwise surface uncertainty for explicit resolution. |
| Expire provider login or hit quota/policy refusal | Clear reauthentication/limit error; no silent switch to a paid API or different identity/model. |
| Restart while a task or approval is pending | Every acknowledged task is accounted for as resumed, waiting, failed, canceled or uncertain; no unsafe replay. |
| Refresh/disconnect the client | The client reconstructs truthful state and outputs; it does not treat missing streamed events as lost durable work. |
| Computer unavailable or permission revoked | Input/tools stop at the enforced boundary; UI offers a truthful recovery step. |
| Invalid full-backup file or failed upload | Applicable DB protection continues within the supported recovery objective; failures remain visible. |
| Insufficient disk/resource pressure | Failure is bounded, recoverable work is preserved and the operator/user sees the cause. |
| Restore saved work | Verify data and owner in a separate non-serving target; reconcile pending actions and sensitive grants, then perform the staged fenced activation and new-task check. |

Add the native linking, file traversal/symlink, private-key rotation and two-account authorization regressions for the features included in the chosen path. A passing happy path cannot waive a reproduced security or data-integrity defect.

## 7. Execution order, ownership and inputs

| Order | Deliverable | Responsible role | Dependency |
| --- | --- | --- | --- |
| 1 | Exact candidate and first-user scope contract | Release coordinator + product owner | Current source/deployment inventory and named test user |
| 2 | Approval regression/fix/review | Workstream A | No external prerequisite for local work |
| Parallel | Auth/files/model/voice fixes and iOS test coverage | C/E | Scope decision; local fixtures can proceed |
| Parallel | Backup correction, recovery preparation and resource instrumentation | D | Deployment-specific data contract |
| Conditional foundation | Working qualified isolated tenant | F | Approved infrastructure, credentials and image policy |
| 3 | Real task, delegation, provider and computer integration | B/C/E | A; working selected deployment and authorized accounts |
| 4 | Restore and failure-case matrix | B/D/E/F as applicable | Stable integrated candidate |
| 5 | Repeated journeys and supervised working day | Qualification owner | All included blocker gates resolved |
| 6 | Independent evidence review and controlled-user decision | Release owner + independent reviewer | Exact-source receipts and rollback/recovery owner |

Assign names and a tracking issue/PR to every row. Preserve shared work by using scoped branches/worktrees. Finish independent fixes while infrastructure or owner inputs are pending.

Inputs required:

- First-user account alias and the chosen deployment, client, computer and CLI execution paths.
- Included providers/models/apps/voice features, controlled test resources and expected output.
- Authorized real subscriptions/provider identities and configuration through protected secret storage.
- Test-data sizes, acceptable wait times, recovery objectives and any permitted interruption.
- An operator/alert destination and permission to perform the scoped failure tests in a non-production or otherwise approved test environment.
- For isolated hosting: reviewed staging/image/KMS/storage/PG/provider inputs and spending limits.
- For native testing/distribution: device access, appropriate signing/provisioning, release version/backend and public delivery inputs where applicable.

This document is not permission to make arbitrary provider writes, spend money or deploy. Reuse authorization already given for a specific action; resolve genuinely missing inputs before dependent live operations. Never ask for secret contents in chat.

## 8. What can wait without weakening this milestone

The following do not need to block a controlled new-user standalone trial when its own required gates pass:

- A 2,000-account load test, large onboarding bursts and fleet cleanup-throughput qualification.
- Multi-region operation and automatic fleet sizing.
- Safe multi-replica serving, if the first trial explicitly accepts a measured single-instance availability/maintenance policy.
- Legacy-account migration, if the test uses a new account with an agreed existing-user policy.
- Automatic isolated idle savings, if the selected trial has an explicitly funded and managed running-resource policy.
- Push notifications, offline chat, background voice and a custom updater, if excluded from the promise.
- Public app-store/download publication for an approved internal test; public distribution still requires the actual channel gates.

These remain tracked in the broader release plan. None permits skipping approval safety, correct account identity, recoverability or the containment promise of a selected isolated deployment.

## 9. Evidence and first-user sign-off

For each blocker, record: owner, state, affected path, fix PR/commit, regression result, exact live/device test, sanitized outcome links, limitation, next action and reviewer. Use **OPEN**, **FIXED / NEEDS LIVE TEST**, **VERIFIED FOR NAMED PATH**, or **EXCLUDED BY RECORDED SCOPE DECISION**. Excluded is not passed.

The shared sign-off must include:

- [ ] Current candidate source, deployed images/configuration and client/runner/companion compatibility.
- [ ] Closed in-scope approval, identity and data-integrity defects.
- [ ] All required acceptance steps and failure cases with independently verifiable results.
- [ ] Successful real model/provider, delegation, computer and output journey on the included paths.
- [ ] Tested restore and safe return to service, including original-writer fencing, replacement readiness, correct routing, saved-output access and a successful new controlled task.
- [ ] Recorded correctness, latency, supported workload/data size, recovery window/time and interruption results meet the pre-agreed contract; any accepted deviation names its scope and decision owner.
- [ ] Visible task states, working basic alerts and named operational support.
- [ ] Native/isolated/public-distribution gates where included.
- [ ] Explicit accepted limitations, rollout stop conditions and a compatible secure rollback or disablement plan.
- [ ] Release owner and independent reviewer decision: GO for the named controlled workflow, or NO-GO with exact remaining blockers.

Stop the trial for unauthorized dispatch, foreign account/resource access, unaccounted accepted work, uncontrolled duplicate writes, corrupted output, an unusable required recovery path or a broken included identity flow. Preserve evidence and recover safely; do not restore a known permissive authorization bug as rollback.

The initial shared tracking state is **NO-GO for a reliability claim**: code and tests exist, but the confirmed applicable defects and complete first-user qualification have not been closed. Completion of this master plan is a planning deliverable. A first-user pass must name exactly what was tested; it does not certify the whole product or the 2,000-user release.
