# Master development spec: full per-tenant isolation and a fully working isolated Swarm

**Status: APPROVED by the workspace owner on 19 November 2026 · Written 19 November 2026 against `main` at `1cb61bb` · Owner: workspace owner · Coordinator: release coordinator session**

This is the single guideline every agent follows to take Swarm from today's shared server to a fully working, per-account isolated platform. It does not replace the detailed design documents; it sequences them, names the gaps, and defines when the work is finished. Where this spec and an older plan disagree about *order or scope*, this spec wins. Where they disagree about *security behaviour*, the stricter rule wins until the isolation owner and reviewer resolve it.

The owner approved this spec on 19 November 2026, together with decisions D1, D2 and D4 (section 4). Isolation PRs #55 and #56 keep their review-only hold until the owner lifts it explicitly.

Detailed references: [isolation design](tenant-isolation.md) · [qualification plan](tenant-qualification.md) · [infrastructure decisions](tenant-infrastructure-decisions.md) · [staging bootstrap runbook](../infra/platform/staging-bootstrap.md) · [tenant host images](../infra/tenant-host/README.md) · [containment qualification](../infra/tenant-host/qualification/README.md) · [capacity model](tenant-capacity-model.md) · [capacity operations](tenant-capacity-operations.md) · [recovery operations](tenant-recovery-operations.md) · [monitoring](tenant-monitoring.md) · [legacy migration](legacy-migration-implementation.md) · [connected-app isolation](connections-isolation.md) · [shared-server releases](staging-release.md).

---

## 1. Goal and definition of done

**Goal:** every Swarm account runs in its own isolated environment, and everything a user can do on today's shared server works there.

"Full per-tenant isolation is enabled" means all of the following are true and evidenced:

1. **Per-account environment.** Every new account is provisioned with its own Fly app, private network, microVM, encrypted volume and KMS-wrapped data key. Its Bots, database, files, browser profiles, subscription sign-ins and custom tools exist only there.
2. **No shared execution with other customers.** No account's agent turns, CLI subscriptions, desktop, browser or MCP processes run in the shared server or in another tenant.
3. **Containment proven on the real boundary.** The published, signed tenant host image has passed the real-Fly containment job, and a two-tenant test shows tenant A, including a compromised workload with root inside its containers, cannot reach tenant B's network, data, credentials, viewer or runtime identity.
4. **Feature parity.** Every feature in section 6 passes its acceptance check *through a tenant*, not through the standalone server.
5. **Recoverable and deletable.** Backup, restore and deletion drills have passed against real S3 and KMS within the targets in section 7.
6. **Operable.** Monitoring alerts reach a real destination, and abort/hold controls work.
7. **Existing users handled.** Every existing account has been migrated or re-linked under the owner's chosen policy (decision D5), and the shared server no longer serves customer workloads.
8. **Reviewed.** An independent security assessment has no open critical or high findings.

A deterministic test, a simulation, a skipped test or a fixture is never evidence for items 3 to 8.

## 2. Where we are (verified 19 November 2026)

### Live today

| Component | State |
|---|---|
| `swarm-team` (Fly) | One shared server, `SWARM_ROLE=standalone`, release v41, deployed from `main` by `.github/workflows/staging.yml` (the run for `1cb61bb` failed at its publish-and-backup step, so the live revision is an earlier `main` commit). [staging-release.md](staging-release.md) calls this app "staging", but it is the only environment serving users. |
| `swarm-team-vms` (Fly) | One cloud VM and volume per user for desktops. All user VMs share one Fly app and network. |
| User separation | Application ownership checks on one shared process and one shared SQLite database. Only desktops are physically separate. |

### Isolated platform: built, not running

