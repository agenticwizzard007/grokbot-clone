# Live provider qualification

`scripts/qualify-providers.mjs` exercises a dedicated staging **platform**, through the public authenticated app APIs. It does not provision infrastructure, import operator credentials, bypass tenant authorization, enable API fallback, or infer success from a model's claim. The harness can be prepared without credentials. Real qualification requires the accounts and witnesses below.

The script's self-tests are simulations. They test the harness, not Claude, ChatGPT, Composio, OAuth, MCP, tenant containment or a 1,000-user fleet. Reports always retain `releaseQualified: false`. A passed phase proves only its listed HTTP observations; missing evidence is `incomplete` with a nonzero exit code.

## Inputs the owner must supply

| Input | Required scope |
| --- | --- |
| Staging inventory | An approved dedicated HTTPS platform origin, Fly app ID and deployed image digest, two already provisioned isolated tenants, and a qualified runner host. `/api/health` must report `role: platform`; the image digest in the report is operator-supplied, not remote image attestation. Never point this script at production. |
| Two Swarm identities | Non-administrator A and B, an already activated disposable Bot for each, and real recent sign-in sessions. Each user also needs a separate same-owner observer session for OAuth/session revocation checks. The observer must be a different token. No dev-login or database-inserted sessions. |
| Four subscription identities | Two distinct ChatGPT accounts eligible for Codex and two distinct Claude accounts eligible for Claude Code, one of each per Swarm user. Owners complete hosted login themselves. Record CLI versions, plan names, enabled extra usage, and provider confirmation that the intended hosted use is supported. Do not share one subscription between the tenancy test identities. |
| Composio project and OAuth apps | A staging-only project/gateway and provider auth configurations with exact staging callback URLs. For **each** tested toolkit, provide three private provider accounts: A1 and A2 owned by Swarm A, B1 owned by Swarm B. Start with Notion and Gmail. Give them disjoint disposable pages/inboxes with unpredictable read markers. Obtain the actual tool slug/schema through discovery and review the exact read arguments. No sends, invites, external messages or destructive provider operations are part of this harness. |
| Read-only enforcement and budget | Restrict provider OAuth scopes/tool permissions upstream to the reviewed reads. Approve a time/turn budget and enforce any hard provider-request quota upstream. `maxTurns` bounds submitted Bot messages, **not** model requests, tokens, provider calls or cost: one turn can have multiple reasoning/tool iterations. The observed tool allowlist/count check runs after dispatch and cannot undo an unexpected action. Do not use unrestricted grants to test a strict read-only or monetary limit. |
| Composio selection/execution witness | An independent authenticated staging audit endpoint tied to actual gateway/provider observations, with a monotonic cursor and the contract below. Actual SEARCH output is required to qualify default selection. Public Bot rows omit tool results; EXECUTE success alone cannot establish that its account/revision came from SEARCH. Missing SEARCH witness stays incomplete. The exporter is an operator-supplied integration; this change does not add one to production. |
| MCP OAuth service | A dedicated public HTTPS OAuth-capable MCP server, separate grants/configs for A and B, one read-only probe tool, `requireApproval: true`, and a server-side probe audit. Use the actual discovered `toolName`, which contains the current revision. Supply supported OAuth scopes, PKCE/resource discovery, short-lived-token and refresh controls. No stdio mounts in this qualification. |
| Image fixture control | A preprovisioned test desktop for each Bot and a restricted HTTPS fixture controller which displays a new code on that exact desktop. Each vision test generates a fresh code which is never sent to the model in text. This prevents a later model from passing by copying an earlier answer. No personal desktop content. |
| Operator workstation | A terminal for hosted CLI sign-in, and a graphical browser for the OAuth phase. The optional `oauth-browser` phase uses the repository's locked Playwright package and an ephemeral browser context, with no trace/video/profile persistence. Set `CHROME_PATH` only if the installed browser is outside Playwright's default. |

