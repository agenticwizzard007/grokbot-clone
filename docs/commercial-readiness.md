# Swarm: features & commercial readiness

**Product review with feature completeness scores · 11 November 2026 · Source `7e67b384b6ec`**

> **Substantial product functionality exists. An unrestricted, paid self-service launch is not yet supported by the implementation and evidence reviewed.** The immediate work is to make a complete customer workflow dependable, close authorization and recovery defects, qualify hosted infrastructure, and finish the commercial operating model.

This assessment covers the current repository and the existing release plans. “Implemented” means code exists; it does not mean that the feature has passed a live production trial. Current production configuration, provider contracts, signed-device behavior, and deployed capacity were not independently verified in this review.

## 1. What the app already offers

Swarm is an AI teammate product: users assign work to persistent Bots that can use apps and computers, remember context, collaborate, and report back through chat, voice, or messaging.

### Completeness scorecard

**The 12 existing feature areas average approximately 60% complete for the full advertised commercial experience.** Individual scores range from 50% to 70%. These are evidence-informed assessment estimates, not measured task-success rates, percentages of code written, or estimates of engineering time remaining. A 70% feature can still contain a launch-blocking dependency.

The assessment covers the web, native clients, and isolated hosted paths described below. A deliberately narrower pilot could score differently. **100% means the agreed feature scope works, handles its important failure cases, and has passed its acceptance checks on the shipping configuration.** It does not mean perfect AI output, every possible integration, or optional roadmap features.

