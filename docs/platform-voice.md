# Platform voice

An administrator configures one **xAI API key** for voice. Every existing and newly created account inherits it immediately on iOS, macOS and web. No key is copied into user accounts or VMs, and no per-user provisioning job is needed. Voice stays independent of personal OpenRouter connections and CLI subscriptions; the main agent keeps using its selected text-model provider.

## Admin setup

1. Create a key in the platform's [xAI console](https://console.x.ai) with permission to use realtime voice, transcription and speech synthesis. The xAI account needs sufficient credits.
2. Sign in as a Swarm administrator and open **Settings → API keys → Platform voice**.
3. Paste the key into **xAI · Platform voice** and select **Save & verify**. Verification mints and discards a short-lived realtime credential; it does not start an audio call.
4. Start a voice call with the main agent. On iPhone, the **Talk to Swarm** Action Button shortcut uses this same service.

Alternatively, store `XAI_API_KEY` in the hosted server's secret store. Never put it in native app resources, web environment variables, source control or chat. `XAI_BASE_URL` defaults to `https://api.x.ai/v1`; override it only for a trusted compatible server or local tests.

Only server administrators (`ADMIN_USER_IDS` or an `account_roles` admin entry; owners configured by `ADMIN_PHONES` are mapped to the role once at upgrade) can change platform credentials. App-saved keys are encrypted with the server's `SESSION_SECRET`, override deployment secrets and take effect immediately. Keep `SESSION_SECRET` stable. Removing an app key reveals an underlying deployment key if one exists; remove both to disable platform voice. Key rotation/removal affects new requests; already issued short-lived credentials and active provider sessions are not revoked by that action.

## Behavior and billing

- Live calls receive a five-minute provider credential; the long-lived key remains on the server. Session responses are marked `no-store`.
- Dictation, previews and spoken replies use the platform key on the server, including for CLI and personal OpenRouter users. Provider failures do not silently fall back to their personal text-model keys.
- Voice usage is attributed to the requesting account and its bot where available. Voice charges belong to the platform's xAI account and are separate from users' text-model subscriptions. Unknown prices remain unpriced in Swarm's usage report.
- Authenticated users can only start sessions and access voice tools for their own bots. The main-agent shortcut continues to target the primary bot.
- Without a platform key, legacy API-provider speech behavior is retained; CLI users receive an instruction to contact their platform admin.

## Validation

Run `node --import tsx --test tests/platform-voice.test.mts` for admin authorization, encrypted persistence, new-account inheritance, tenant isolation, CLI/personal-provider routing, credential validation, error sanitization and usage attribution. The tests use a local mock; a real microphone call and live xAI billing/permissions must also be checked after a production key is supplied.
