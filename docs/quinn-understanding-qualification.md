# Quinn understanding qualification

`qualify-quinn-understanding.mjs` tests whether a live subscription model can interpret four frozen, synthetic team snapshots. It submits one structured, tool-free inference per scenario. It never posts a chat message, starts a coworker, activates setup, sends an external message, changes the selected provider, or registers business tools.

The scope is reasoning over supplied evidence. A pass does not establish live team retrieval, completeness of a production projection, connected-app access, provider capacity, or release readiness. Provider and infrastructure qualification remain covered by [provider qualification](provider-qualification.md). Every report retains `releaseQualified: false`.

## Frozen cases and grading

The versioned suite is in `scripts/quinn-understanding-cases.mjs`:

| Case | Required understanding |
| --- | --- |
| Coverage and unknowns | A two-coworker page with a total of three is incomplete. Completed execution does not prove acceptance, and a stored artifact does not prove delivery. |
| Specialist sources | A genuine specialist-chat correction overrides the earlier count. A coworker summary cannot invent spending authority or a daily schedule. |
| Decisions and revisions | Human approval for revision 7 cannot activate revision 8. Pending tool approval remains pending; a routine cannot resolve it. |
| Stale state | A newer canonical result overrides an old projection. Uncertain external effects need reconciliation, and an old watermark cannot establish current coverage. |

Each answer must choose a provided classification and cite the minimal exact source IDs. The deterministic grader checks every answer, exact citations, missing/extra fields, and invalid JSON. It rejects ungraded narrative claims. The model receives records, questions and output schema; it never receives the answer key. Inspectable receipts retain the full synthetic prompt, response, hashes, expected/actual answers, and per-check results.

## Credential-free checks

Run the deterministic grader and harness tests:

```sh
node --test tests/quinn-understanding.test.mjs
```

Run the known-answer fixture without network access or model calls:

```sh
node scripts/qualify-quinn-understanding.mjs --dry-run \
  --evidence-dir /private/quinn-understanding/fixture-run
```

This produces `scope: "simulated-harness-self-test"`, `status: "simulated_pass"`, zero model invocations, and **`liveModelQualified: false`**. Passing a dry run is not live-model qualification.

An explicit live attempt without staging configuration produces a private `unavailable` receipt and exit code 2, without network or model calls:

```sh
node scripts/qualify-quinn-understanding.mjs --execute \
  --evidence-dir /private/quinn-understanding/unavailable-check
```

## Live staging configuration

Run live mode inside the already configured dedicated **staging tenant** environment. It uses that tenant's existing manifest, volume identity, selected subscription, isolated runner and authenticated profile. It does not copy credentials or start sign-in. The environment must already have `SWARM_ROLE=tenant`, `SWARM_TENANT_ID` equal to the configured user, `DB_PATH` equal to the configured database, and the normal tenant manifest/key/runner environment. Do not point it at production or another user's volume.

Supply one approved disposable staging account, its idle active primary Bot, an existing hosted Codex or Claude subscription, and an explicit catalog model. API mode, an unselected/disconnected subscription, a model from another provider, and the out-of-process desktop bridge runtime produce an unavailable gate; the harness never switches routes or falls back to a paid API. The signed-in session must already belong to this staging account. Store only `swarm_session=...` in an owner-only regular file (`0600`) outside the repository. Do not paste tokens into configuration or logs.

Use this configuration shape, replacing all inventory, identifiers and paths:

```json
{
  "version": 1,
  "target": {
    "kind": "dedicated-staging",
    "origin": "https://reviewed-staging.example",
    "approvedOrigin": "https://reviewed-staging.example",
    "appId": "reviewed-staging-app",
    "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "dbPath": "/data/app.db"
  },
  "account": {
    "userId": "usr_replace_with_staging_owner",
    "botId": "bot_replace_with_staging_quinn",
    "sessionFile": "/private/staging/session",
    "provider": "codex",
    "runtime": "server",
    "model": "codex/replace-with-current-catalog-model",
    "effort": "medium"
  },
  "approval": {
    "reference": "reviewed-staging-run-reference",
    "disposableAccount": true
  },
  "allowApiFallback": false,
  "budget": {
    "maxInvocations": 4,
    "maxMinutes": 8,
    "requestTimeoutSeconds": 90,
    "maxOutputTokens": 2000
  },
  "evidenceDir": "/private/quinn-understanding/live-run"
}
```

For Claude, both `provider` and the model prefix must be `claude`. Effort must be offered by the selected account/model; unsupported settings remain unavailable. The image digest is operator-supplied inventory, **not remote image attestation**.

Validate configuration without importing the live adapter, reading credentials, making network requests, or calling a model:

```sh
node scripts/qualify-quinn-understanding.mjs --config /private/quinn-staging.json
```

Execute only the configured staging run:

```sh
node --import tsx scripts/qualify-quinn-understanding.mjs \
  --config /private/quinn-staging.json --execute
```

Use the staging tenant's existing environment or an operator-owned `--env-file` when launching the process. The harness checks the remote session, primary identity, idle state and selected subscription through authenticated GETs, then validates the local tenant/account/route. It invokes `cliResponsesClient` directly with structured output, an empty tool list and no native MCP handler. The existing CLI runner disables native shell/app/search/plugin/hook tools. The general API client and chat execution loop are never invoked.

## Evidence, bounds and interpretation

The evidence directory must be owner-only (`0700`); receipts and journals are `0600`. Output prints only status, gate code, invocation count and receipt path. Raw provider errors, cookies and session-file paths are omitted. Full prompts/responses contain synthetic scenario data; keep receipts private nonetheless.

A durable budget reservation and submitted receipt precede each invocation. A directory lock prevents concurrent runs against the same journal. There are at most four submitted inferences, each with an abort deadline, and an overall admission deadline. Failed or uncertain calls are never automatically retried. An interrupted call remains consumed; reconcile it before removing a leftover lock. A changed configuration/suite cannot reuse its budget journal. Do not reset the journal to bypass the approved invocation allowance.

`maxOutputTokens` is a request hint; the current subscription adapter does not guarantee a hard native CLI token/spending cap. Request count and timeout are bounded; provider-internal reasoning/requests may differ from these counts. Observed usage is stored when available; missing usage stays `unavailable`, never measured zero.

Reports distinguish requested provider/model from observed subscription billing/provider/model. The route is checked before and after each inference. Missing, changed, or API-billed receipts cannot qualify. `liveModelQualified: true` requires all four live scenario grades and subscription receipts to pass. The report still has `releaseQualified: false` and applies only to this suite/configuration/run. Exit codes are 0 for configuration validation, fixture success or live success; 1 for failed grades/invocations; 2 for unavailable prerequisites. The report's scope and flags distinguish those outcomes.