| Feature | Completeness | Core / 40 | Integration / 20 | Safeguards / 20 | Live operation / 20 |
| --- | ---: | ---: | ---: | ---: | ---: |
| [F01 · Persistent AI teammates](#f01-persistent-ai-teammates-70) | **70%** | 40 | 15 | 10 | 5 |
| [F02 · Team coordination](#f02-team-coordination-60) | **60%** | 30 | 15 | 10 | 5 |
| [F03 · Choice of AI connection](#f03-choice-of-ai-connection-65) | **65%** | 40 | 10 | 10 | 5 |
| [F04 · Computer and browser work](#f04-computer-and-browser-work-60) | **60%** | 40 | 10 | 5 | 5 |
| [F05 · Connected apps and custom tools](#f05-connected-apps-and-custom-tools-65) | **65%** | 40 | 15 | 5 | 5 |
| [F06 · Action approvals and permissions](#f06-action-approvals-and-permissions-50) | **50%** | 30 | 10 | 5 | 5 |
| [F07 · Recurring and event-driven work](#f07-recurring-and-event-driven-work-65) | **65%** | 40 | 10 | 10 | 5 |
| [F08 · Voice](#f08-voice-50) | **50%** | 30 | 5 | 10 | 5 |
| [F09 · Messaging](#f09-messaging-65) | **65%** | 40 | 10 | 10 | 5 |
| [F10 · Task board and file Library](#f10-task-board-and-file-library-50) | **50%** | 30 | 5 | 10 | 5 |
| [F11 · Web, Mac, and iPhone/iPad access](#f11-web-mac-and-iphone-ipad-access-60) | **60%** | 40 | 5 | 10 | 5 |
| [F12 · Usage visibility and administration](#f12-usage-visibility-and-administration-65) | **65%** | 40 | 10 | 10 | 5 |

**The arithmetic is 725 / 1,200 = 60.4%, rounded to approximately 60%.** The equal-weight average summarizes these existing feature areas only. It does not certify the whole business as 60% ready to launch. Missing monetization, production qualification, recovery, support, and distribution remain independent release gates; they cannot be averaged away.

### Scoring method

Each score adds four components:

- **Core capability and usability / 40:** the main function, controls, and customer-visible result.
- **Integration and deployment coverage / 20:** consistent behavior across the promised account, provider, computer, and client paths.
- **Safeguards and recovery / 20:** authorization, ownership, cancellation, durable state, and recovery from relevant failures.
- **Live validation and operability / 20:** complete real-provider/device workflows, measured performance/cost, and usable support/operations evidence.

Components use a five-level judgment: absent (0%), foundations/material gaps (25%), partial (50%), substantial/bounded gaps (75%), or scoped completion (100%) of that component's weight. Scores therefore move in five-point increments. Current live-validation scores are deliberately low because the complete shipping journeys have not been independently established by the evidence reviewed. Missing evidence is not a claim that the implementation is absent or defective.


### How to read the missing-work lists

- **[Fix]** — a confirmed defect in the reviewed code.
- **[Build]** — an identified missing/incomplete implementation or delivery capability.
- **[Validate]** — a specific test, measurement, or operational proof still needed; code may already cover it.
- **[Decide]** — a product, operating, or acceptance-policy choice needed to finish the feature consistently.
- **[Optional]** — an extension that is not required to complete the stated scope and is not deducted from the score.

Repeated dependencies are intentional: for example, one approval fix improves several features. The lists are not independent estimates of engineering effort. Each feature ends with a concrete acceptance outcome; numerical latency, workload, cost, and recovery targets must be recorded for that outcome before qualification.

### Deployment and shared commercial gaps

The repository contains a **standalone application** and an **isolated hosted architecture** with separate account runtimes, data, credential delivery, provisioning, controlled containers, backup/recovery, and migration machinery. Native clients connect to those server modes. Working standalone behavior does not establish isolated-hosting parity. [E12](#evidence)

Beyond the 12 feature scores, a satisfactory commercial product still needs:

- **[Build] Customer monetization:** Swarm checkout, paid-plan entitlements, payment-event handling, billing management, and cancellation/refund paths, or an explicitly defined manual pilot process. Provider subscription login is already built; it is a different function.
- **[Fix] Recoverable customer data:** independent database-backup scheduling, a sustainable cleanup policy, and storage limits compatible with the backup/restore format.
- **[Validate] Production hosting:** exact image provenance, real tenant containment, actual infrastructure configuration, provider permissions/quotas, and deployment rollback.
- **[Validate] Service operations:** alerts that reach an operator, tested tenant and platform recovery, deletion/retention execution, customer support, and incident response.
- **[Decide] Sustainable pricing and capacity:** included model/computer/voice/messaging costs, workload limits, support coverage, availability, and a measured gross-margin model.
- **[Build] Public native delivery where offered:** final signed Mac downloads and the iOS archive/submission/review path, backed by physical-device evidence.
- **[Validate] Existing-account migration if needed:** a complete writer freeze, exact transfer, safe rollback/resume, and retirement before moving existing customers.

Additional context: the updated first-user master plan records a coordinator report of standalone v28 with Google sign-in restoration/cleanup. That is useful reported progress, not a complete production journey independently rerun for this report. The local source remains `7e67b384b6ec`. The native linking findings below are distinct from ordinary Google sign-in restoration. [E17](#evidence)

### F01. Persistent AI teammates — 70%

**Assessment:** a substantial agent-creation and memory product exists. Consistent onboarding, long-lived memory quality, and reliable lifecycle behavior still need complete qualification. Evidence: [E01](#evidence), [E18](#evidence).

#### What is built

- Named Bots with appearance, role, standing instructions, model/effort settings, and a primary-contact designation.
- Creation of permanent teammates from conversation, with setup stages, a structured brief, and activation/review controls.
- Saved agent setup resources and handoff information, including agent manifests/instructions.
- Persistent conversations, model history, durable memories, and `remember`/`recall` tools.
- Long-conversation compaction and idle-time memory consolidation.
- Memory viewing, search, and forgetting controls; saved skills with create/edit/delete paths.
- Agent configuration and deletion controls in the app.

#### What is missing to finish it

- **[Validate] First useful result:** prove new account → primary Bot → specialist creation → activation → completed real task on every included execution path.
- **[Validate] Setup interruption:** reload, disconnect, cancel, and restart during setup without duplicated Bots, lost instructions, or incorrect activation state.
- **[Validate] Setup boundaries:** prove an incomplete or unapproved setup cannot perform operational actions outside its permitted setup tools.
- **[Validate] Configuration persistence:** confirm names, instructions, skills, model selections, and resource references survive reconnects and application updates.
- **[Validate] Long-term recall:** use known facts and corrections over long conversations to measure useful recall, contradictions, and facts lost during compaction.
- **[Decide] Memory semantics:** define what “Forget” removes, what remains in chat/backups, and whether retained source conversations can legitimately teach the same fact again.
- **[Validate] Memory controls:** test deletion, consolidation failure, concurrent updates, malformed model summaries, and cross-account access boundaries.
- **[Validate] Skill/resource changes:** show that edited or revoked resources are reflected in subsequent work without silently reusing stale access.
- **[Fix] Recovery dependency:** close the isolated backup-scheduling defect before claiming saved instructions, memories, and conversations are recoverable.
- **[Validate] Lifecycle cleanup:** deactivate/delete an agent while it has queued work, routines, children, or pending approval, and verify predictable cleanup.
- **[Validate] Customer feedback:** demonstrate clear setup progress, blocking errors, retry actions, and accessible controls on supported screens.
- **[Decide] Quality targets:** define representative teammate jobs and acceptable completion/recall rates; measure them on the actual chosen models.

**Finished when:** a user can create, configure, use, correct, stop, and return to a teammate across devices/restarts, with the intended memory and recoverable data, meeting the recorded task-quality targets.

### F02. Team coordination — 60%

**Assessment:** collaboration primitives and durable job machinery exist. A dependable coordinator-to-specialist workflow and its failure outcomes are not yet established end to end. Evidence: [E01](#evidence), [E18](#evidence).

#### What is built

- Bot-to-Bot delegation and messages through `send_to_bot`.
- Temporary subagents with separate context, parent relationships, status inspection, messaging, and stop controls.
- Group conversations with membership and @mention routing.
- Persistent job records and tool-dispatch journaling.
- Recovery that marks interrupted running work as uncertain instead of blindly repeating external actions.
- Per-Bot ordering and native CLI callbacks tied to the active execution context.
- Task/activity presentation and returned specialist messages.

#### What is missing to finish it

- **[Validate] Genuine delegation:** show the specialist performs the work and the coordinator uses its actual result in the final answer.
- **[Validate] Context ownership:** verify the right user, agent, selected computer, credentials, input files, and model follow every handoff.
- **[Validate] Durable acceptance:** crash before/after job acknowledgement and during handoff; every accepted job must retain a truthful recoverable state.
- **[Validate] Parent/child cancellation:** stop a coordinator, a queued child, and an executing child; establish which work stops and which in-flight effect must be reconciled.
- **[Validate] Uncertain writes:** simulate a provider success followed by a lost response; surface uncertainty without automatically issuing a duplicate write.
- **[Validate] Approval ownership:** return the right child's approval/question to the user and resume the exact intended work after an answer.
- **[Validate] Late/duplicate replies:** prevent stale child responses or repeated callbacks from being treated as a fresh successful result.
- **[Validate] Bounded collaboration:** exercise circular delegation, repeated handoffs, and unresponsive specialists against the intended runtime limits.
- **[Validate] Shared-resource contention:** measure multiple Bots/helpers competing for the desktop, browser, CLI, and host memory at the supported concurrency.
- **[Validate] Child cleanup:** inspect abandoned subagents, leases, screens, processes, and queued messages after timeout, cancellation, or parent deletion.
- **[Decide] User-facing states:** define how partial completion, failed subtasks, canceled work, and uncertain effects appear; close any mismatch between the job system and task UI.
- **[Validate] Success evidence:** require the expected artifact/provider outcome, not only a confident coordinator message, before marking the workflow done.

**Finished when:** a real coordinator → specialist → coordinator job produces a verified result and survives the agreed interruption/cancellation matrix with correct ownership and no blind replay.

### F03. Choice of AI connection — 65%

**Assessment:** broad provider and subscription support is implemented, but model discovery parity, the latest live CLI workflow, and complete customer-visible provider behavior remain unfinished. Evidence: [E02](#evidence), [E15](#evidence).

#### What is built

- OpenRouter and compatible direct API access, including personal provider credentials and provider-selection controls.
- Official Codex and Claude CLI subscription execution with private hosted profiles.
- Hosted browser-terminal login and an optional personal-computer bridge.
- Model catalogs, favorites, thinking-effort controls, and capability information.
- Native Swarm tools exposed to supported CLI generations through MCP.
- Explicit subscription failure behavior without a silent switch to API billing.
- Provider plan/quota observations and complete/partial/unavailable token-usage handling.

#### What is missing to finish it

- **[Fix] Private direct-key discovery:** make tenant model listing use the same owner-bound credential/base-URL contract as inference; currently these paths disagree.
- **[Decide] Shared API funding:** specify whether hosted customers bring keys or receive administrator-funded text usage; a shared funded service needs a trusted scoped delivery design.
- **[Validate] Real subscription tools:** complete inference, app discovery, approved actions, and final output with real supported Codex and Claude accounts on the latest transport.
- **[Validate] Model matrix:** test the actually offered models/efforts, tool support, image input, and catalog changes; a model appearing in a list is insufficient.
- **[Validate] Login continuity:** prove hosted credentials work from a second device and survive the expected server/profile lifecycle.
- **[Validate] Credential lifecycle:** exercise wrong keys, rotation, expired sessions, revocation, reconnect, and simultaneous login/execution without cross-account reuse.
- **[Validate] Quota/policy failure:** show clear, accurate errors for exhausted plans, throttling, unavailable models, and provider refusal.
- **[Validate] Billing invariants:** prove retry, reconnect, and catalog failure cannot switch the customer's selected billing source without an explicit choice.
- **[Validate] Transport compatibility:** pin and qualify matching application, runner, CLI, and bridge versions; test the existing update-required behavior for older bridges.
- **[Decide] Response feedback:** set a responsiveness target for buffered subscription answers; add incremental text only if it is part of the promised experience, and always show truthful activity.
- **[Validate] Usage truthfulness:** preserve partial/unavailable counters during approval stops, cancellation, errors, and long runs; reconcile observed costs where possible.
- **[Decide] Provider commercial scope:** confirm permitted hosted usage, applicable terms, account quotas, and what the customer must purchase separately.

**Finished when:** a customer can connect an offered provider, choose a valid model, complete real tool work, understand cost/limits, and recover from authentication or quota failure without hidden routing changes.

### F04. Computer and browser work — 60%

**Assessment:** several computer modes and human takeover already exist. Hosted containment, files, resource sizing, and dependable recovery are the principal gaps. Evidence: [E03](#evidence), [E12](#evidence), [E14](#evidence), [E18](#evidence).

#### What is built

- A provider interface for local browser, personal desktop, and cloud-computer execution.
- Separate local Chrome profiles and cloud desktop/browser environments, according to provider mode.
- Screenshots, browser interaction, mouse/keyboard actions, and shell tools where supported.
- Live computer viewing and separate watch/control behavior.
- Companion pairing, native Mac consent controls, and desktop ownership/turn-taking.
- Browser recovery budgets and human handoffs for login, MFA, or CAPTCHA.
- Legacy Orgo idle/wake behavior and isolated-host lifecycle/replacement foundations.
- Application/desktop/runner isolation policies and readiness checks in the hosted architecture.

#### What is missing to finish it

- **[Build] Hosted file exchange:** provide the missing owner-bound route between Library inputs, the desktop workspace, and downloadable outputs.
- **[Fix] Path promises:** align tool descriptions and user-visible locations with the actual mounted paths.
- **[Decide] Resource envelope:** select compatible host/container limits from measured overlapping browser, app, helper, and backup usage; current ceilings can exceed host RAM.
- **[Validate] Containment:** run the exact images on real hosts and test filesystem, process, network, metadata, and cross-tenant boundaries.
- **[Build] Isolated idle/wake automation:** wire and qualify it before claiming automatic savings; an explicitly funded manual policy can support a narrower pilot.
- **[Validate] Cold start and reconnect:** exercise provision, wake, viewer readiness, companion loss, and recovery with actionable status instead of indefinite waiting.
- **[Validate] Watch/control safety:** confirm watch mode cannot inject input and that control is revoked correctly on session/account changes.
- **[Validate] Native consent:** test stop, disconnect, revoked OS permissions, and server switching on a signed Mac installation.
- **[Validate] Real browser recovery:** measure login/MFA handoff and recovery on the supported sites, including unfamiliar/localized pages and blocked dialogs.
- **[Decide] Interrupted handoff policy:** current access polling is turn-scoped, not a durable background login monitor; make restart/timeout/resume behavior clear.
- **[Validate] Multiple Bots:** verify isolated profiles/screens and personal-desktop turn-taking under the advertised concurrency.
- **[Validate] Maintenance interruption:** measure backup/resize/update pauses and confirm work is safely quiesced or reported as interrupted.
- **[Validate] Performance/cost:** record cold/warm action latency, viewer bandwidth, memory pressure, and cost for representative tasks.
- **[Decide] Supported environments:** publish a tested OS/browser/provider matrix and explicit mode limits, including local-browser mode's lack of shell/desktop apps.

**Finished when:** an authorized user can reliably start, watch, control, interrupt, and resume computer work on a declared configuration, use files in both directions, and trust the measured resource and security boundaries.

### F05. Connected apps and custom tools — 65%

**Assessment:** account connections and MCP tooling are extensive; dependable authorization and real multi-account integration behavior still need completion. Evidence: [E04](#evidence), [E05](#evidence), [E15](#evidence).

#### What is built

- Searchable Composio app catalog and personal connection flows.
- Account-scoped tool discovery/execution and connection management.
- Isolated gateway handling and connection/revision ownership controls.
- Custom MCP over HTTP or SSE (token, headers or OAuth). Command-based (stdio) servers need an isolated tenant runner and are rejected on the shared standalone server (`SWARM_ROLE=standalone`).
- Remote MCP OAuth, token/header credentials, and encrypted stored configuration.
- Tool discovery/testing, agent assignment, enable/disable, and removal controls.
- Permission handling, revision invalidation, and controlled local-folder configuration.
- Connected-app event-trigger foundations.

#### What is missing to finish it

- **[Fix] Authorization dependency:** close the read-like tool-name defect before relying on default permissions for connected-app writes.
- **[Validate] Multi-account selection:** prove two users and two connections for one user always execute against the intended account, including saved defaults.
- **[Validate] OAuth lifecycle:** exercise initial consent, canceled login, expired tokens, refresh, disconnect, and provider-side revocation on the launch integrations.
- **[Validate] MCP OAuth:** test real supported authorization servers and session/revision changes, including canceled and replayed callbacks.
- **[Validate] Live execution results:** witness real reads and controlled writes at the provider; do not accept only a model statement that an action succeeded.
- **[Validate] Permission invalidation:** change credentials, endpoint, agent assignments, or enabled state while an approval/tool call is pending.
- **[Validate] Local MCP boundaries:** test permitted folders, symlinks, process environment, network restrictions, and teardown after revocation on the actual host.
- **[Validate] Failure handling:** exercise malformed results, tool version drift, rate limits, timeouts, large responses, and upstream error envelopes.
- **[Validate] Trigger lifecycle:** reconnect and revoke accounts while app-event routines exist; surface stale triggers and the required repair action.
- **[Decide] Supported launch catalog:** identify the integrations and actions actually qualified; catalog visibility does not establish that every app works commercially.
- **[Decide] Provider operations:** agree quotas, OAuth branding/configuration, service costs, and support responsibility for provider outages.
- **[Build] Accurate documentation:** update stale README statements about MCP OAuth and credential storage to match the current implementation.

**[Optional]** MCP resources and prompt templates can be added if the product expands beyond MCP tools; their absence is not counted against the current tools-focused scope.

**Finished when:** the supported connection set passes login → correct account/tool → real result → revocation/reconnect with accurate permissions, errors, and ownership throughout.

### F06. Action approvals and permissions — 50%

**Assessment:** approval mechanics exist, but a confirmed default-authorization defect prevents the feature from being considered dependable. The score is not a statement that half of actions are safe. Evidence: [E05](#evidence), [E18](#evidence).

#### What is built

- Approval cards with allow-once, always-allow, and deny actions.
- Saved tool policies and a UI for revoking permanent permissions.
- Durable pending-turn records and continuation after a decision.
- MCP-specific approval defaults and configuration/revision invalidation.
- Native CLI stop-at-approval and exact stored-action resume machinery.
- Messaging approval tokens and voice handoff to the normal execution/approval path.
- Separate native computer-consent and watch/control protections.

#### What is missing to finish it

- **[Fix] Default read classification:** replace permissive tool-name inference; `GITHUB_CREATE_A_CHECK_RUN` currently demonstrates the failure.
- **[Fix] Unknown action behavior:** require approval when authoritative action metadata is missing, stale, or conflicting, while honoring valid explicit policies.
- **[Validate] Execution-path coverage:** prove the corrected policy applies to API chat, native CLI callbacks, setup, voice, messaging, and resume paths.
- **[Validate] Exact binding:** approvals must apply to the correct owner, connection/account, tool, arguments, and authorization revision.
- **[Validate] Revocation precedence:** revoke access during an approval wait or between decision and execution; the revoked action must not dispatch.
- **[Validate] Cancellation/expiry:** expire a pending card, switch sessions, cancel the job, and answer an old messaging token without reviving stale work.
- **[Validate] Explicit denial:** show the agent respects a refusal and cannot obtain the same denied effect through an unintended retry path.
- **[Validate] Duplicate dispatch:** repeat callbacks/answers and lose the provider success response; preserve one authorized action and report uncertainty accurately.
- **[Validate] Saved-policy UI:** ensure users can see what an enduring permission covers, identify the affected integration, and reliably revoke it.
- **[Decide] Permission lifetime:** document the intended scope and lifetime of remembered permissions, including what connection/configuration changes invalidate them.
- **[Decide] Consent boundary:** explain that browser/shell/desktop access has separate permissions and can perform writes; do not imply every such action has a Composio approval card.
- **[Validate] Auditability:** demonstrate an operator can trace a disputed action to its exact request, permission decision, and outcome without exposing credentials.

**Finished when:** controlled adversarial tests and provider-side witnesses show that an action needing approval cannot run beforehand, and approval, denial, cancellation, and revocation remain correct across every offered channel.

### F07. Recurring and event-driven work — 65%

**Assessment:** scheduling and guardrails are implemented. “Always on” still needs a defined and tested contract for downtime, sleeping hosts, provider failures, and missed runs. Evidence: [E06](#evidence), [E14](#evidence), [E18](#evidence).

#### What is built

- Cron schedules with timezones and startup registration of enabled routines.
- App-event routines and trigger creation/management.
- Manual run-now behavior and execution through the normal Bot loop.
- Limits on schedule frequency, active routine counts, and daily runs.
- Event-burst spacing, overlap guards, and inactivity-based pausing.
- Skipped-run notices and routine-run activity in conversations.
- Proactive primary-Bot check-ins and result delivery through existing channels.

#### What is missing to finish it

- **[Decide] Missed-run contract:** define whether downtime causes a skipped run, a single catch-up, or replay of every occurrence; avoid surprising bursts and costs.
- **[Build] Hosted wake integration:** connect promised scheduled/event work to qualified isolated sleep/wake behavior; in-process cron alone cannot run on a stopped host.
- **[Validate] Offline event durability:** prove incoming events remain safely accounted for while a tenant is stopped, disconnected, restoring, or updating.
- **[Validate] Restart boundaries:** interrupt before acceptance, while queued, during a tool effect, and after completion; retain accurate run state without blind repeats.
- **[Validate] Time semantics:** cover daylight-saving changes, timezone updates, invalid schedules, and clock-related boundary cases.
- **[Validate] Duplicate/burst delivery:** test provider redelivery, event storms, and overlapping manual/scheduled triggers with the intended deduplication policy.
- **[Validate] Limits under concurrency:** demonstrate routine caps and daily allowances cannot be bypassed by simultaneous events or restart.
- **[Validate] Credential loss:** expire or revoke an app/model account and show a clear paused/failed state with an actionable reconnect path.
- **[Validate] Approval waits:** keep required decisions visible while preventing approval delays from creating uncontrolled overlapping work.
- **[Validate] Result notification:** confirm completion, skip, error, and needed-input outcomes reach the configured web/messaging destination appropriately.
- **[Decide] Spend and inactivity controls:** make daily cost/run limits, pause/resume, and the effect of customer cancellation explicit.
- **[Validate] Sustained unattended operation:** run a bounded soak with real events, provider throttling, wake cycles, and measured backlog/cost.

**Finished when:** scheduled and event-triggered jobs follow an explicit downtime policy, execute within their limits, survive interruptions, and reliably expose a useful outcome without requiring a browser tab to remain open.

### F08. Voice — 50%

**Assessment:** realtime voice, dictation, and delegation exist. Hosted voice funding/parity and a satisfactory real-device experience remain substantial gaps. Evidence: [E07](#evidence), [E10](#evidence), [E18](#evidence).

#### What is built

- Realtime voice calls using short-lived provider session credentials.
- Dictation, speech generation/previews, voice selection, and speed controls.
- Voice delegation into the same text-agent/tool runtime.
- Agent/platform-state inspection and task handoff tools in calls.
- Client interruption handling and live call/task feedback.
- Voice usage recording and separation of voice versus text-model routing.
- Native voice shortcut integration and microphone-permission entry points.

#### What is missing to finish it

- **[Build] Isolated voice parity:** provide a trusted, account-scoped platform voice service, or explicitly implement/qualify per-user voice keys as the supported offer.
- **[Decide] Funding and entitlement:** specify who pays, what is included, session/usage limits, and what happens when voice credit is exhausted.
- **[Validate] Credential boundary:** verify short-lived tokens, authorization, expiry, session switching, and revocation without placing a shared master key in tenant workloads.
- **[Validate] Real microphones/devices:** test the supported browser, signed Mac, and physical iPhone/iPad configurations with permission allow/deny/revoke.
- **[Validate] Speech quality:** measure intelligibility, transcription errors, latency, background noise, and the advertised language/accent set.
- **[Validate] Conversation interruption:** speak over a reply, interrupt queued speech, and rapidly alternate dictation/call states without stale or duplicate audio.
- **[Validate] Delegated work:** show the voice agent reports the actual Bot result and never equates task submission with completion.
- **[Validate] Approvals/questions:** ensure a spoken request cannot bypass tool policy and that users can find and answer the correct pending decision.
- **[Validate] Disconnect behavior:** interrupt the audio network or background the app; explain whether delegated work continues and how to recover its result.
- **[Validate] Long-call stability:** measure sustained calls, provider timeouts, concurrent sessions, device audio changes, and resource cleanup on hangup.
- **[Validate] Metering:** account for partial/failed calls and reconcile available usage without presenting unknown cost as free usage.
- **[Decide] Retention and support:** publish what audio/transcripts are retained, how microphone/provider failures are explained, and how users get help.

**[Optional]** Offline speech and background voice are separate scope extensions. Background voice is currently unimplemented; it need not block a clearly foreground-only offer.

**Finished when:** a new eligible customer can start a clear, responsive call, delegate a real task, handle approvals, hear the actual outcome, and recover from interruption under an explicit billing/retention policy.

### F09. Messaging — 65%

**Assessment:** the channel bridge, signup, approvals, media, and durable inbound handling are built. Real delivery and channel-specific operating requirements still need full qualification. Evidence: [E08](#evidence), [E18](#evidence).

#### What is built

- Inkbox adapters for configured iMessage, SMS, and WhatsApp paths.
- Invite-based text signup, onboarding, account linking, and daily text allowances.
- Bot selection/@mentions and commands for team/work/account status.
- Outbound results, routine updates, questions, approval tokens, and connection links.
- Supported image/audio handling and voice-reply preferences.
- Signed webhooks with a durable, deduplicated inbox and bounded retries.
- Outbound queue/logging, channel preferences, and conversation routing.

#### What is missing to finish it

- **[Validate] Actual channels:** test inbound/outbound delivery, account linkage, and media using configured production-like lines for each advertised channel.
- **[Decide] Channel operating rules:** confirm applicable number provisioning, sender approval, consent/opt-out, template, or messaging-window requirements with the provider.
- **[Validate] Inbound crash recovery:** replay duplicate, delayed, reordered, and malformed events through restart without repeating accepted work.
- **[Validate] Outbound uncertainty:** distinguish a queued message, provider acceptance, and observed delivery where available; test a timeout after a send may already have succeeded.
- **[Validate] Failed-event handling:** prove an operator can identify, inspect safely, and resolve exhausted retries without bypassing deduplication.
- **[Validate] Signup abuse controls:** exercise invalid/reused invites, code expiry, bursts, and attempts to bind another person's channel/account.
- **[Validate] Approval targeting:** test quoted replies, concurrent approvals, old tokens, wrong Bots, and a revoked session/connection.
- **[Validate] Media bounds:** test supported codecs/formats, maximum size, expired download links, corrupted attachments, and safe credential handling.
- **[Validate] Link handoff:** open sign-in/app-connection links from phones and native clients and return to the intended existing account.
- **[Validate] Sleeping/disconnected tenants:** preserve inbound events and outbound results through wake, restore, provider outage, and reconnect.
- **[Validate] Channel changes:** unlink/relink or change a number without delivering another user's work or silently losing notification preferences.
- **[Decide] Notification expectations:** define quiet/opt-out behavior, duplicate cross-channel messages, and what the user receives when web activity is present.
- **[Validate] Commercial metering:** measure per-channel costs, long-message splitting, media costs, throughput, and provider quota headroom.
- **[Validate] Retention/deletion:** verify stored media, inbox history, delivery logs, and external records follow the advertised retention and deletion policy.

**Finished when:** the supported channels reliably carry an authenticated task from message to real result—including approvals and media—with clear failure handling, lawful/provider-compatible messaging rules, and predictable cost.

### F10. Task board and file Library — 50%

**Assessment:** the task UI and file surfaces are implemented, but the isolated input → computer → downloadable output path has a concrete integration gap. Evidence: [E03](#evidence), [E09](#evidence), [E13](#evidence), [E18](#evidence).

#### What is built

- Task views for needs-input, in-progress, and completed work.
- Bot/state filtering, pending-work ordering, and links to the owning conversation.
- Responsive layouts and stale-data/error/retry handling.
- Saved files, Library listing/navigation, and download controls.
- Upload/file-related application routes and agent `save_file` tooling.
- Owner/path checks and bounded file access mechanisms.
- File inclusion in the isolated backup/recovery architecture.

#### What is missing to finish it

- **[Build] Library-to-desktop input:** safely make a permitted uploaded/Library file available to isolated computer tools.
- **[Build] Desktop-to-Library output:** collect the actual generated result into an owner-bound downloadable location.
- **[Fix] File-location contract:** remove conflicting `/files`, desktop-home, and legacy tool-description assumptions.
- **[Validate] Full round trip:** upload a known input, transform it on the selected computer, and independently verify the downloaded output's content.
- **[Validate] Ownership and revocation:** test foreign file IDs, expired grants, changed sessions, and revoked folder access while work is active.
- **[Validate] Path safety:** test traversal, symlinks, renamed files/directories, and attempts to expose application databases or credentials.
- **[Validate] Interrupted transfer:** handle partial uploads/copies, repeated requests, missing files, full disk, and retry without corrupting a completed artifact.
- **[Decide] File envelope:** declare supported types, sizes, counts, naming, and retention; align those limits with backup and restore space.
- **[Fix] Recoverability dependency:** fix backup starvation and prove the saved artifacts remain recoverable at the supported storage ceiling.
- **[Decide] Task-state contract:** define how failed, canceled, partially completed, and uncertain jobs map to the three-column board; implement any missing status/recovery affordances.
- **[Validate] Honest completion:** mark tasks complete only when required output/effects exist; a model's final message is not sufficient evidence.
- **[Validate] Cross-device downloads:** test authenticated uploads/downloads in supported browsers and native clients, including reconnect and error recovery.
- **[Validate] UI consistency:** ensure live updates, refresh, deleted Bots, long filenames/content, keyboard navigation, and screen readers preserve useful task/file state.

**Finished when:** a user can give a real file-based task, track its true state, supply needed input, and download the correct result after interruption or recovery without crossing account boundaries.

### F11. Web, Mac, and iPhone/iPad access — 60%

**Assessment:** substantial shared UI and native integration exist. Account linking and final signed-device/public-release paths keep the full cross-device offer incomplete. Evidence: [E10](#evidence), [E16](#evidence), [E17](#evidence).

#### What is built

- Responsive web chat, settings, tasks, connection, computer-viewer, and voice interfaces.
- Native Mac and iPhone/iPad clients wrapping the shared product experience.
- Google, Apple, phone, and OpenRouter authentication/linking machinery, with server-role differences.
- Native callback and session-handling policies.
- Mac pairing/consent, Keychain token storage, bundled companion, and stop/disconnect controls.
- Voice shortcuts and native microphone integration.
- Native policy tests, simulator/build automation, and Mac packaging/signing/notarization tooling.
- Account-deletion controls and an Apple privacy manifest.

#### What is missing to finish it

- **[Fix] Native Google linking:** preserve the authenticated linking intent/session rather than starting an ordinary sign-in journey.
- **[Fix] Isolated link completion:** carry and revalidate the initiating session through Apple/OpenRouter native completion; reconcile OpenRouter partial success on retry/cancel.
- **[Fix] Account status/disclosure:** return accurate Google-linked state and provider/mode-appropriate consent wording.
- **[Validate] Full auth matrix:** test success, cancellation, collisions, expiry, replay, sign-out, account switch, and server switch on the supported client/server combinations.
- **[Validate] Signed devices:** exercise the final build on physical iPhone/iPad and supported Mac architectures; browser emulation is insufficient.
- **[Validate] Native computer lifecycle:** grant/revoke permissions, quit/restart, stop/disconnect, and switch sessions while control is active.
- **[Validate] Files and voice:** prove authenticated downloads/uploads, microphone handling, deep links, and return-to-app behavior on devices.
- **[Build] iOS test execution:** add/run the iOS test target in the release checks; the current Apple test command runs the Mac scheme.
- **[Build] iOS delivery completion:** produce a repeatable signed archive/export/upload and complete TestFlight/App Store release requirements.
- **[Validate] Mac delivery:** run the real Developer ID/notary/Gatekeeper pipeline, then install the exact published archive on supported Macs.
- **[Decide] Distribution/support contract:** set supported OS versions, architectures, update/reinstall instructions, rollback availability, and support contact.
- **[Validate] Public materials:** reconcile store privacy answers, policy/support URLs, screenshots, reviewer access, and account deletion with the deployed product.
- **[Validate] Accessibility and resilience:** test keyboard/screen-reader access, small/large screens, background/resume, slow/offline networks, and actionable reconnect states.
- **[Validate] Version compatibility:** ensure app, companion, backend, and CLI upgrades cannot silently break identity, permissions, or tool capabilities.

**[Optional]** Push notifications, offline chat, background voice, and a custom automatic Mac updater are unimplemented or outside the current release path. They are separate roadmap choices and are not deducted merely for being absent.

**Finished when:** the exact downloadable/store builds let supported customers install, authenticate/link correctly, use the advertised workflows, recover from interruptions, update, and obtain support.

### F12. Usage visibility and administration — 65%

**Assessment:** meaningful provider metering and administration exist. A complete cost picture, operational proof, and the separate paid Swarm product lifecycle remain unfinished. Evidence: [E11](#evidence), [E13](#evidence), [E14](#evidence), [E16](#evidence), [E18](#evidence).

#### What is built

- Tokens, requests, activity, provider/model/Bot breakdowns, and account-scoped usage views.
- Provider-reported prices where supplied and explicitly identified estimates elsewhere.
- Subscription cost-source labeling and complete/partial/unavailable usage representation.
- Estimated computer runtime/cost presentation and CSV exports.
- Bot activity and explicitly estimated time-saved analytics.
- Administrator-managed keys/settings, private account keys, and role/bootstrap protections.
- Account/session management and account-deletion entry points.
- Hosted capacity/recovery/monitoring tools and operational documentation.

#### What is missing to finish it

- **[Validate] Reconciliation:** compare reports with actual provider records across retries, cached usage, approval stops, partial responses, and failed work.
- **[Validate] Unknown-cost behavior:** keep unknown/partial counters distinguishable from zero and avoid presenting subscription API cost of $0 as a free total service.
- **[Validate] Computer costs:** reconcile runtime and sleep/stop accounting for each offered deployment; historical price estimates are not invoices.
- **[Decide] Full cost model:** include voice, messaging, connectors, storage/backups, network, control plane, support, and payment costs in commercial pricing.
- **[Validate] Account visibility:** prove customer reports/exports remain private and administrator access is restricted and auditable.
- **[Validate] Key/admin lifecycle:** test validation, rotation, revocation, restart, role changes, and recovery without exposing secrets or losing required administration.
- **[Decide] Spend controls:** distinguish informational usage from enforceable entitlements/budgets; define limits and behavior for every funded service.
- **[Build] Swarm billing:** add checkout, paid-plan records, and entitlement enforcement, or explicitly operate a documented manually billed pilot.
- **[Build] Payment lifecycle:** handle authenticated/retried payment events, trial expiry, failed payments, plan changes, cancellation, refunds, and invoices with applicable tax treatment.
- **[Decide] Cancellation/data policy:** specify when access, background routines, paid computers, retention, exports, and deletion change after cancellation.
- **[Validate] Operator readiness:** prove cost/backlog/backup alerts, account support diagnostics, incident escalation, restore, and deletion workflows on the shipping stack.
- **[Validate] Data growth:** exercise aged usage/backup metadata and export queries at the supported account/history volume.
- **[Decide] Analytics claims:** keep time-saved estimates explainable and separate from measured productivity or guaranteed customer ROI.
- **[Validate] Customer experience:** ensure limits, charges, provider errors, admin failures, and cancellation steps are understandable and accessible without engineering help.

**Finished when:** customers understand their actual billing source and usage, operators can safely support/recover accounts, and the business can charge and stop charging consistently with the service and data policy it promises.


## 2. Main blockers, in priority order

**Launch gate** means required for the advertised release scope. **Growth gate** means required before increasing demand or making the corresponding availability/capacity promise. These are product release priorities, not security severity scores. Owners below are suggested roles; no individual has been assigned.

### B1. Make action authorization reliable

**Launch gate · Confirmed defect · Owner: security / agent runtime**

The default classifier treats read-like words anywhere in an app tool name as evidence of a read. For example, `GITHUB_CREATE_A_CHECK_RUN` is classified as read-only and can receive automatic permission when no explicit policy exists. A local probe reproduced the classification; no external write was executed.

**Close when:** trusted action metadata replaces name inference; unknown/conflicting actions require approval; regression tests and controlled provider witnesses prove that a write cannot run before its required approval across API and native CLI paths. Preserve explicit saved permissions and revocation. [E05](#evidence), audit D01.

### B2. Protect customer work and prove recovery

**Launch gate · Confirmed defect + recovery evidence missing · Owner: data / infrastructure**

An overdue full-environment backup takes priority over every database-only backup. If that full snapshot repeatedly fails, fresh database protection can stop. A local synthetic test reproduced three failed full attempts while a direct database-only backup succeeded on the same data. Backup cleanup also has a nominal ceiling of 100 records per minute, while 500 running hosts at a four-minute snapshot cadence generate about 125 per minute. Storage growth can exceed the backup format's supported envelope.

**Close when:** database backups continue despite profile/upload failure; cleanup drains faster than creation; supported data sizes and disk reserve are enforced; actual encrypted tenant restores and separate platform database recovery meet recorded recovery objectives. [E13](#evidence), D04–D06/D15/D22.

### B3. Qualify the hosted account boundary

**Launch gate for isolated hosting · Evidence and enforcement gaps · Owner: infrastructure / security**

The isolation design is implemented, but no current end-to-end deployment qualification was established here. Runtime image admission checks are weaker than the separate operator verifier's provenance checks. Existing plans record unfinished real-host containment and image qualification. This is not evidence of a demonstrated cross-account breach.

**Close when:** the exact signed images pass current scans and real-host containment tests; two staged accounts cannot cross data, credential, filesystem, or network boundaries; mandatory admission validates the required provenance; an independent review closes material findings. [E12](#evidence), D09/D21.

### B4. Finish the promised customer workflow

**Launch gate for included features · Confirmed integration gaps · Owner: product / application / native**

Four connected journeys need repair: isolated Library files are not exposed to desktop tools through a working exchange; isolated direct API keys are not used consistently by model discovery; native Google linking loses linking intent and some isolated Apple/OpenRouter completion paths lack the initiating session; shared administrator-funded voice is not wired for isolated accounts. These findings do not mean every login, model, or file path is broken.

**Close when:** a new account can sign in, choose its intended model, connect an app, complete real work using an input file, approve the correct action, download the result, and return later with state intact. Repeat the advertised voice/native variants and recover from interruption. A feature excluded from the first release should be clearly unavailable in that release. [E02](#evidence), [E03](#evidence), [E07](#evidence), [E10](#evidence), D16–D20/D23.

### B5. Add a complete paid-product lifecycle

**Launch gate for paid self-service · Implementation not found in this repository · Owner: product / payments / finance**

The repository contains provider usage accounting and AI subscription connections. The reviewed application routes, UI, and dependencies did not reveal Swarm checkout, recurring customer billing, paid-plan entitlements, invoicing, cancellation, or refund handling. A Stripe entry in the connected-app catalog is not a Swarm payment integration. No existing external/manual billing process was verified.

**Close when:** pricing states what Swarm supplies and who pays for models, computers, voice, and messaging; payment events reliably grant/revoke the correct entitlements; failed payment, trial expiry, upgrade/downgrade, cancellation, refunds, invoices, and applicable tax handling have tested paths. A manually billed, supported pilot is an alternative if deliberately scoped, with explicit limits and terms. [E11](#evidence)

### B6. Make capacity and unit economics sustainable

**Growth gate; budget gate before paid commitments · Design limits + incomplete automation · Owner: runtime / operations / finance**

The platform currently requires one serving process because tenant tunnel ownership is held in process memory. The default 4 GiB host can have container ceilings exceeding its RAM: app + desktop + two helpers total 4.5 GiB before host overhead. This is a sizing risk, not a measured universal crash. Automatic idle suspension for isolated hosts is not wired/qualified, so fewer active users may still mean all provisioned hosts keep running.

**Close when:** measured overlapping workloads fit the supported configuration; idle/wake or a costed operating policy works; routing supports the promised availability; provider quotas, realistic peak concurrency, recovery, and a sustained load test pass. Establish contribution margin from measured total cost before promising a price or unlimited usage. [E14](#evidence), D02/D03/D07.

### B7. Validate real providers and task completion

**Launch gate for each offered provider · Live evidence incomplete · Owner: integrations / quality**

Local fixtures and installed-CLI probes do not prove real hosted subscription access, tool execution, OAuth expiry/revocation, quota behavior, or provider permission for the intended service. The newest CLI tool transport needs complete live-task qualification. Subscription final text is buffered; customer-visible latency has not been qualified for the launch workflow.

**Close when:** controlled accounts complete the supported model/tool/task matrix on the exact release; provider-side observations confirm the effects; rate limits, cancellation, uncertain outcomes, and credential revocation behave correctly; selected billing does not silently change. Confirm commercial permissions and quotas with the providers, and measure task success and warm/cold response times. [E02](#evidence), [E04](#evidence), [E15](#evidence), D11/D14.

### B8. Operate a service customers can trust

**Launch gate for public service · Operational and business evidence incomplete · Owner: operations / support / business**

Monitoring rules, deletion controls, and operational runbooks exist. This review did not establish working alert delivery/on-call response, production recovery drills, or a complete customer-facing package of privacy terms, retention commitments, support, and incident communication. Account-deletion UI alone does not prove removal from backups and external services under the promised policy.

The repository's MIT license permits commercial use provided its notice is retained. Bundled third-party assets and external service/subscription terms have separate conditions; the repository license alone does not settle those rights.

**Close when:** a named operator receives and resolves a test incident; restore and deletion drills pass; support and escalation channels work; published terms, privacy/retention disclosures, provider responsibilities, and customer commitments match the deployed service. Update older documentation that overstates or understates current behavior. [E10](#evidence), [E16](#evidence), D10/D13.

### B9. Finish public native distribution

**Channel gate · Release evidence incomplete · Owner: native / release**

Mac packaging/signing/notarization tooling exists, but an actual final public release was not verified. The iOS path builds a simulator app; the current `apple:test` command runs the Mac scheme. Signed-device testing, an iOS release submission, and final store/privacy/support materials remain necessary for an advertised native launch.

**Close when:** each shipping platform passes install, sign-in/linking, permissions, computer control, voice, update, and recovery tests on supported devices; Mac downloads are signed/notarized and accessible; iOS has the required release pipeline and App Store acceptance. Native distribution can follow a web launch. [E10](#evidence), D12.

## 3. The commercial cost question

**These are historical planning inputs, not a current provider quote or a complete operating budget.** Existing plans target **2,000 registered accounts**. The suggested 250 steady / 500 burst active-user workloads remain proposals, not measured capacity or an approved peak requirement.

Registered accounts, active users, and running computers are different quantities. Using the earlier planning assumptions of **$25.39 per running computer-month** and **$1.50 per retained 10 GiB account volume-month**:

| Average running computers during the month | Registered/provisioned accounts | Compute + persistent volume subtotal/month |
| --- | ---: | ---: |
| 250 | 2,000 | $9,347.50 |
| 500 | 2,000 | $15,695.00 |
| 2,000 | 2,000 | $53,780.00 |

The lower scenarios require computers to actually stop; low user activity alone does not achieve them. All scenarios exclude stopped-machine root filesystems, the control plane, PostgreSQL, backup/storage requests, network/video traffic, model APIs, voice, Composio, messaging, monitoring, support, payment costs, and taxes. Customers bringing an AI subscription still incur infrastructure and other service costs. Reprice the full bill and measure cost per successful task before setting margins. [E14](#evidence)

## 4. A practical route to launch

| Stage | Work to complete | Evidence required to advance |
| --- | --- | --- |
| **1 · Define the first offer** | Choose the first customer/use case, standalone vs isolated hosting, web/native scope, supported providers, what the price includes, and a bounded workload/data envelope. | One written customer promise, a named owner, a cost model, and measurable success/latency/recovery targets. |
| **2 · Qualify one complete workflow** | Repair B1/B2 and applicable B4 defects. For isolated hosting, close B3. Exercise signup → AI connection → app/file task → approval → result → return/recovery. | Real provider results, correct account boundaries, fault/restart evidence, and actual restore. No release claim based only on fixtures. |
| **3 · Run a controlled paid pilot** | Finish self-service billing or define manual billing; put support, terms, alerting, limits, and incident handling in place. Start with a bounded invited cohort. | Customers can receive value, pay, get help, cancel, and delete. Measure task success, completion time, cost, and support effort. |
| **4 · Expand the launch** | Qualify agreed concurrency and running-host count, fix routing/cost constraints, and complete native channels included in the offer. | Sustained load/failure results, approved capacity and budget, operational recovery evidence, and final native release receipts where applicable. |

**Existing-account migration is a separate conditional gate.** The current migration machinery does not yet establish a complete source-writer freeze, rollback/resume, and retirement. If existing users must move at launch, prove these before cutover. A new-account-only launch needs an explicit continuity and migration plan for existing customers. [E17](#evidence), D08.

Do not assign a delivery date from this source review. Time depends on the chosen launch scope, available engineers, provider access, real infrastructure evidence, and native review. The recommended next milestone is **one repeatable, recoverable customer workflow with measured cost**, followed by a controlled pilot.

## 5. Verification performed for this report

| Check | Result | What it establishes |
| --- | --- | --- |
| Current source and inherited plans | HEAD matches the earlier audit: `7e67b384b6ecccf17f322b61a2a10e4de5a3d1d8`. | Main findings were checked against current source; prior plans remain plans, not fixes. |
| `npm run typecheck` | Passed. | Server and web TypeScript checks. |
| `npm run build` | Passed. | Web production bundle and server compilation. |
| Selected model, Composio, and provider-harness tests | **58 passed; 0 failed; 0 skipped.** | Isolated/local fixture coverage only. |
| Current-source approval classifier probe | Reproduced the read-only classification of `GITHUB_CREATE_A_CHECK_RUN`. | Confirms B1's classification; no connected-app action was executed. |
| Synthetic backup scheduler probe | Three failed full snapshots left database-backup time unset; a direct DB-only snapshot succeeded. | Reproduces B2 without customer data or external storage. |

Tests: `node --import tsx --test --test-concurrency=1 tests/models.test.mts tests/composio.test.mts tests/provider-qualification.test.mjs`. Probe and test logs are saved in the workspace's `.context/` directory. No application fixes, production changes, live provider transactions, payments, capacity tests, or signed-device tests were performed as part of this artifact.

## Evidence

Source references are relative to this document. The full SHA above fixes the reviewed application snapshot. References to the pre-existing uncommitted planning documents describe local evidence, not published release receipts.

| ID | Source anchors | Supports |
| --- | --- | --- |
| E01 | [Bot setup](../server/src/bot-setup.ts), [agent tools](../server/src/agent/tools.ts), [memory](../server/src/agent/memory.ts), [subagents](../server/src/agent/subagents.ts), [rooms](../server/src/agent/rooms.ts) | Teammates, collaboration, memory, tasks. |
| E02 | [CLI routes](../server/src/cli/routes.ts), [model catalog](../server/src/routes-models.ts), [model execution](../server/src/lib/llm.ts), [CLI tool transport](cli-native-mcp.md) | AI access; model discovery mismatch at `routes-models.ts:49–59` versus `lib/llm.ts:27–35`. |
| E03 | [Computer providers](../server/src/computers/index.ts), [local computer](../server/src/computers/local.ts), [runtime host](../server/src/runtime/host.ts), [companion](../companion/swarm-companion.mjs) | Computer modes; distinct app `/files` and desktop `/home/agent` mounts at `host.ts:125–131`. |
| E04 | [Composio](../server/src/composio.ts), [MCP store](../server/src/mcp/store.ts), [MCP OAuth](../server/src/mcp/oauth.ts), [connections isolation](connections-isolation.md) | Personal connections, tool configuration, OAuth, encrypted configuration. README claims about absent MCP OAuth/plaintext secrets are stale. |
| E05 | [Classifier](../server/src/composio.ts), [approval decision](../server/src/agent/tools.ts), [gateway metadata](../server/src/platform/composio-policy.ts) | `composio.ts:280–281` and `agent/tools.ts:641–660`; classification drives default permission despite safer metadata elsewhere. |
| E06 | [Routines](../server/src/routines.ts), [limits](../server/src/routine-limits.ts), [triggers](../server/src/triggers.ts), [proactive work](../server/src/proactive.ts) | Scheduled/event work and guardrails. |
| E07 | [Voice](../server/src/voice.ts), [credential selection](../server/src/lib/voice-provider.ts) | Voice capability; tenant-only private key at `voice-provider.ts:7–10`. |
| E08 | [Messaging bridge](../server/src/messaging/bridge.ts), [inbox](../server/src/messaging/inbox.ts), [text signup](../server/src/messaging/signup.ts), [messaging guide](messaging.md) | Messaging, media, approvals, signup, allowances. |
| E09 | [Task board](../web/src/components/config/TasksView.tsx), [Library](../web/src/components/config/LibraryTab.tsx) | Customer task/file interface. |
| E10 | [Native client](../apple/Swarm/AppModel.swift), [platform auth](../server/src/platform/auth.ts), [Apple build script](../scripts/apple.sh), [Mac release workflow](../.github/workflows/release-mac.yml), [native guide](apple-apps.md) | Linking contracts (`AppModel.swift:212,262,323,338,374`), distribution, device limits. |
| E11 | [Usage](../server/src/usage.ts), [usage settings](../web/src/components/config/UsageSection.tsx), [subscription settings](../web/src/components/config/SubscriptionSettings.tsx), [root manifest](../package.json) | Provider metering/subscription connection. Billing absence is a scoped search finding, not proof about systems outside this repository. |
| E12 | [Platform deployment](../infra/platform/README.md), [qualification](tenant-qualification.md), [image admission](../server/src/platform/release-policy.ts), [operator verification](../server/src/platform/release-gates-cli.ts) | Isolated architecture and incomplete deployment/provenance qualification. |
| E13 | [Host backups](../server/src/runtime/backups.ts), [backup format](../server/src/platform/backup.ts), [cleanup](../server/src/platform/backups.ts), [provisioner](../server/src/platform/provisioner.ts), [capacity policy](../server/src/platform/tenant-capacity.ts) | Full-first scheduling at `backups.ts:59–86`; 12 GiB format cap; 10,000 GiB volume-policy ceiling; 100-item cleanup selection. |
| E14 | [Tunnel ownership](../server/src/platform/tunnel.ts), [single-serving-instance manifest](../infra/platform/fly.platform.toml), [host sizing](../server/src/platform/fly-tenants.ts), [container limits](../server/src/runtime/container-policy.ts), [corrected cost scenarios](2000-user-release-prompt.md) | Availability, memory, running-host economics. Cost scenario section 6.2 supersedes older active-user assumptions. |
| E15 | [Provider qualification guide](provider-qualification.md), [harness](../scripts/qualify-providers.mjs), [offline CI](../.github/workflows/provider-qualification.yml) | Distinguishes fixture coverage from live provider acceptance. |
| E16 | [Monitoring](tenant-monitoring.md), [recovery operations](tenant-recovery-operations.md), [account deletion](../server/src/accounts.ts), [privacy manifest](../apple/Swarm/PrivacyInfo.xcprivacy), [MIT license](../LICENSE), [third-party notices](../THIRD_PARTY_NOTICES.md) | Operational foundations; deployment, recovery, and customer disclosures still need evidence. Commercial source use is permitted with notices; asset/provider terms are separate. |
| E17 | [Legacy migration implementation](legacy-migration-implementation.md), [release fix plan](public-release-fix-plan.md), [first-user plan](first-user-reliability-master-plan.md), [full audit](2000-user-release-prompt.md) | Conditional migration gate and detailed engineering follow-through for D01–D23. |
| E18 | [Agent settings and memory UI](../web/src/components/config/BotSettingsModal.tsx), [memory routes](../server/src/routes.ts), [durable jobs](../server/src/agent/jobs.ts), [browser recovery](browser-recovery.md), [routine controls](../server/src/routine-limits.ts), [messaging inbox](../server/src/messaging/inbox.ts), [voice client](../web/src/voice/call.ts), [task-board behavior](task-board.md), [analytics estimates](../server/src/analytics.ts) | Additional source checks for feature scoring and detailed completion checklists. Missing validation/decisions are separately labelled; they are not newly reproduced defects. |