- **Code on `main`:** platform, provisioner, Composio gateway, tenant host and runtime roles; per-tenant KMS envelopes; session and revocation propagation; backup, restore, resize, image update, deletion; migration libraries; release gates; monitoring rules. About 100 source files and 25+ test files. `npm run test:isolation` runs on a real PostgreSQL in CI.
- **Staging shells on Fly:** `swarm-platform-staging`, `swarm-provisioner-staging`, `swarm-gateway-staging`, `swarm-migrate-staging` exist with **zero machines**. Managed Postgres `swarm-staging-pg` exists and is migrated but is not attached. Secrets staged: platform (session secret, database URL, platform key pair), provisioner (session secret, database URL, Fly token, org slug), gateway (database URL, public key). These apps live in the `personal` org beside production.
- **Missing inputs:** AWS (KMS key, backup bucket, credentials), Composio platform project key and webhook secret, tenant host image digest, release-gate evidence, image signing key, GitHub `tenant-image-release` environment. On the owner's Mac today there is no AWS profile, no `~/.swarm-staging-aws.env`, and no cosign.

### Latest image scan (dry run, run 43862578772, source `0f55060`, 16 November)

No image was published; every image failed the HIGH/CRITICAL gate.

| Image | Findings | Unique CVEs | Fixable | Notes |
|---|---|---|---|---|
| app (also runner and MCP) | 71 HIGH | 20 | 0 | Debian packages, no upstream fix |
| host base / host | 57 HIGH | 15 | 10 | Fixable: `golang.org/x/net` ×9, `go-jose/v4` ×1, inside the Docker 29.9.3 static binaries |
| desktop base / desktop | 172 HIGH, 1 CRITICAL | 67 | 0 | CRITICAL CVE-2026-6653 in `libxml2` (enters via GTK/Xvfb/Mesa) |

An evaluation of a Wolfi base for the desktop found it not viable as a straight swap (free Chromium is stale; `xdotool` and x11grab FFmpeg are missing). See `.context/program/wolfi-desktop-base-evaluation.md` in the coordinator workspace.

### Open isolation work in flight

- **#55** trusted host usage collection for tenant capacity (draft, review only).
- **#56** refuse foreign or unresolved job references before tenant export (draft, review only).

Both are captured from the isolation owner's frozen handoff and wait for the owner to lift the isolation no-commit/no-deploy hold.

## 3. Rules every agent follows

### Security invariants (never weaken to get a pass)

1. Never disable seccomp, the Chrome sandbox, cgroup limits, read-only roots, firewall rules or capability drops to make a test pass. A test that cannot run is reported as *not run*.
2. Never fabricate, back-date or hand-edit release-gate evidence. Evidence is produced only by the qualification tooling against an exact image digest.
3. A tenant never receives platform, Fly, Composio-project, AWS, S3 or PostgreSQL credentials. The platform never receives a tenant's plaintext data key outside the envelope code path.
4. No fallback between accounts: no operator subscription, no platform model or voice key, no other account's connected app. Missing or exhausted credentials stop work with a clear message.
5. Never copy production secrets into staging. Never print secret values in logs, chat, PRs or evidence.
6. Unknown external outcomes are reconciled, never blindly replayed.
7. Do not run destructive Fly, AWS or database commands outside the inventory named in the current work package.

### Working rules

1. **Worktrees only.** Work in `.context/<area>` worktrees on branches named `agenticwizzard007/<area>-<topic>`. Never edit the shared root checkout.
2. **One work package per PR**, scoped to the files the package names. Cross-package edits need the other owner's agreement in their handoff.
3. **Merge conditions** (from the release coordination protocol): owner manifest hashes verified on the exact head, CI green, coordinator full suite green (including `test:isolation` on real PostgreSQL), and an independent exact-head review marked CLEAR. Merges use merge commits, not squash.
4. **Evidence location:** `.context/<area>-evidence/` with a `README.md` stating what was run, on which commit and image digest, the raw outputs, and what was *not* run.
5. **Status:** update the tracker in section 9 in your PR (status, PR link, evidence link). The coordinator keeps `.context/program/status.md` as the running log.
6. **Anything that costs money or touches a live service** waits for the owner's go-ahead for that specific step, even if an earlier step was approved.
7. **Report honestly.** Simulated time, mocked providers and local-only results are labelled as such in PRs and evidence.

## 4. Owner decisions and inputs (blocking)

