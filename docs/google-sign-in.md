# Google sign-in

When both Google client values are nonblank, sign-ins use Google OAuth/OIDC
directly with exactly `openid email profile`.
The server creates state, nonce and an S256 PKCE challenge when the browser follows
`/api/auth/google/start`. It verifies the ID token signature, issuer, audience,
age, nonce and verified email before creating a session. Direct OIDC login does not create a
Composio connection. Gmail access remains a separate choice in connect-apps.

## Owner configuration

The repository already supports `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
(also documented in `infra/platform/fly.platform.toml`). Set both on the app server
using a Google OAuth Web application client. Do not expose the secret to the web
bundle. No credentials were read or changed as part of this fix.

For the standalone deployment at `https://swarm-team.fly.dev`, set:

- `APP_URL=https://swarm-team.fly.dev`
- `SERVER_URL=https://swarm-team.fly.dev`
- `GOOGLE_CLIENT_ID` to the Web application client ID
- `GOOGLE_CLIENT_SECRET` to that client's secret

Register this exact authorized redirect URI in Google Cloud Console:
`https://swarm-team.fly.dev/api/auth/google/callback`.
Configure the sign-in consent screen for only `openid`, `email`, and `profile`.
Use a separate Google client from any Gmail app-connection configuration so
previous Gmail grants are not combined with login consent. Keep the existing
`SESSION_SECRET` stable to preserve sessions and encrypted settings.

For local development use a development client with
`http://localhost:8787/api/auth/google/callback`, or the callback matching the
local `SERVER_URL`. Automated tests use mocked providers and synthetic clients.

If either client value is absent or blank, the welcome page still offers Continue
with Google through the existing Composio configuration. No new client secrets or
deploy-time configuration are required for this fallback. It restores the previous
Composio-managed Gmail authorization flow, including its managed permissions.
The identity-only scope restriction applies to direct OIDC; the compatibility
fallback can still request Gmail access as it did before PR #293.

Both flows bind the verified Google subject to the same Swarm user ID. An older
account without a subject binding can be adopted only when its own active Gmail
authorization proves the same Google subject. Matching an email alone is not
sufficient. Existing sessions and pending callbacks remain valid across a switch.
Temporary fallback authorizations retain the existing cleanup protections.

Do not change the Composio Gmail auth configuration for this fix. Connect-apps
continues to authorize the `gmail` toolkit with its managed permissions.

## Recovery

Each Continue with Google or Try again click requests a new authorization.
Failed callbacks return to Welcome with an inline message and a full-width retry
control. Expired callbacks display: "That sign-in link expired. Please try again."
Provider error text is mapped to fixed messages, never rendered directly.
Both flows supply the Swarm callback URL and return provider failures to Welcome.
A link already open on Composio's own error page cannot be redirected by Swarm if
Composio never calls back; the user can return to Welcome and start a fresh sign-in.
Missing native client values alone never produce `google_unavailable` when the
Composio fallback is configured. That state indicates a provider start failure.

## Local verification

Run `npm run test:google-auth` for identity scopes, Gmail config separation,
missing-client behavior, callback errors, existing sessions, OIDC verification,
cross-provider account reuse, and fallback cleanup. Run `npm run test:google-sign-in-ui` for click-time
requests, welcome recovery at both widths, and a Gmail connection without a
Google login client. These commands use temporary databases and mocked providers.
