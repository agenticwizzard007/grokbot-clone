# Plan connection implementation

The composer picker offers Claude and ChatGPT plan entry points even when API billing is active. Each entry opens Models & access on the selected provider. Settings also links to API keys, and API keys offers the same plan entry points. Connection state comes from the account-bound official CLI status.

Connect runs the unmodified official Claude Code or Codex CLI. Codex uses `codex login --device-auth` and `codex exec`. Authentication remains in the CLI's profile. Swarm does not read or export OAuth token files, collect passwords or cookies, run `setup-token`, or implement custom Sign in with ChatGPT.

Disconnect selects API billing without deleting CLI credentials or revoking the computer bridge. Existing explicit reset and bridge-revocation actions remain separate. The pairing command stays only in the mounted Settings view's memory, is copied on an explicit action, and is never rendered with its secret.

## Codex catalog limitation

The previous adapter used authenticated `codex app-server` account, model-list and rate-limit calls. OpenAI's official [app-server authentication documentation](https://learn.chatgpt.com/docs/app-server#auth-endpoints) states:

> App-server authentication has never been permitted for commercial or hosted services.

This change removes that adapter path and its forced-login configuration. Codex catalog requests instead verify official CLI login status and expose only the `codex/default` execution alias. This is not a discovered model. The CLI chooses the model and effort; the UI and agent platform state report the model list, plan name and quota as unavailable. No API catalog, invented plan tier or zero-usage estimate substitutes for missing metadata. Old named Codex selections must be changed to the CLI default before they can run.

The server never sends a Codex catalog request to older bridges or isolated runners. Codex generation requires the updated bridge capability, and isolated Codex login and generation first check the worker capability. Older bridge scripts and pinned tenant runner images require an update. Claude remains available on older bridges. Claude models continue to come from the official CLI catalog.

OpenAI separately documents [headless official CLI login](https://learn.chatgpt.com/docs/auth#login-on-headless-devices). The app-server restriction is specific to the removed authenticated integration; this document does not assert blanket permission for every commercial deployment. The implementation follows the requested official login/exec scope.

## Operational conditions

Anthropic's [legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance) conditions CLI hosting on acceptance of its Commercial Terms, an unmodified binary, availability of built-in authentication methods, and users authenticating and paying for their own usage. A private profile alone does not establish those operational conditions.

The runner strips ambient API keys and OAuth environment variables and checks subscription authentication immediately before generation. A user can independently change their local CLI login between that check and execution. Swarm does not inspect or copy credential files to make that external operation atomic. App-controlled hosted login changes continue to stop active jobs before changing authentication.

Tests use fake CLI executables and mocked browser endpoints. They verify dispatch, isolation, status, catalog limitations, cancellation, secret masking and disconnect behavior without real provider authentication or billable inference.

## Validation commands

- `npm ci && npm run typecheck`
- `npm run test:cli`
- `npm run test:plan-connections`
- Existing model/client/platform-state tests and model-selector, CLI effort, CLI login and usage browser regressions.

The original brief remains unchanged in `R3-PLAN-CONNECTIONS.md`. The Codex discovery limitation above reflects the later instruction to remove reliance on authenticated app-server APIs.