Store each `swarm_session=...` value in its own owner-only regular file (`0600`), outside the repository. Supply only file paths in the configuration. Do not post cookies, provider credentials, OAuth links/codes, or audit tokens in chat. Evidence directories must be owner-only (`0700`); reports contain identifiers/hashes and quota snapshots, not messages or raw provider payloads. Login terminal output and the fallback OAuth link are displayed interactively and are not saved by the harness; do not pipe those phases to a shared log.

Start from [the configuration template](../examples/provider-qualification.example.json). All identifiers, approved inventory, paths, tool schema/arguments and witnesses must be replaced with reviewed staging values. The approval reference identifies the operator's concrete run authorization. `modelLoopRiskAcknowledged` confirms the budget limitation above; it does not create a spending cap.

## Run sequence

Dry configuration validation makes no network calls:

```sh
node scripts/qualify-providers.mjs --config /private/provider-tests.json --phase preflight
```

Add `--execute` only for the reviewed staging run. Each phase writes a private receipt. Budget consumption is persisted **before** a message is submitted; uncertain requests are never automatically retried. A lock prevents two harness processes from racing the same evidence/budget journal. It is unrelated to the app's concurrent agent execution. After a crash, reconcile the pending turn/provider state before removing the lock. Do not reset the budget journal to bypass its approved turn allowance.

1. `--phase preflight --execute`: check platform role, immutable identities, non-admin scope, owned idle Bots, and foreign transcript denial. Disable background work and unrelated users on these test accounts. The test Bots must be disposable; the harness changes their model/effort temporarily and restores those fields afterwards.
2. For A and B, run `--phase login --user a --provider codex --execute`, then `--provider claude`. Repeat for B. The terminal invokes the app's hosted login, sends input to that owner/session only, tests that B cannot read/write/resize/cancel A's terminal, and verifies hosted subscription status afterwards. Fresh Swarm authentication is required for protected credential mutations; ordinary activity does not extend the recent-auth window.
3. For each user/provider, run `--phase catalog`. It requires nonempty Plan models, actual supported efforts and a fresh provider-reported quota snapshot. Unsupported/unavailable quota is **incomplete**, never zero or fabricated availability. Compare the recorded check/reset times with the provider account UI and retain that independent operator receipt.
4. For each user/provider, run `--phase models`. It selects every current catalog model and every advertised effort; checks an actual `remember` call and its saved memory; checks new subscription usage and model attribution; deletes only that test memory; and, for image-capable models, checks a new screenshot challenge followed by plain text after image history. No preset model list is substituted. A text-only model later in the matrix also receives existing image history through the app's normal adaptation. Selected Bot settings are restored; the subscription selection remains in place. Keep sufficient approved allowance for the discovered matrix.
5. For every private Composio/MCP grant, run `--phase oauth-browser --user a --provider composio --index 0` (or `--provider mcp`). Complete only the designated test identity in the temporary browser. Before the valid callback, the harness tries the other user and a different session of the same user, requires both refused, then requires the initiating session to succeed and a replay to fail. It stores no callback URL/code. `oauth-start` is a terminal-only alternative that prints the authorization link; its receipt remains incomplete because callback behavior is not automatically observed. Update configured connection IDs/tool names from the actual inventories after authorization; do not infer them from emails or aliases.
6. Run `--phase connections --user a --provider codex`, then B, and repeat with Claude. Each toolkit must already have a reviewed default (the API cannot restore a no-default state). The phase exercises implicit default SEARCH and explicit selection for A1/A2/B1, validates independent selection/execution witnesses, foreign management rejection plus unchanged owner state/working owner reads, and restores the previous defaults. Current public Composio routes can translate a foreign gateway refusal into HTTP 500; that status is recorded and is **not** sufficient denial evidence by itself.
7. Run `--phase mcp` for both users/providers. It checks foreign list/test/edit/delete/OAuth denial, actual initialization/discovery, an exact read probe, one-time approval and an independent server call count. A 200 from `/test` alone is not success: its `server.error` must be empty and the expected tool present.
8. Deliberately destructive-to-test-fixture stages come last: `revoke-mcp` disables the test server while its exact call awaits approval, then verifies the stale approval cannot dispatch using the provider-side zero-call witness. It leaves the server disabled and may require fresh OAuth after revision changes. `revoke-connection --index 0` disconnects that specific disposable connection, tries its old revision, requires no new provider call and checks that sibling connections still work. It does not delete all connections for a toolkit.
9. `revoke-cli --provider codex` deletes that user's hosted profile through the app and requires the Plan selection to remain blocked, with no assistant response or additional recorded inference/charges. Reauthenticate before testing another provider. `revoke-session` uses the separate observer session to revoke only the sacrificial Swarm session and requires its protected APIs to reject it.