Each decision has a recommended default. The coordinator asks for each one when its workstream is next; agents never assume an answer.

| ID | Decision or input | Recommended | Blocks |
|---|---|---|---|
| D1 | Key service | AWS KMS as coded. The owner creates the AWS account and an admin profile on the Mac; an agent runs `infra/platform/aws/setup.sh` and `verify-kms.mjs`. | WS2 onward |
| D2 | Image vulnerability policy | Fix everything fixable. Unfixable findings require a written, per-CVE exception with reachability notes, an expiry date of at most 30 days, and a recheck on every build. The libxml2 CRITICAL needs explicit owner sign-off or removal of its dependency chain. | WS1 publication |
| D3 | Composio for the platform | A separate staging project: the owner supplies the key and webhook secret in a protected file on the Mac. | WS3, WS5 apps |
| D4 | Signing and spend | A cosign key generated on the owner's Mac and stored in the GitHub `tenant-image-release` environment. Staging spend is about $119/month plus about $27/month per running test tenant. | WS1, WS3 |
| D5 | Existing users | One scheduled maintenance window for the shared server (the simplest provable writer boundary), then migrate each account; users who are not migrated re-link with fresh sign-in. | WS9 |
| D6 | Fly organisation and limits | A dedicated staging org; ask Fly to raise machine, app, volume and network limits before the capacity ramp. | WS3, WS10 |
| D7 | Alert destination | One of Slack, email or PagerDuty. | WS8 |
| D8 | Test identities | Two Claude and two ChatGPT subscriptions, test Google and Apple identities, an Inkbox staging line. | WS5, WS6 |
| D9 | Production domains | Owned HTTPS origins for platform and gateway. | WS12 |
| D10 | Scaling policy | Per-tenant min/max CPU, RAM and disk, spend ceilings, whether resizes may interrupt busy tenants. | WS10 |

## 5. Workstreams

Each workstream lists its scope, deliverables and acceptance. "Role" names the owning session type; the coordinator assigns concrete sessions.

### WS0 · Coordination and this spec
- **Role:** release coordinator.
- **Deliverables:** approved spec; tracker kept current; decisions D1–D10 recorded with dates; weekly status in `.context/program/status.md`.
- **Accept:** every work package has an owner, a branch, and a tracker row.

### WS1 · Tenant images: secure, signed, published
- **Role:** image owner.
- **Scope:** `infra/tenant-host/**`, `images.lock.json`, `.github/workflows/tenant-images.yml`.
- **Deliverables:**
  1. Re-run the dry build on current `main`.
  2. Bump Docker static binaries to a release that clears the 10 fixable Go findings; refresh the Debian snapshot; rescan.
  3. Reduce the desktop package set (drop unused GTK, Mesa and X components; evaluate building without `libxml2` reachability) to shrink unfixable findings.
  4. Add a reviewed exceptions file (CVE, package, image, reachability, owner, expiry) read by the scan gate. Fixable findings and expired exceptions still fail.
  5. Create the GitHub `tenant-image-release` environment with `FLY_IMAGE_PUSH_TOKEN`, `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD` and variable `TENANT_PLATFORM_PUBLIC_KEY`, restricted to `main` with required reviewers.
  6. Publish through the workflow; record digests in `reports/images.json`.
- **Accept:** a signed host image digest from `main`, `cosign verify` passing, image smoke passing, scan clean except owner-approved exceptions.
- **Depends on:** D2, D4.

### WS2 · Cloud foundations
- **Role:** isolation owner with the owner present for account creation.
- **Deliverables:** KMS key and IAM principal limited to `GenerateDataKey`/`Decrypt`/`DescribeKey` with `purpose=swarm-tenant-master-v1`; private versioned backup bucket with lifecycle rules; Postgres attached with session-pooled or direct endpoints; staging org and org-scoped Fly token (D6); all secrets imported from protected files and shredded.
- **Accept:** `verify-kms.mjs` passes (same tenant decrypts, other tenant refused); IAM denial outside the backup prefix shown; Postgres LISTEN connection works from the platform role.
- **Depends on:** D1, D6.

