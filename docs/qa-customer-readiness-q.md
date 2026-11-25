# Customer readiness round 2, stream Q

Scope: composer label and Settings layout only. Verification uses local fixtures, local Chrome and an untouched checkout of 1ef3439627c74142506970d3de14a14edf3b90f2. No live sign-in or user data access.

## Findings and changes

- R2-1: the desktop composer put the long `Codex CLI default` name and a separate plan badge inside a capped chip. Phones hid the plan and showed only `Codex`. The chip now says `Codex · ChatGPT plan` at every width. Its title and accessible name retain `Codex CLI default` and the billing description. Picker contents, including the Subscription badge, remain unchanged. Existing model-selector and readiness M tests now expect the intentional combined label.
- U24: the phone sign-in row's special CSS reduced its gap to 10px, versus the shared 16px gap. The manual key form had no icon lane. OpenRouter rows and the key form now share a 20px icon column and 16px gap. Label, field, hint and wrapped actions align with row text.
- R2-2: Provider account's note was in a sibling card after the heading row's divider. It is now the AccessRow description, together with the heading. OpenRouter account figures remain below it.
- R2-3: literal zero-spend slivers were not reproduced. On untouched main, exact-zero columns and their segments all have height 0 and end exactly at the baseline in both themes and widths. A nearby bug is reproducible with tiny positive AI and computer costs: the fixed 2px stack gap pushes a segment 2px below the baseline. The gap now uses `min(2px, 10%)`, keeping every segment within its bar. Zero-value rendering is otherwise unchanged. The test includes zero, tiny positive stacked, and ordinary positive stacked days.
- R2-4: Bot number used a 130px label column while the phone form was independently centered and padded. The inline phone fact now stacks its label and value at the shared text indent. The phone field and hint use that same indent.
- R2-5: Sign out used `cfg-btn--primary`. It now uses `cfg-btn--secondary`. Its handler, disabled state and sign-out behavior are unchanged.

## What the Codex labels establish

These labels are evidence of the selected plan route and a successful CLI auth-status check when its catalog was fetched. They are not a guarantee of a currently valid provider connection or available quota, and they are not merely an unchecked selection on a fresh successful catalog.

1. `server/src/cli/store.ts:selectedCli` reads the account's persisted `cli_preferences.provider`. `server/src/routes-models.ts` uses that selection for `/api/models` and returns `billing: 'plan'` with the CLI catalog.
2. Normal selection through `server/src/cli/routes.ts` refreshes status and requires a connected runtime plus `installed`, `authenticated`, `subscription`, and no provider error before saving the choice.
3. A fresh Codex catalog goes through `server/src/cli/bridge.ts:cliRequest`, which requests status, then `server/src/cli/codex-default.ts:codexDefaultCatalog`. That helper requires those same auth flags. `companion/cli-bridge.mjs:providerStatus` runs the official `codex login status` command; an exit code of 0 and `Logged in using ChatGPT`, without API-key/access-token mode, establish the subscription flag. Hosted credentials are isolated per Swarm account by `server/src/cli/hosted.ts:hostedOptions` and its private profile directory.
4. This is CLI-reported login state, not a live provider entitlement or token-validity API probe. The execution alias is always `codex/default`, named `Codex CLI default`. Codex's catalog deliberately returns `plan: null` and `usage: { available: false, windows: [] }`; authenticated app-server quota/model discovery is not used.
5. `web/src/components/SidebarUsage.tsx` falls back to `Codex plan` when the catalog has no plan name. `web/src/lib/accessPlanUsage.ts` returns unavailable for that empty quota data, yielding `Usage limits not reported`. It does not mean a limit was exhausted or that the plan is disconnected. The composer/picker's plan or Subscription label follows catalog billing, not a separate credential check.
6. `server/src/cli/catalog.ts:cliDisplayCatalog` can return the prior account/runtime catalog while a refresh runs, and retains it if refresh fails. `web/src/lib/sidebarUsageCache.ts` can also display a prior account summary for up to five minutes, marked Previously loaded when stale. Credentials may therefore have expired or disappeared since these labels were established. Generation checks authentication again.

To establish current connection state, the account's CLI status must be refreshed and its provider authentication/subscription flags checked. The labels alone cannot verify the live account's current credential presence or remote validity. This task did not inspect any live account credentials.

## Validation

`tests/customer-readiness-q-ui.mjs` exercises the actual app with local API fixtures. It checks chip text, one plan mention, scrollWidth versus clientWidth, full title/aria-label and retained picker content at 1280, 1024, 768 and 390 in light and dark. At 1280 and 390 it also checks shared API-key icon/text/field/hint columns, Provider account row containment, chart segment bounds, phone alignment, secondary sign-out styling and horizontal overflow. Screenshots are saved under `.context/readiness-q/`; the same test against untouched main saves `.context/readiness-q-before/`.

`tests/composer-model-label.test.mts` covers the combined Codex label and preservation of API, Claude and unavailable/unknown labels.

Full baseline and final unit results, earlier regression suites, and post-rebase validation are recorded in the PR and completion report.
