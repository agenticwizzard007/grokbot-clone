# Settings and connected account QA

This change was investigated against 561fcc9 and @composio/core 0.28.0 using local fixtures only. No live app login, provider account reads, or provider mutations were performed. Fly logs were not available, so the exact live failure is unconfirmed; the following gaps are established from the code, SDK and current documentation.

## Identity lookup

The authenticated `/api/apps` and `/api/apps/connections` routes pass the signed-in user to a fresh PRIVATE connected-account list. Tenant deployments verify registry ownership against the provider list. Only after that check does the server fetch identity metadata for the exact connected account. These labels never authorize tool execution.

The SDK's `transformConnectedAccountResponse` maps `created_at`, `status_reason`, `is_disabled` and `state`, and retains legacy `data`/`params`. `ConnectionDataSchema` retains additional fields within `state.val`. Current Composio documentation specifically identifies `state.val.displayName` as the connected identity. The previous parser omitted this field, nested connectionParams/member containers and Slack team/user composition. It only attempted a provider profile for Gmail.

The previous Gmail fallback hard-coded users.getProfile. Google documents gmail.readonly, gmail.modify, gmail.metadata and mail.google.com as accepted scopes. An OAuth connection with only openid/email/profile can use OAuth userinfo instead. The previous implementation also shared one two-second deadline between account retrieval and the Gmail request, suppressed all lookup failures, cached empty results for 30 seconds, and erased successful labels on session invalidation.

The new path projects known identity fields, uses the toolkit's documented current-user endpoint only when its method is GET, and has fixed read-only fallbacks for Gmail, Slack, GitHub, Notion and Google apps. Gmail can fall back between users.getProfile and OAuth userinfo. Requests include both the verified owner and exact connected-account ID. Current Composio docs note that proxy execution requires the project key's Proxy execute (Legacy) permission and enforces toolkit domain restrictions. If the deployed key or OAuth grant lacks permission, the new `[connection-identity]` logs identify the toolkit, lookup stage and safe reason such as `http_403`, `timeout` or `identity_missing`. They never contain payloads, email addresses, account IDs, tokens, headers or exception messages.

Labels use a bounded per-project/user/account cache. Successful labels survive refresh failures and invalidation; failed lookups retry after five seconds. Fresh provider state still determines whether a connection is active.

Sources checked:

- https://docs.composio.dev/docs/authentication/manually-authenticating.md
- https://docs.composio.dev/docs/extending-sessions/proxy-execute.md
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
- node_modules/@composio/core/src/utils/transformers/connectedAccounts.ts
- node_modules/@composio/core/src/types/connectedAccounts.types.ts
- node_modules/@composio/core/src/types/connectedAccountAuthStates.types.ts
- node_modules/@composio/core/src/models/Tools.ts

## Other fixes

- Abandoned/failed authorizations were passed directly to display lists. They are now hidden, including expired attempts explicitly classified as unfinished by Composio. No automatic deletion or cleanup was added. Existing explicit per-account management remains. Active rows sort first, repeated IDs are removed, and app cards remain grouped by toolkit.
- Every metadata row previously rendered a connected date regardless of status. Only active rows now do so; expired/disabled/revoked rows say Needs reconnecting and offer Reconnect.
- The hash parser recognized only `settings/section`; bare `#settings` and `#settings/` now resolve to General.
- The standalone server already cached toolkit metadata, but tenant reads did not and concurrent cold loads were not shared. Both paths now share an hour-long metadata cache with stale refresh and an eight-second deadline. Private connection checks are still fresh. The client renders account-scoped cached catalog pages immediately, revalidates in the background, and prefetches when Settings opens. Missing artwork uses the existing letter avatar immediately, and failed image loads retain the existing onError fallback.
- Signed-in sessions and Gmail status had unbounded reads; Gmail also left its value at Checking on failure. Both now have a four-second deadline, retained account-scoped cached values, and Unavailable/Retry states. Timeouts include session account verification and response decoding. Caches are memory-only and clear on account changes/logout.

## Local validation

`tests/settings-connections-regressions.test.mts` covers realistic payloads, exact-owner read-only lookups, scope fallback, retained identities, filtering/dedupe, cache TTL and account isolation, timeout/retry and missing artwork. Existing account-details and settings routing tests were extended.

`tests/connected-account-details-ui.mjs` uses temporary SQLite, local Vite, fake Composio responses and blocked external requests at 390px and 1280px. It checks bare Settings, labels/statuses, pending visibility, reconnect availability, missing and failed logos, instant cached catalog rendering, and session/Gmail timeout recovery. Screenshots are saved under `.context/connected-account-details/`.
