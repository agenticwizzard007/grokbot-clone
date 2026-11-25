# Hosted Codex tool host failure, readiness round 5

The underlying error reproduced with Codex 0.167.1 is `code-mode host is disabled`. The CLI also emits this structured error item before inference:

```
Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.
```

The bridge disabled both `features.code_mode` and `features.code_mode_host`. Codex model metadata can select `tool_mode: code_mode_only` despite the former flag. Such a model sees `functions.exec` and `functions.wait` for tool orchestration, but every attempted cell fails because the latter flag disabled its host. The model can paraphrase that result as a disabled tool execution host and complete normally. No Swarm MCP callback or approval card is created.

The #207 real-binary fixture forced `gpt-5.4`, which uses direct MCP calls and misses this failure. Our new fixture leaves the model unset, as `hosted.ts` and the deployed bridge do for `codex/default`. The installed CLI selects `gpt-6.1-sol` locally, whose bundled metadata requires code mode. Other bundled models, including `gpt-6-astra`, also require it. We have no live account logs or authenticated model metadata, so the precise live model is unverified. The reproduced error and bridge configuration give high confidence in this root cause.

Upstream evidence at the installed version:

- [DisabledCodeModeSessionProvider](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/code-mode/src/remote_session.rs) returns the exact error.
- [Model selector regression tests](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/core/tests/suite/model_runtime_selectors.rs) establish that model metadata overrides the feature flag and that a disabled host fails closed.
- [Bundled model metadata](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/models-manager/models.json) selects code mode for current models.

## Change and boundaries

The bridge explicitly enables `features.code_mode_host=true`. The binary distribution already includes `codex-code-mode-host`. This is a V8 tool-orchestration runtime with no Node, filesystem or network API. It delegates registered MCP tools to Swarm. The exact manifest, bearer capability, account scope, schema checks, persisted approval, denial and replay handling remain in force. The shell feature remains disabled, and the sandbox remains read-only with the never approval policy. No Fly environment, kernel, billing or machine changes are needed.

The real default-model capability test verifies that process, require, fetch and Deno are unavailable, shell and agent-spawning tools are absent, and a native apply_patch request cannot write a fixture file under the read-only policy. This also runs with Landlock unavailable. Native apply_patch remains registered by Codex model metadata; its writes are refused, not silently allowed.

The negative control restores only `features.code_mode_host=false`, scripts an MCP search through `functions.exec`, and receives the exact error through the real binary. Production now classifies the CLI error item itself and gives a deterministic next step in Models & access, rather than relying on the model's explanation. #207 structured logs are retained.

## Other candidates

| Candidate | Evidence |
| --- | --- |
| MCP approve in non-interactive exec | Works with both direct and code-mode tools. The old auto/never negative control still fails with its original exact rejection. No CLI elicitation host is needed. |
| Linux Landlock | A test-only seccomp filter makes all three Landlock syscalls return ENOSYS and verifies that condition before exec. Hosted default-model Gmail search, approval and denial still succeed. This is not a complete Fly kernel reproduction, but rules out missing Landlock for this path. |
| Hosted profile, environment, cwd | Generation enters the real hosted.ts account job, profile directories, environment allowlist and file credential options, then the deployed bridge's temporary cwd, ephemeral mode and ignored user configuration. Only subscription status and the local model endpoint are substituted. Tests run as production standalone with development login disabled. |
| MCP auth, port or proxy | The real per-generation loopback MCP server works through the hosted environment. Its port is dynamically allocated, independent of Fly's HTTP PORT. Existing invalid-token coverage rejects before inference. |
| Standalone Composio | The real standalone adapter reaches a fake provider with the same account and connection identity after approval. No tenant runner is involved. `runner-client.ts` is not on this app-tool path. |
| Other kill switches | No production-only connected-app kill switch reproduced. Server CLI login disablement retains its gate and now gives a next step. |

## Account diagnostic and tests

Settings > Models & access > Account and login details shows Last CLI run, provider and runtime, tools offered, last tool, result and a classified error code. One durable SQLite row belongs to each account and cascades on account deletion. Reads require the signed-in account, enforce the existing browser account-intent check and are not cacheable. Concurrent older runs cannot overwrite a newer run. Stored fields never contain prompts, tool arguments, provider bodies, credentials or raw errors.

`tests/cli-real-app-approvals.test.mts` covers the default model's direct wrapper, search, voice, allow, denial, persisted card, main-chat SSE, pending result and account diagnostic, plus the exact negative control and missing-Landlock cases. `tests/cli-account-diagnostics.test.mts` covers authentication, isolation, persistence, classification, concurrency and deletion. The existing direct-model and Claude regressions remain. The fixture also handles Responses Lite tool declarations and custom-tool outputs, and separates auxiliary model requests from native-tool generations so a late synopsis cannot consume a scripted Gmail action.

`SWARM_TEST_REAL_CLI=1 node tests/cli-app-approvals-ui.mjs` checks the card and diagnostic with real binaries at 1280 and 390 pixels, light and dark, with screenshots under `.context/cli-apps-ui`. All accounts, messages, provider outputs and Gmail operations in these tests are local fixtures. No live sign-in or user data is used.
