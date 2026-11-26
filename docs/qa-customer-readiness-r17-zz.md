# Round 17 ZZ: provider marks on plan and model labels

## Findings and changes

The phone rule in paper-core.css hid the composer provider icon. ProviderIcon also used the Claude Code pixel mascot for Anthropic, while plan connections with no reported model had no icon at all. Other settings and usage labels were plain text.

ProviderMark now renders local, recognizable monochrome brand SVGs in a fixed 16px square. Claude uses the starburst, OpenAI uses the knot, and OpenRouter, xAI and the other supported catalog authors use their own marks. The marks inherit the label color in light and dark themes. Their paths and provenance are recorded alongside the assets. Unknown custom API endpoints do not claim another provider's brand.

The composer always reserves the slot, including during first render and catalog refresh. A saved or remembered model supplies its known brand before the catalog resolves. Phone layouts retain the logo and may hide the chevron. No composer growth behavior changes belong to this stream.

Labels covered: composer model/plan and effort, model rows and effort headers, sidebar usage including collapsed state, plan connection entries, Models & access tabs and connection status, current route, account provider and eligible plan, connected-plan usage, API key provider labels, Bot model/effort settings, usage billing sources and model breakdown, learning-run route labels, and provider credit notices. Existing visible text supplies the accessible name. The collapsed sidebar button retains its plan-specific accessible label.

Last model/CLI/tool run diagnostics and approval cards do not currently display a model or named provider. They retain their existing content. No model name was added just to place a logo. Recheck any run labels added by concurrent work during rebase.

## Validation

`tests/provider-logos-ui.mjs` runs the local production app with synthetic accounts at 390 and 1280 in light and dark. It covers Claude Max, Codex with an empty catalog, Grok API and OpenAI API, asserts fixed 16px loaded artwork and decorative accessibility, delays artwork to detect movement, and checks the sidebar, picker, Models & access, Bot settings and Usage. Screenshots are saved under `.context/provider-logos/`.

The first-render tests also assert the OpenAI mark for a saved GPT model and the Claude mark for a remembered Opus model. `tests/provider-brand.test.mts` checks plan/model aliases and keeps unknown connections neutral.

The existing Models & access UI assertion `switching tabs cancels confirmation` failed on both this branch and untouched main at c1c6c67 on this VM. It is outside logo rendering and was not changed. A concurrent Vite dependency-cache collision also caused a settings picker run to fail with a null useRef error; with separate baseline Vite caches the unchanged picker checks passed at all four widths.

Full baseline/candidate counts and the final post-XX layout/performance validation will be recorded in the PR before merge. All tests use local fixtures. No live sign-in or real user data is used.
