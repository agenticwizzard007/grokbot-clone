# Plan connections for Claude Max and ChatGPT

You are the implementer for this item only. Do not take on the loader animation, effort picker names, suggested integrations, or the round 3 leftovers. Those are in other Conductor workspaces and will have their own PRs.

## Your job
1. Read this brief fully. Commit it unchanged as `docs/qa/R3-PLAN-CONNECTIONS.md` on your branch.
2. Implement the UI and wiring below, staying inside the providers' current terms (see Terms findings). If a path would violate those terms, do not ship it.
3. If this environment lets you spawn more agent sessions, spawn a reviewer or tester at model `gpt-6-astra` and effort `ultra` (agent `codex`). Do not silently pick a different model or effort. If those values are not offered, stop and report the exact mismatch.
4. Checks before the PR: `npm ci && npm run typecheck`, existing CLI tests (`tests/cli-login.test.mts`, `tests/cli-subscription.test.mts`, `tests/cli-catalog.test.mts` and related), plus new UI tests for the model-selection connect flow. Keep every existing test green.
5. One branch and ONE PR to `main` titled `QA R3: plan connections for Claude Max and ChatGPT`.
6. Merge only when CI is green, and only after the effort-picker PR (`QA R3: per-model effort picker names`) has merged, because both touch model selection. Rebase onto that updated `main` (or onto that PR branch if you must open first). Leftovers land after you.
7. Guardrails: never commit, log, or show secrets, OAuth tokens, setup tokens, or pairing command secrets in the UI or test output. No scraping. No reuse of OAuth tokens outside the official CLI. No force push. No em dashes or en dashes in PR text, docs or new UI copy. No person's name in code, docs or PR text.

## Repo and live app

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Commit tested | `main` @ `9f2481a2c805e86d1af93a43cf6703e18f5bfd19` |
| Live app | https://swarm-team.fly.dev |

## Sequencing
Merge order: (1) loader, (2) suggested integrations, (3) per-model effort picker, (4) this plan-connections PR, (5) leftovers last. Rebase onto `main` after the effort picker lands. Keep edits to Settings subscription code additive. Expect overlap with `web/src/components/ComposerModelMenu.tsx`, `web/src/components/ModelUsageDetails.tsx`, and `web/src/lib/models.ts`.

## What already exists
The server and Settings already know how to use official CLIs as a plan backend. The gap is that model selection still feels like an API-key only editor.

- Providers: `web/src/lib/models.ts:8` `openrouter | direct | codex-cli | claude-cli`.
- Settings section "Models & access" (`AppSettings.tsx:58,205`) renders `SubscriptionSettings`, which already has CLI vs API method state and hosts `CliLoginTerminal`.
- `CliLoginTerminal.tsx` opens an official-domain login URL allowlist (`openai.com`, `chatgpt.com`, `claude.ai`, `claude.com`, `anthropic.com`) and, when done, says the Claude or ChatGPT subscription is verified and selected for all Bots (`CliLoginTerminal.tsx:11-12, 273-274`).
- Server: `selectedCli` in `server/src/cli/store.ts:39` switches the catalog and request path to the CLI (`routes-models.ts:39-47`, `llm.ts` `providerFields` when a CLI is selected).
- Model menu usage label: `ComposerModelMenu.tsx:109` is `'Plan & usage'` when `billing === 'plan'`, otherwise `'API details'`. The usage panel's Manage button (`ModelUsageDetails.tsx:25,44`) goes to Settings `subscriptions` only when a plan is already active or the connection is unknown; if an API connection is known it goes to `keys`. So a user who already has API details does not get a plan-connect path from the picker.

## Terms findings (plain words, 23 Nov 2026)

### Anthropic / Claude Max (Claude Code CLI)
Official login: the user installs Claude Code and signs in with the same claude.ai account used for the Pro, Max, or Ultra plan. Commands documented by Anthropic include running `claude` (browser login on first launch), `claude auth login`, `/login` inside the CLI, and `claude setup-token` for a long-lived CI token stored as `CLAUDE_CODE_OAUTH_TOKEN`. Sources: https://code.claude.com/docs/en/authentication , https://code.claude.com/docs/en/cli-reference , https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan

What the terms allow and forbid (https://code.claude.com/docs/en/legal-and-compliance ):

- OAuth for Free, Pro, Max, Ultra, Team, and Enterprise is meant for Claude Code and other native Anthropic apps.
- Anthropic does not permit third-party developers to offer Claude.ai login inside their own apps, or to route requests through those plan credentials on behalf of users.
- Developers may not collect, store, or intermediate Claude.ai credentials or session tokens. Sign-in must complete through Anthropic's own flow.
- The allowed door: an end user may sign in to the unmodified Claude Code binary with their own subscription, including where a platform hosts Claude Code, if the binary is unmodified, auth methods are not stripped, and the usage is billed to that user (no resale or intermediation).

Sanctioned design for this app: drive the official `claude` CLI installed on the user's computer or the Bot's computer. The user finishes Claude's own login in the CLI or official browser page. The app routes model requests through that CLI as a provider backend. Do not scrape a session, do not paste a setup-token into Swarm's own storage if that means Swarm is intermediating the OAuth token, and do not implement a Swarm-hosted "Sign in with Claude.ai" that collects tokens. If the current `CliLoginTerminal` already wraps the official CLI login without taking tokens out of the CLI, keep that pattern and surface it from model selection. If any existing path stores `CLAUDE_CODE_OAUTH_TOKEN` or cookies in the app server, do not extend it; prefer the CLI keeping credentials in its own local state on the user's or Bot's computer.

### OpenAI / ChatGPT (Codex CLI)
Official login: install Codex CLI, run `codex` or `codex login`, choose "Sign in with ChatGPT", complete the official browser flow. API key sign-in is a separate path (`codex login --with-api-key`) and bills API rates. Codex is included with ChatGPT plans, with usage limits by plan. Sources: https://learn.chatgpt.com/docs/auth.md , https://learn.chatgpt.com/docs/codex/cli , https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan

When the user signs in to Codex with ChatGPT, the ChatGPT Terms of Use (and Privacy Policy, or the matching enterprise agreement) apply. OpenAI also publishes Sign in with ChatGPT Terms (https://openai.com/policies/sign-in-with-chatgpt-terms/ , effective 4 Nov 2026) for apps that integrate SIWC themselves. Those terms require the official sign-in flow, no passwords or cookies collected by the app, tokens only in local storage under the user's control, no pooling or resale of plan usage, and requests originating from a runtime the user controls.

Sanctioned design for this app: do not build a custom SIWC integration unless you fully comply with those terms and still do not take tokens off the user's machine. The required pattern is the same as Claude: drive the official `codex` CLI on the user's computer or the Bot's computer, let the user complete Codex's own "Sign in with ChatGPT", and route Swarm requests through that CLI. No scraping, no reuse of OAuth tokens outside the CLI.

If you find a tighter official prohibition that blocks even "app launches official CLI, user logs in, app calls the CLI", stop that path, quote the source in the PR, and ship the closest allowed option (for example, deep-link the user to Settings instructions plus a status of "CLI missing" / "Not connected", and keep API keys as the fallback).

## Wanted UI (model selection, and keep Settings in sync)
In the composer model picker and in Settings > Models & access, beside the API key fields, offer "Connect plan" or "Use subscription" per provider:

- Claude Max (and other Claude consumer plans that Claude Code supports) via the official Claude Code CLI.
- ChatGPT plan via the official Codex CLI.

Show connection status: "Connected as <plan name>" (or "Connected" plus the catalog plan string), "Not connected", or "CLI missing" if the official binary is not installed on the computer that would run it.

Actions: Connect (starts the official CLI login, user completes it) and Disconnect (stops using that CLI as the backend, does not invent a token wipe that would violate the CLI's own tools; use the official logout if required). Fallback: the user can still use the API key path (OpenRouter or direct) when no plan is connected, or can switch back to API.

The model list under a plan must be the catalog returned by that CLI (`cliCatalog`), not the API catalogue, and must say which models are available on the connected plan.

## Files to change (likely)
- `web/src/components/ComposerModelMenu.tsx`, `web/src/components/ModelUsageDetails.tsx`
- `web/src/components/config/SubscriptionSettings.tsx`, `web/src/components/config/CliLoginTerminal.tsx`
- `web/src/components/config/AppSettings.tsx` (keys vs subscriptions entry points)
- `server/src/cli/store.ts`, `server/src/cli/routes.ts`, `server/src/cli/catalog.ts`, `server/src/routes-models.ts` only as needed
- Tests under `tests/cli-*.mts` and a UI script for the picker connect path

## Acceptance criteria
- From model selection, a user can choose to connect a Claude plan or a ChatGPT plan without first hunting only through API key fields.
- Connect runs the official CLI login; Swarm never asks for a Claude or ChatGPT password, cookie, or raw OAuth token in its own form.
- Status shows Connected as plan, Not connected, or CLI missing, and updates after connect or disconnect.
- API key remains a working fallback when no plan is selected.
- Models listed for a connected plan come from that plan's CLI catalog.
- No secrets in logs, PR text, or UI (mask pairing commands and tokens).
- Terms: unmodified official CLIs, user-completed official login, requests routed through the CLI. New tests cover the status states and the picker entry point. Existing CLI tests still pass.
