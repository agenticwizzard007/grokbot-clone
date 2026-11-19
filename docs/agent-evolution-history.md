# Agent learning and change history

Open an agent's **Configuration → History** to inspect saved changes to its role, memories and skills. Agents without a saved setup show history below their current instructions. Each entry has a per-agent change number, the source resource revision when available, timestamps, recorded actor/reason, before/after fields, and retained source evidence. Matching learning reviews also identify the selected provider/model.

## Where learning lives

The native Hermes adaptation stores learned memories and versioned skill packages in the account's database. The runtime loads authorized current knowledge into model context. The saved setup generates `AGENTS.md`, `SOUL.md`, and the other configuration downloads; learning does not automatically rewrite those files. Switching a supported model retains the stored knowledge, but this history feature does not add a complete portable learned-agent export/import package or create `BRAIN.md`/`MEMORY.md` exports. See the [learning source map](hermes-learning-source-map.md) for the review, evidence and publication rules.

## What is recorded

- Skill revisions and package resources, including edits, archive/rollback, and lifecycle transitions.
- Memory creation, correction, scope changes and forgetting, with retained evidence.
- Skill and memory proposals and their resolutions, promotion policy revisions, evaluations and regression checks.
- Agent name, description, instructions and model changes; saved setup brief/status/revision changes.
- Learning-setting changes, including account defaults recorded for each owned agent. A setting entry describes stored defaults or overrides, not a merged effective configuration snapshot.

**Change N is an audit event number, not a full restorable agent version.** Proposals, evaluations and approvals remain distinct from the resulting active skill/memory revisions. Existing skill rollback controls create new history entries; this view does not roll back an entire agent. The log records persisted changes and available provenance, not hidden reasoning or proof that output quality improved.

## Durability and older accounts

SQLite triggers append `agent_evolution` entries in the same transaction as the source write. Failed audit storage rolls back the associated mutation. Existing entries cannot be updated, replaced or individually deleted while their owning account and agent exist. Account/agent deletion can remove the history through normal cascades. History retains past memory content even after the active memory is forgotten; forgetting is not history erasure.

Startup imports retained domain evidence with stable source keys in bounded batches. These entries are labelled **From retained history**. Current configuration and memories lacking earlier events get an explicit **Starting snapshot**, without inventing prior edits. Missing original actors/reasons stay unrecorded. Older setting changes and lifecycle transitions without a retained ledger cannot be reconstructed. Restart is idempotent, and migration-held owners are excluded from backfill. The authenticated read APIs never write history.

## API and pagination

- `GET /api/learning/bots/:botId/history?limit=30` returns summaries, coverage, `through`, `latestVersion`, and `nextBefore`.
- Keep the returned `through` fixed and send `before=nextBefore` to fetch older pages without including concurrently arriving changes. Pages contain up to 100 summaries; details are fetched separately.
- `GET /api/learning/bots/:botId/history/:version` returns immutable snapshots, changed fields, source evidence, and matching review metadata.

Both routes require the account that owns the agent and send `Cache-Control: no-store`. The UI signals when new changes exist and provides an explicit refresh, preserving stable older-page navigation.

## Verification

```sh
node --import tsx --test tests/agent-evolution.test.mts
node tests/agent-history-ui.mjs
npm run test:hermes-native
```

The focused tests cover transaction failure, revision fidelity, proposals versus applied changes, pagination, ownership, immutability/account deletion, retained-history import, restart and migration holds. The browser journey uses a real local server and disposable database for before/after details, proposals, paging, changes arriving from another process, refresh and phone layout. No live account mutation or model call is needed.
