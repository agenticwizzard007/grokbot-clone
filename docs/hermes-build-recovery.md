# Native Hermes rollout, recovery and qualification

This build remains a draft integration. It does not merge `main`, provision production resources, migrate live customer databases or enable production accounts. The native application uses the existing isolated customer database and file volume; standalone development also enforces account ownership on every domain API.

## Additive storage and rollout

Startup adds owner-scoped learning settings/state/reviews/source receipts, memory-change proposals, skill package/version fields and sharing grants; coordination requests, result outcomes, board/report coverage and supervision; native change events, independent consumer cursors, context receipts and job-completion outbox; delivery command receipts, account signing keys, reconciliation attestations and pending-queue backoff fields. Existing memories, skills, proposals, jobs and schedules remain canonical. Existing pending skill proposals remain pending when the default skill-approval setting is off. Migration code uses the existing owner-discovery and write-fence machinery; no extra database service or scheduler is introduced.

Before enabling an account in staging, back up its database and immutable artifact volume together using the existing backup/export flow, record its current application revision, and verify restore against a disposable destination. Keep schema additions when rolling application code back. Do not delete the new ledgers or replay uncertain external work to make an old UI appear complete.

For progressive rollout, use authenticated `PATCH /api/learning/settings` with the current `expectedRevision` and `settings.enabled` / `settings.automaticReview`. Account settings and Bot overrides are independent. Set `skillApproval` to opt into pending skill review. Disable new Quinn supervision with `PATCH /api/team/settings {"enabled":false}`. Settings guards stop obsolete review publication, preserve history and retain settled revisions. The default settings are documented in [the source map](hermes-learning-source-map.md); production cohort selection remains an explicit release operation.

## Recovery invariants

- Job settlement, its completion snapshot and change intent commit together. Learning and coordination independently acknowledge the outbox. Replaying a callback does not rerun the business job or duplicate a review/result. Stale foreground epochs and changed source snapshots consume obsolete learning callbacks without publishing them.
- Running business jobs lost at restart remain uncertain. Queued jobs survive. Waiting user decisions remain bound to the original assignment; identical question/approval callbacks cannot enqueue a second action. Internal activity does not expire decisions or appear as human messages, voice narration, outward messages or unread badges.
- Queued reviews resume when ownership, settings and foreground conditions permit. Reviews that were running are cancelled after restart; already committed knowledge revisions remain available. No uncertain mutation is blindly repeated. A new foreground turn cancels only the matching background review.
- Skill versions include instructions, references, templates and scripts. Rollback is an owner action against a current revision. Scripts remain stored resources and gain no execution permissions. Unattended destructive memory changes remain pending; approval revalidates the current revision and original source hashes.
- Sharing and revocation affect subsequent model context. Long subscription generations stop before their next action if their loaded knowledge or instructions changed; the next model request reloads current authorized database context. The dispatcher rechecks after asynchronous validation/permission lookup as well.
- Deliveries keep immutable artifact bytes and a pinned destination. The UI retains the exact body and `Idempotency-Key` across a lost response and reload. Same-key replay resolves the original accepted command before checking current connection metadata. A changed command under the same key is rejected.
- A provider acknowledgement is not proof of recipient reading. Unknown outcomes are never automatically retried. Owner reconciliation appends evidence and leaves the original attempt unknown. `not_sent` enables a separate explicit retry; reconciliation itself never sends. Per-account signing keys preserve pending destination proofs across host restart.
- Continuous delivery draining skips migration-held accounts and backs off pre-claim/storage failures so an old failing batch cannot starve newer work. Failed and unknown external sends remain outside automatic dispatch. Restoring an older backup still requires the existing uncertain-effect reconciliation procedure.

All new authoritative tables have discoverable account/Bot/job ownership. The existing reviewed FTS definitions and migration-hold protections remain intact. Held owners are excluded before background batch limits, and writes are rechecked after asynchronous work.

## Reproduce qualification

Use disposable storage and test credentials only:

```sh
npm run test:hermes-native
npm run test:cli
TEST_DATABASE_URL=postgresql://.../disposable npm run test:isolation
```

The native suite includes the original knowledge/tool/program/workflow/delivery/runtime regressions plus learning lifecycle, complete source coverage, coordination races, transactional events/outbox recovery, database context refresh, aggregate program limits and HTTP delivery recovery. It builds the server/web and runs both native and full Hermes browser journeys. Subscription tests include both Claude and Codex through the actual adapter and an authenticated local fake CLI, with paid fallback sentinels. Browser tests use the real server, authenticated API, database and files with deterministic model/transport fixtures.

The integrated browser journey measures two dependent permanent-worker tasks with validated results and actual artifacts; direct versus staged skill changes; staged memory correction with the prior fact retained; a fresh task's exact knowledge revision receipts; provider/background usage separation; one delivery attempt after response loss; zero sends during reconciliation; and cross-account denial. These are reproducible correctness measurements, not claims of improved live-model task quality.

For staged product-benefit measurement, compare fixed representative tasks before/after activation using durable source/job/review/knowledge IDs. Report task acceptance, repeated corrections per accepted task, sourced retrieval correctness, failed/deferred coordination requests, foreground and review latency, and all observed model costs including `background_review`. Preserve unavailable/partial usage rather than substituting zero. Measure acceptance with persisted artifacts and task criteria, not assistant completion text. Do not turn this measurement into a per-update activation gate.

Live model quality, real provider usage/cost precision, actual iMessage/SMS/WhatsApp receipt and Apple-device behavior require an authorized staging environment. No live sends, paid-provider qualification or production deployment are claimed by the fixture suites.