All commands above require `--config`, the chosen `--user`/`--provider` where applicable and `--execute`. Authorizations may expire during manual sign-in; start a fresh approved attempt rather than replaying an expired one. Do not use `always` approvals. A failed, timed-out or interrupted tool can already have taken effect; reconcile its audit before retrying.

## Witness contracts

These endpoints are controlled staging evidence services, not new production app APIs. They must authenticate read/fixture-control tokens independently; Swarm cookies are never sent to them. Use HTTPS without redirects, URL credentials, query secrets or a shared production endpoint. Their tokens remain on the operator host.

**Composio/gateway witness** (`connection.audit.url`): GET returns bounded JSON, at most 64 KiB. `identity` must match the reviewed staging witness. `cursor` is monotonic. New records must include the actual provider operation, not a model's transcript. SHA-256 hashes use UTF-8; arguments use JSON with recursively sorted object keys. A default-selection test requires one SEARCH record followed by one successful EXECUTE with the same selected connection/revision. An explicit read requires a fresh successful execution. Delayed, duplicate, mismatched or missing records do not pass.

```json
{
  "identity": "staging-account-a-witness",
  "cursor": 102,
  "records": [
    { "kind": "search", "sequence": 101, "toolkit": "notion", "explicitConnection": false, "connectionHash": "SHA256_OF_CONNECTION_ID", "revision": 4 },
    { "kind": "execute", "sequence": 102, "status": "success", "connectionHash": "SHA256_OF_CONNECTION_ID", "toolSlug": "ACTUAL_DISCOVERED_READ_SLUG", "argumentsHash": "SHA256_OF_CANONICAL_ARGUMENTS" }
  ]
}
```

**MCP witness** (`mcp.audit.url`): GET adds `?probe=<fresh UUID>`. Return at most 8 KiB: `{ "identity":"staging-mcp-a", "probe":"...", "acceptedCalls":1 }`. The count comes from actual tool dispatch on the server, scoped to the authenticated fixture grant. Positive execution must advance from zero to exactly one; the revoked pending call must remain zero. The read tool must accept the configured `nonceArgument` and include it in the independent audit.

**Desktop fixture controller** (`imageFixture.url`): POST receives `{ "probe":"...", "marker":"VISION-..." }` and must display the marker on the designated Bot desktop before responding. Return at most 8 KiB: `{ "identity":"desktop-a", "probe":"...", "prepared":true, "markerHash":"SHA256_OF_MARKER" }`. It must be narrowly authorized to this fixture, not an arbitrary shell or machine-control endpoint.

## Gates that remain separate

Deleting/disabling an app connection proves local dispatch revocation only when the independent witness confirms it. It is not proof that the provider invalidated every bearer/refresh token. Complete provider-issuer revocation, access-token expiry/refresh, logout-during-authorization, and cancellation of already-dispatched operations with the provider's own controls/audit. MCP removal currently makes no issuer revocation request. Preserve provider receipts for those cases rather than converting an app HTTP 200 into a broader pass.

The controlled witness exporters and desktop fixture controller are prerequisites; this harness does not deploy them or invent events when unavailable. Provider request/monetary limits must be enforced upstream if strict limits are required. Containment, image provenance, hosted-provider permission, storage/PITR, recovery/deletion/migration, native/phone messaging and the 1,000-user ramp/1,250 burst/24-hour soak remain separate release gates.

Run the network-disabled harness regression suite with `node --test tests/provider-qualification.test.mjs`. Those tests cover request safety, real response shapes, false-pass regressions, evidence requirements, callback session ordering and model-matrix orchestration. They must never be cited as real-provider qualification.
