# OpenRouter sign-in and personal keys

Swarm supports OpenRouter account creation, returning sign-in, linking an existing Swarm account, and manually connecting an inference API key. Model requests use the connected user's OpenRouter credits. No OAuth client registration or client secret is required.

## Setup

1. Set `SERVER_URL` to the public server origin and `APP_URL` to the web app origin. In production, use HTTPS. For local development OpenRouter accepts localhost callbacks on any port.
2. Set a strong, persistent `SESSION_SECRET`. Swarm derives its encryption key from this secret. Back up the secret with the database; changing it makes stored credentials unreadable.
3. Open the sign-in page and choose **Continue with OpenRouter**. OpenRouter handles both its own account creation and authorization. The callback is `${SERVER_URL}/api/auth/openrouter/callback`.
4. Existing Swarm users should sign in normally, then choose **Settings → API keys → Connect OpenRouter** to link their current account. Users can also paste a key there without changing their sign-in method.

`OPENROUTER_API_KEY` remains an optional server default. Personal connections work with no server model key and with Composio disabled. `OPENROUTER_MODEL` supplies the initial default; each user can choose a different model, and Bots retain their own model overrides.

## Identity and credentials

- OAuth uses S256 PKCE, a random state, a browser-bound HttpOnly cookie, ten-minute attempts, and single-use callbacks. Verifiers and API keys are encrypted using AES-256-GCM.
- The authenticated `/auth/keys` exchange supplies `user_id`, the stable identity used for returning sign-in. Missing identities fail safely; Swarm does not guess identity from key metadata or email.
- OpenRouter does not provide a verified email/name. New users receive an internal placeholder address and a primary Bot. These placeholders are not used as verified contact addresses.
- Linking requires the original, still-valid Swarm session. An identity cannot be linked to two accounts. Accounts are never merged through a key, label, creator ID, or guessed email.
- A pasted key is validated against `/key`, must be an inference key, and is stored only for the signed-in user. It never authorizes access to anyone's Swarm account.
- Keys and PKCE verifiers never appear in frontend responses, local storage, callback URLs, or error messages. The UI receives only a last-four-character hint and a hashed link to OpenRouter key settings.

## Model selection and billing

The selected CLI subscription takes precedence. Connecting OpenRouter preserves an existing subscription selection; **Use OpenRouter** explicitly changes to API billing. Otherwise, a newly connected personal OpenRouter key takes precedence over server defaults. **Use server defaults** explicitly switches back.

Chat, tool turns, background jobs, memory work, and model selection resolve credentials through the Bot owner's async context. A missing, revoked, exhausted, or unreadable personal key does not fall back to the server's paid key. Disconnecting removes the local credential while preserving the selected mode and sign-in identity. Reconnect or explicitly choose another provider to resume inference.

Voice has separate platform configuration. Where platform voice is configured, its own billing applies. Otherwise supported voice notes and spoken replies can use a personal OpenRouter key. Live voice calls require a compatible direct/platform voice service.

Removing a key from Swarm does not revoke it on OpenRouter. Use **Manage keys and spending limits on OpenRouter** to revoke issued keys, set budgets, and inspect charges. Reauthorizing OpenRouter can issue a new key; prior issued keys may need revocation there. Deleting a Swarm account cascades its local credentials, identities, and auth attempts.

The agent runtime remains independent of OpenRouter: server direct providers and CLI subscriptions continue to work. OpenRouter is a multi-provider gateway; it is not required by the core harness.

## Native apps

The Mac and iOS shells open OpenRouter in the system authentication browser. A separate one-time code, bound to the app's PKCE verifier, transfers the session back to the webview. Linking starts with a short-lived ticket created using the app's current session; the session itself never goes in a URL. Rebuild native apps to include the new navigation handler.

## Verification

Run `npm run test:openrouter`, `npm run test:native-auth`, `npm run test:apple-auth`, `npm run typecheck`, and `npm run build`.

The OpenRouter suite uses mocked provider responses and exercises signup, repeat login, linking conflicts, state/cookie/expiry/replay protection, native handoff, encryption, validation, cross-user routing, rotation, disconnect, subscription precedence, audio routing, usage isolation, and an actual streamed agent turn with a tool call. Browser coverage is in `tests/openrouter-ui.mjs`. A real OpenRouter authorization and a signed native build should also be smoke-tested before release; automated tests do not consume real credits.

References: [OpenRouter OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth), [OpenRouter OpenAPI](https://openrouter.ai/openapi.json).
