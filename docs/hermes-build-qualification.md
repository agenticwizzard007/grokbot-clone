# Native Hermes and Quinn qualification

Qualified on 2026-11-12 from a clean detached checkout of runtime/test revision `3646f0cb7c3e067e79b3d197ac08f1b703553f93`. Only dependency symlinks were untracked. The checkout excluded the concurrent CLI deadline and optional goal-budget work. Subsequent documentation-only changes do not change this tested code.

## Reproducible results

| Command | Result |
| --- | --- |
| `npm run test:hermes-native` | 231 tests passed, zero failures/skips; server and web typechecks, production build, original native UI journey and full Hermes browser journey passed. |
| `npm run test:cli` | 235 tests passed, zero failures/skips; full HTTP/CLI integration smoke passed. |
| `TEST_DATABASE_URL=postgresql://…/disposable npm run test:isolation` | 664 tests passed against disposable PostgreSQL, zero failures/skips. |

The native command includes 82 learning-domain tests: 51 lifecycle/HTTP/adapter cases, 27 retained knowledge cases and four coverage regressions. Eighteen lifecycle cases execute the legacy memory correction and forgetting tools under durable user, internal, routine, system, resume and connection-card ancestry. They verify unattended changes remain pending and preserve the active fact.

Both browser journeys use actual application servers, authenticated APIs, database state and artifact storage. Model replies and messaging transports are deterministic fixtures. The full journey verifies:

- Quinn's two permanent specialists execute dependent research and writing tasks, return validated results, and produce downloadable artifacts.
- Automatic reviews perform four actual management iterations on both the default direct-activation path and the optional approval path. They read the existing skill, propose or activate its revision, stage destructive memory replacement, and finish.
- Unattended memory correction retains the active fact. Approval-gated skill changes remain inactive until owner approval; a fresh foreground task records the exact approved revision in both knowledge and native context receipts.
- Source inspection, package resources, private/project/account sharing, revocation, pins, locks, archive and complete package rollback work through the product UI.
- Reload after a lost delivery response reuses the exact request and idempotency key, producing one attempt. Unknown-outcome reconciliation sends nothing.
- Background review usage is separate, internal exchanges stay out of user narration, account isolation holds, and desktop/mobile layouts work.

Additional maintained regressions cover transactional completion/outbox recovery, concurrent decision callbacks, migration holds, late context changes during asynchronous tool validation, bounded program execution and poison delivery backlogs. The delivery fixture includes 125 oldest storage-claim failures and 205 healthy items; healthy work drains once without retrying terminal failed or unknown sends. Claude and Codex reviewer tests exercise the real subscription adapter and restricted Swarm management dispatch, without a native business-tool manifest or paid fallback.

## Evidence and limits

Workspace evidence is retained under `.context/hermes-build/`: `final-qualified-native.log`, `final-qualified-subscription.log`, `final-qualified-isolation.log`, and `final-qualified-shots/result.json` with desktop/mobile screenshots. The browser result records both completed four-iteration reviews and their selected/originating route, revision and usage metadata. The route and token totals come from fixtures and are not live-provider measurements.

This is implementation qualification for a draft PR. It does not establish live-model task quality, real-provider usage accuracy, real external delivery, Apple-device behavior or production readiness. Authorized staging must still measure task acceptance, repeated corrections, sourced retrieval, coordination failures, latency and total foreground/review cost. See [rollout and recovery](hermes-build-recovery.md) for the required pre-start cohort controls and [the source map](hermes-learning-source-map.md) for the pinned Hermes process adaptations and native differences.

No merge to `main`, production deployment, customer enablement or live sends were performed as part of this qualification.
