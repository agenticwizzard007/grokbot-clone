# Platform voice

An administrator configures one **xAI API key** for voice. Every existing and newly created account inherits it immediately on iOS, macOS and web. No key is copied into user accounts or VMs, and no per-user provisioning job is needed. Voice stays independent of personal OpenRouter connections and CLI subscriptions; the main agent keeps using its selected text-model provider.

## Admin setup

1. Create a key in the platform's [xAI console](https://console.x.ai) with permission to use realtime voice, transcription and speech synthesis. The xAI account needs sufficient credits.
2. Sign in as a Swarm administrator and open **Settings → API keys → Platform voice**.
3. Paste the key into **xAI · Platform voice** and select **Save & verify**. Verification mints and discards a short-lived realtime credential; it does not start an audio call.
4. Start a voice call with the main agent. On iPhone, the **Talk to Swarm** Action Button shortcut uses this same service.

Alternatively, store `XAI_API_KEY` in the hosted server's secret store. Never put it in native app resources, web environment variables, source control or chat. `XAI_BASE_URL` defaults to `https://api.x.ai/v1`; override it only for a trusted compatible server or local tests.

Only server administrators (`ADMIN_USER_IDS` or an `account_roles` admin entry; owners configured by `ADMIN_PHONES` are mapped to the role once, on the first start after upgrading, which consumes the mapping permanently) can change platform credentials. App-saved keys are encrypted with the server's `SESSION_SECRET`, override deployment secrets and take effect immediately. Keep `SESSION_SECRET` stable. Removing an app key reveals an underlying deployment key if one exists; remove both to disable platform voice. Key rotation/removal affects new requests; already issued short-lived credentials and active provider sessions are not revoked by that action.

## Behavior and billing

- Live calls receive a five-minute provider credential; the long-lived key remains on the server. Session responses are marked `no-store`.
- Dictation, previews and spoken replies use the platform key on the server, including for CLI and personal OpenRouter users. Provider failures do not silently fall back to their personal text-model keys.
- Voice usage is attributed to the requesting account and its bot where available. Voice charges belong to the platform's xAI account and are separate from users' text-model subscriptions. Unknown prices remain unpriced in Swarm's usage report.
- Authenticated users can only start sessions and access voice tools for their own bots. The main-agent shortcut continues to target the primary bot.
- Without a platform key, legacy API-provider speech behavior is retained; CLI users receive an instruction to contact their platform admin.

## Native team coordination

The realtime voice agent can inspect and coordinate Swarm directly. It does not need to open Swarm in its computer's browser or sign into a second copy of the app.

- `get_platform_state` reports the selected text provider/model, CLI connection and runtime, recorded provider plan/quota observations when available, and account-scoped usage. `include_models` requests the available catalog. The active call's voice provider/model is reported separately from text routing. A CLI default, account label, or zero recorded API charges does not prove a particular subscription tier, remaining allowance, or absence of subscription fees. Unobserved facts remain unknown.
- `list_agents` and `get_agent` read the user's team, configurations, chats, tasks, routines and setup status. The primary agent can create teammates with `create_bot` and change their identity/model settings with `update_agent`. Creation uses the same durable setup service as text chat, preserving the spoken brief and corrections. It creates the teammate immediately; the existing setup interview and activation rules still apply. Computer readiness is reported separately.
- `send_task` accepts an optional `bot_id` to assign work, follow up, or forward the user's answer to a specialist. It uses the normal agent loop and approval policies. `control_agent` stops work without deleting the agent; only the primary can stop another agent.
- `/api/voice/updates` delivers finalized team replies, inter-agent inputs, pending questions/approvals, and tracked job status throughout the call, including agents whose chats have never been opened in the client. Question answers, approval resumes and app-connection callbacks retain the original assignment through durable parent-job links. Pending decisions stay waiting, and continuations stay queued/running until they finish. A reply is not proof that a queued task completed. Completion means the latest run ended; its result determines whether the requested outcome succeeded.
- Tool calls and update polling are bound to the authenticated account, call ID, and calling bot. Provider function-call IDs deduplicate retried actions within a call. Updates are cursor-based and bounded; a missed-history marker directs the agent to read current chats if the call falls behind. Ending a call stops delivery, while accepted agent work continues in chat.