### WS3 · Platform roles running in staging
- **Role:** isolation owner.
- **Deliverables:** one pinned platform image deployed to platform, provisioner and gateway with `--ha=false`; exactly one machine per role; health endpoints green; provisioner refusing to provision until WS4 evidence exists.
- **Accept:** `/api/health` reports the right role for each app; revocation notifications reach the platform; the gateway verifies runtime tokens.
- **Depends on:** WS1 (image digest for the provisioner), WS2, D3.

### WS4 · Containment and network qualification
- **Role:** isolation owner, independent reviewer.
- **Deliverables:**
  1. Real-Fly containment job on the exact published host digest (single VM): non-root, read-only roots, capabilities, seccomp, cgroups, PID/memory limits, mounts, IPv4/IPv6, metadata blocking, Chrome sandbox, desktop-to-app exception.
  2. Release-gate evidence recorded through `release-gates-cli` for `fly-network-isolation`, `nested-container-containment`, `signed-runtime-image`, `provider-hosted-login`, `provider-quotas`.
  3. Two-tenant test: separate apps, volumes and networks; a deliberately compromised workload in tenant A cannot reach tenant B or use B's identity, viewer or provider credentials.
- **Accept:** reviewer signs the evidence; any unauthorized success stops the program until fixed.
- **Depends on:** WS1, WS3.

### WS5 · Fully working tenant (feature parity)
- **Role:** feature owners (CLI, voice, apps, messaging, desktop, knowledge), coordinated by the isolation owner.
- **Deliverables:** the checklist in section 6 passes through a tenant, with tenant-specific fixes landed as separate PRs. Each feature owner adds or adapts an automated tenant-mode test where one is feasible, plus a recorded live check.
- **Accept:** every section 6 row is PASS with evidence; no row passes by routing through the standalone server.
- **Depends on:** WS3, WS4, D3, D8.

### WS6 · Sign-up, sign-in and routing into tenants
- **Role:** isolation owner, messaging owner.
- **Deliverables:** new-account sign-up through Google, Apple, OpenRouter and phone creates a tenant and routes the browser, native apps and messaging into it; delegated tenant cookies; invite and waitlist controls on the platform; account deletion end to end.
- **Accept:** a fresh identity on each provider reaches its own tenant; a delegated tenant cookie cannot authenticate platform or admin routes; deletion removes VM, volume, key and provider connections and is visible until complete.
- **Depends on:** WS3, D8.

### WS7 · Backup, restore and deletion drills
- **Role:** isolation owner, reviewer.
- **Deliverables:** scheduled backups running on a real tenant; restore into a new volume; image update with rollback; deletion with key destruction.
- **Accept:** database loss at most 5 minutes; full environment backup at most 24 hours old; full restore within 30 minutes including disk space on the 10 GB volume; foreign host and runtime tokens refused; snapshot-era jobs and approvals reconciled, never replayed.
- **Depends on:** WS2, WS3, WS4.

### WS8 · Monitoring, alerting and abort controls
- **Role:** isolation owner.
- **Deliverables:** metrics collectors beside each platform role; alert rules in `infra/monitoring` wired to D7; tenant hold and platform abort procedures documented and drilled.
- **Accept:** a forced backup-age, revocation-listener or readiness failure produces an alert at the destination within the stated window; a hold stops tenant workloads.
- **Depends on:** WS3, D7.

### WS9 · Existing users: migration or re-link, then retire shared execution
- **Role:** isolation owner, reviewer; coordinator for the user-facing window.
- **Deliverables:** the legacy source adapter (freeze, inspect, restore, resume, retire) for the chosen D5 policy; #56 merged after review; a dry run on a copy of the real database; user communication; per-account migration; source retirement evidence; the shared server switched to routing-only or retired.
- **Accept:** each migrated account's Bots, history, files and connections work in its tenant; no account has two live writers; unmigrated accounts re-link; no customer workload runs on `swarm-team`.
- **Depends on:** D5, WS5, WS6, WS7.

