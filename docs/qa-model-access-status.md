# Models & access plan status (R3-2)

The finding is reproducible from `SubscriptionSettings.tsx` on f941e2e. The first row used `planConnectionStatus`, which requires `status.selected` to match the tab. The lower runtime row used the tab's name, the selected provider's description and the tab's authentication status. With Codex selected, Claude could therefore show "Not connected" above "Claude Code / ChatGPT via Codex / Active". If both CLIs had saved eligible sign-ins, the lower row also showed "Connected" while the first row still said "Not connected".

The source is `/api/cli`, assembled in `server/src/cli/bridge.ts`: `connected` describes runtime availability, `providers[provider]` describes each CLI's installation and authentication, and `selected` chooses the model route. `/api/models` supplies the selected provider's reported plan and usage. These are distinct facts.

`modelAccessStatus.ts` now maps those facts for each tab. A connected CLI is installed, signed in with an eligible plan, reachable and verified. Only the selected connected CLI is "Currently in use". API selection leaves saved CLI sign-ins connected without claiming they are in use. Unknown, pending, ineligible and offline states cannot claim a working plan route.

Each tab has one plan status row and one current-route sentence. The duplicate runtime row, current-mode detail and footer actions are merged into the existing controls. The tab panel includes its status row, and plan usage belongs only to the matching connected tab. Reset, authentication, API providers, authorization refresh, provider instructions and advanced bridge controls remain available with the same handlers.

## Local checks

- `node --import tsx --test tests/model-access-status.test.mts`: seven tests for Codex only, Claude only, both, neither, API providers, missing/ineligible/offline CLIs and unavailable/pending probes.
- `node tests/model-access-status-ui.mjs`: 36 fixture cases, each checking both tabs, at 1280 and 390 in light and dark. Covers the five required connection combinations, both possible selected plans, an offline bridge, a blocked selected CLI and unavailable status. Checks status ownership, one current-route sentence, primary actions, plan usage, retained advanced rows and no horizontal overflow with details expanded. Asserts no mutation requests.
- The focused CLI, model, account isolation and plan unit set passes 129/129.
- Existing plan connection browser checks pass all six width/theme cases. Fake-CLI login/reset tests pass, including recovery and account isolation. Model selector checks pass all 12 cases. Customer-readiness Q checks pass 36/36.
- Typecheck and build pass. No live sign-in or customer data is used.

Full unit suites run with Node 24.22.1 and `node --import tsx --test --test-reporter=tap --test-concurrency=1 tests/*.test.mts tests/*.test.mjs`. Baseline is an untouched detached f941e2e checkout on this VM, with the same dependencies. Final comparison and post-rebase results are recorded in the PR.