Text agents receive the same native configuration context and `get_platform_state` tool, so a delegated configuration question also stays inside the app. Native controls do not bypass setup activation or approvals for external actions.

## Native app connections

Voice and text agents share `list_app_connections`, `search_apps` and `request_app_connection`. Connection listing reads all provider pages for the authenticated user’s private accounts and reports each account ID, revision and status without credentials. An unavailable provider or disabled integration is reported as unavailable, separately from a successful lookup containing no accounts. Multiple active accounts remain distinct; the agent must select the exact account for app tool discovery and execution.

`search_apps` searches the complete supported service catalog before applying its query and page bounds. It accepts `query`, `offset` and `limit` (default 20, maximum 100), returning `total` and `nextOffset` alongside the bounded service list. This discovers services; `SWARM_APPS_SEARCH` discovers executable tools for a selected active account, and `SWARM_APPS_EXECUTE` uses their exact schema and connection revision. Provider credentials and tool-router administration are never exposed.

`request_app_connection` validates the service, checks for existing active accounts and reuses a pending connect card in the current agent’s chat. It preserves the originating durable job on that card. A pending result includes `connectionRequest: { botId, seq, toolkit, toolkitName }`; it does not generate or return an OAuth URL. The frontend starts the existing `api.connect` flow so iOS/macOS use the native callback and web uses the normal browser callback. A shown card or an opened authorization screen is not proof of an active connection. Existing active accounts are reported directly without starting another authorization flow.

During an agent’s setup interview, native connection reads, service search and user authorization are permitted. Provider-verified read-only app operations may validate authentication and the requested account or repository scope. A tool name suggesting a read is insufficient: unverified operations remain blocked. Operational workflows, external writes and routines still require the user to review and activate the agent. Connecting an app does not activate setup or bypass ordinary approval and scope checks.

The live call displays pending connection and approval cards from the user's team. Connect starts the existing sign-in flow from a user gesture; only subsequent server state confirms the account. Voice discovers each exact tool/account/revision before dispatch. Writes and tools without verified read-only metadata use the existing approval flow unless the user saved an allow policy. Approval persists the exact operation and arguments, resumes it without a text-model planning step, and delivers its result through the team update feed. Repeated provider call IDs cannot dispatch the same operation again. Provider failures and uncertain outcomes remain failures and are never automatically retried.

## Validation

Run `node --import tsx --test tests/platform-voice.test.mts` for admin authorization, encrypted persistence, new-account inheritance, tenant isolation, CLI/personal-provider routing, credential validation, error sanitization and usage attribution. The tests use a local mock; a real microphone call and live xAI billing/permissions must also be checked after a production key is supplied.

Run `node --import tsx --test tests/voice-coordinator.test.mts tests/platform-state.test.mts tests/voice-controls.test.mts tests/voice-results-client.test.mts` for native routing, configuration knowledge, creation/controls, isolation, tool retry deduplication and multi-agent update delivery. Client delivery is exercised with a mocked realtime socket, microphone and voice API; no paid provider call is required for those checks.

Run `node --import tsx --test tests/app-connections.test.mts` for native connection ownership, secret-safe output, complete/bounded service search, unavailable-versus-empty results, active-account checks, connect-card reuse, job lineage and setup prompt constraints. The suite uses local SDK/transport mocks and does not start OAuth or call a live provider.

Run `node --import tsx --test tests/app-readonly.test.mts tests/voice-apps.test.mts` for local/tenant gateway metadata enforcement, SDK result handling, setup read checks in both voice and text chat, approval continuation, action deduplication and account isolation. Run `npm run build -w web && node tests/voice-apps-ui.mjs` for desktop/mobile call controls with mocked OAuth and realtime services. These tests do not exercise a live provider authorization or microphone conversation.