### WS10 · Capacity and cost ramp
- **Role:** isolation owner.
- **Deliverables:** #55 merged after review; usage-based sizing from real samples; Fly limit increase (D6); staged tests at 25, 100, 250, 500 and 1,000 active tenants plus a 1,250 burst and a 24-hour soak, with 0/10/100% desktop viewing.
- **Accept:** API p95 under 500 ms, warm task admission p95 under 2 seconds, platform errors under 1%, no lost accepted work, bounded memory and queues; measured cost per active tenant recorded against the model.
- **Depends on:** WS5, D6, D10.

### WS11 · Independent security assessment
- **Role:** external or independent reviewer, not an implementing session.
- **Deliverables:** adversarial assessment of the platform, gateway, tenant host and relays, including the compromised-tenant scenario.
- **Accept:** no open critical or high findings; mediums have owners and dates.
- **Depends on:** WS4, WS6.

### WS12 · Production environment and launch
- **Role:** coordinator, isolation owner.
- **Deliverables:** production org, owned domains (D9), production secrets and keys separate from staging, the same qualification gates re-run on the production image digest, a launch runbook with rollback.
- **Accept:** new sign-ups land in isolated tenants in production; items 1 to 8 of section 1 are evidenced.
- **Depends on:** all of the above.

### Out of scope for this spec
Hermes Agent as an optional per-tenant engine, Bot HQ presentation features, new messaging channels, and new model providers. These can start after M4 and must run inside the tenant boundary as new qualified workloads.

## 6. Feature parity checklist (tenant mode)

Each row passes only when exercised through a tenant, with the evidence linked.

| ID | Feature | Acceptance through a tenant |
|---|---|---|
| P01 | Sign-up and sign-in | Google, Apple, OpenRouter and phone each create or reach their own tenant |
| P02 | Bots and onboarding | Create, configure and chat with a Bot; primary Bot guided setup completes |
| P03 | API models | xAI and OpenRouter turns with the account's own key; usage recorded |
| P04 | Subscriptions | Claude Code and Codex sign-in inside the tenant's subscription container; turns, tools and continuous tasks run; no fallback |
| P05 | Desktop and browser | Tenant desktop wakes; watch and take control through the relay; Chrome sandbox on; CAPTCHA handoff works |
| P06 | Connected apps | Connect through the gateway; read runs immediately; write waits for approval; another tenant cannot select the account |
| P07 | Custom MCP | Remote server with SSRF protections; local stdio command runs in the tenant's MCP container; folder grants read-only |
| P08 | Approvals and permissions | Approve, always-allow, deny, revoke; revocation blocks queued calls |
| P09 | Routines and events | Timed and event routines fire inside the tenant; guardrails enforced; events delivered encrypted from the platform |
| P10 | Messaging | iMessage, SMS and WhatsApp reach the right tenant; approvals and voice notes work; uncertain sends are not retried |
| P11 | Voice | Realtime call hands work to the tenant's Bot; dictation works |
| P12 | Library and deliverables | Saved files, downloads and approved delivery through messaging |
| P13 | Learning, memory and Quinn | Skills, sourced memory, team board and coordinated specialists work and survive restart |
| P14 | Usage and administration | Per-account usage and cost; owner admin roles on the platform only |
| P15 | Native apps | Mac and iPhone/iPad clients pair with and use the tenant |
| P16 | Backup and recovery visible to the user | Restart and restore keep history; uncertain work is shown, not replayed |
| P17 | Deletion | User-initiated deletion completes and is reflected everywhere |

## 7. Milestones and exit criteria

| Milestone | Exit criteria |
|---|---|
| **M0 Spec approved** | Owner approves this spec; D1–D4 answered; holds on #55/#56 lifted or confirmed |
| **M1 Images published** | WS1 accepted |
| **M2 Staging platform up** | WS2 and WS3 accepted |
| **M3 Containment proven** | WS4 accepted, gate evidence approved |
| **M4 First working tenant** | P01–P08 pass through one tenant; WS7 restore drill passed once |
| **M5 Feature-complete staging** | Section 6 all PASS; WS6, WS7, WS8 accepted; WS11 started |
| **M6 Existing users and capacity** | WS9 and WS10 accepted; WS11 has no open critical/high |
| **M7 Production launch** | WS12 accepted; section 1 fully evidenced |

## 8. Agent handoff template

Every PR and handoff note includes:

```
Work package: WSx / Pxx
Branch and exact head:
Files changed (and confirmation no files outside scope changed):
What was run (commands, commit, image digest, environment):
Results (pass/fail counts, links to raw output):
What was NOT run and why:
Live resources created or changed (and cleanup state):
Open risks and follow-ups:
Reviewer requested:
```

## 9. Tracker

Status values: PENDING, IN PROGRESS, BLOCKED (with reason), IN REVIEW, DONE (with evidence link).

| ID | Item | Status | Owner | PR / evidence |
|---|---|---|---|---|
| WS0 | Spec approved; decisions recorded | DONE (approved 2026-11-19) | Coordinator | #59 |
| D1 | Key service | DECIDED 2026-11-19: AWS KMS as designed. BLOCKED: owner creates the AWS account and admin profile | Owner | |
| D2 | Image vulnerability policy | DECIDED 2026-11-19: fix fixable; time-boxed (30-day) exceptions for unfixable; libxml2 CRITICAL needs explicit owner sign-off in the exceptions PR | Owner | |
| D3 | Composio staging project | BLOCKED: owner input | Owner | |
| D4 | Signing key and staging spend | DECIDED 2026-11-19: signing key in GitHub `tenant-image-release`; staging spend approved (~$119/month + ~$27/month per running test tenant) | Owner | |
| D5 | Existing users policy | BLOCKED: owner decision | Owner | |
| D6 | Fly staging org and limits | BLOCKED: owner decision | Owner | |
| D7 | Alert destination | BLOCKED: owner input | Owner | |
| D8 | Test identities | BLOCKED: owner input | Owner | |
| D9 | Production domains | PENDING | Owner | |
| D10 | Scaling policy | PENDING | Owner | |
| WS1 | Images secure, signed, published | IN PROGRESS | Image owner | run 43862578772 |
| WS2 | Cloud foundations | BLOCKED: D1, D6 | Isolation owner | |
| WS3 | Platform roles in staging | BLOCKED: WS1, WS2, D3 | Isolation owner | |
| WS4 | Containment and two-tenant tests | BLOCKED: WS1, WS3 | Isolation owner, reviewer | |
| WS5 | Feature parity P01–P17 | BLOCKED: WS3, WS4 | Feature owners | |
| WS6 | Sign-up and routing | BLOCKED: WS3 | Isolation and messaging owners | |
| WS7 | Backup, restore, deletion drills | BLOCKED: WS2–WS4 | Isolation owner, reviewer | |
| WS8 | Monitoring and alerting | BLOCKED: WS3, D7 | Isolation owner | |
| WS9 | Existing users | BLOCKED: D5; #56 in review | Isolation owner | #56 |
| WS10 | Capacity ramp | BLOCKED: WS5, D6, D10; #55 in review | Isolation owner | #55 |
| WS11 | Independent security assessment | PENDING | Independent reviewer | |
| WS12 | Production launch | PENDING | Coordinator | |

## 10. Risks

- **Unfixable image findings** may never clear upstream; without a D2 exception policy the platform cannot ship.
- **Fly semantics** (private network attestation, volume encryption, stop/start races) are assumed by the code and unproven; a mismatch is a design issue, not a flag to bypass.
- **Cost** scales with active tenants (about $27,000/month at 1,000 always-active); idle suspension and the D10 policy decide the real figure.
- **Single platform machine** until owner-aware routing between replicas is built; this caps platform throughput during WS10.
- **Two environments drifting:** the shared server keeps receiving features. Every feature PR from now on must state whether it works in tenant mode, or add a P-row follow-up.
- **Migration risk:** a lost or partial freeze can create two writers; WS9 must not start without D5 and a passing dry run.
