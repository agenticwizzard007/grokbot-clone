# Appearance and dashboards

Customization is available only when enabled for your account. Open Settings, Appearance to change the same settings your agent can change. A new account keeps the existing Swarm appearance until you make a change.

## Ask your agent

Try these requests in a personal Bot conversation:

- "Make everything dark with a teal accent."
- "Make text larger and spacing comfortable."
- "Hide Usage in the sidebar and collapse the run log."
- "Open on Tasks and put Tasks first on my phone."
- "Build a dashboard with my tasks, what needs me, and spending this week."
- "Make the chart wider and add upcoming routines."

The agent shows a preview card and a Preview banner. The preview changes the current conversation's appearance before you commit. Select Apply to keep it or Discard to go back. Show before lets you compare. Reloading discards the visible preview; pending previews expire after 15 minutes. Other tabs receive saved changes without reloading.

Apply requires your click by default. Settings, Appearance, Agent offers "Apply my agent's changes right away". Even with that setting, an agent that has read outside content in the current turn must wait for your click. Documents, emails and websites cannot authorize appearance changes. Unattended routines and workflow workers do not get customization tools.

## Change it yourself

Settings, Appearance includes presets, mode, accent, font, text size, density, corners, sidebar order, home page, phone tabs, component visibility and shortcuts. Low contrast colors show an explanation and cannot be saved. Settings and recovery remain available. Compact density retains phone touch targets. Labels wrap rather than truncate.

Dashboard widgets use your own tasks, Bots, routines, runs and usage. Widgets do not run code or connect to outside applications. Edit exposes Add widget plus Move earlier, Move later, Narrower, Wider, Shorter, Taller, Settings and Remove. These controls work by keyboard; dragging is optional. Notes support a small Markdown subset, not HTML. A shortcut that prepares a message never sends it for you.

## Undo and recover

Use Undo on an applied card, in the update message, or ask "undo that". Settings, Appearance, Manage, History can restore an earlier revision. Undo creates a new revision, preserving the history of what happened. History retains at most 50 revisions for 90 days.

For recovery, add `?ui=safe` before the route hash, for example `/?ui=safe#settings/appearance`. Alternatively press Cmd+Alt+0 on Mac or Ctrl+Alt+0 elsewhere. Safe mode ignores customization in this tab and offers Reset and Undo. It does not delete your saved appearance by opening the link.

Reset appearance keeps dashboards. Reset all removes them too; read the confirmation before proceeding. The agent asks whether to keep dashboards when you request a full reset. Unknown future config versions and invalid stored documents fall back to defaults and offer recovery without overwriting the saved document.

## Export and import

Manage, Export downloads `swarm-appearance.json`. Import validates a file and shows a preview; Apply is still required. Files cannot contain CSS, HTML, scripts, remote fonts or image assets. Unknown Bot references are dropped with a warning. Exports contain configuration, not the data displayed by widgets. They are not a sharing or gallery feature.

## Developer guide

The contract is [the build spec](customization/SPEC.md), especially sections 5 through 16 and 22.2. Pure shared code lives in `server/src/ui-config`; REST and persistence in `server/src/ui`; runtime in `web/src/customization`; widgets in `web/src/dashboards`. Use the frozen exports from `server/src/ui-config/index.ts` and `web/src/customization/index.ts`. Agent, Settings and import must use the same strict validator and patch engine.

Precedence is defaults, preset, user document, phone overlay, then policy. The phone overlay applies at 480 px and below and contains only density and scale. User writes must keep policy empty. Registry ids are append only. Removals require a forward migration and golden fixtures. With defaults, `effectiveTokens` returns an empty map so existing appearance stays unchanged.

### Add a token

1. Add its id, label, CSS variable names, dependencies and contrast roles to `registry-tokens.ts`. Colors accept only normalized `#RRGGBB`; other settings use closed enums mapped to constants.
2. Extend schema, derivation and accessibility validation for both modes. Preserve default identity and never override provider or Bot identity colors.
3. Add the Settings control and typed agent option. The applier must resolve names through the registry and call `setProperty`; never interpolate CSS text.
4. Verify valid and hostile inputs, contrast, both modes, preview/undo, and the alignment matrix. Any new schema field needs a security fuzz target.

### Add a component id

1. Register a hideable id and its allowed states in `registry-components.ts`.
2. Add exactly one `data-ui-id` marker and one `useComponentVisible(id)` call. Keep no empty gap or orphan border when hidden.
3. Add the Settings toggle and parity fixture. Check source and DOM coverage, keyboard behavior, and focus/calm alignment.
4. Never register Settings, Back, composer, approvals, questions, errors, offline or recovery banners, or sign out.

### Add a widget type

1. Register strict options, allowed sources, defaults and a plain label in `registry-widgets.ts`. Unknown keys must fail.
2. Supply a component, skeleton, empty state, error with Retry, and an accessible section name. Charts need a data table. Use shared Card and DashboardGrid; Page is `wide`.
3. Implement keyboard editing through `useUiPatch` with revision checks. Labels must wrap, never ellipsize. No arbitrary HTML, scripts, embeds or image URLs.
4. Extend fixture coverage, all four states, source compatibility, 320/390/500/768/1280 reflow, axe, alignment and performance measurements. Explicitly review any new capability.

### Add a data source

1. Register its id, label, strict parameter schema and field allowlist. Implement `resolve(userId, params)` in `server/src/ui/sources`.
2. Bind every query to the authenticated user; validate Bot ownership without leaking whether another user's id exists. Return only the documented fields plus count, never raw database rows.
3. Respect 25 rows, 31 series points, 200 ms timeout, a 10 second cache keyed by user/source/canonical params, and 30 batches per minute with at most 24 requests per batch.
4. Add cross-user tests using distinct fixture sentinels, field allowlist checks, malformed params, timeout, caps, cache separation and SSE invalidation. Never read message text, prompts, memory, files, keys or external application data.

### Security checklist for extension PRs

- All strings and enum values pass the same strict validation on preview, direct patch and import.
- No dynamic HTML or executable CSS sinks; links allow only HTTPS or in-app routes and never load automatically.
- Sources and previews bind to the session user; no input selects a different user.
- Essential navigation, contrast, text sizes, touch targets and safe mode survive corrupt stored data.
- Metrics are counts and timings only. No config content or widget data in telemetry.
- Limits, hidden-tab pause, off-screen deferral and request batching remain effective.
- Test only local fixture accounts and `tests/mock-provider.mjs`. No provider credentials or real user data.

## Local quality gate

Install with `npm ci`. Tests launch disposable SQLite databases seeded from `tests/fixtures/layout.seed.mts` and use loopback mock services. Evidence goes under `.context/ui-custom/`.

```sh
npm run typecheck
node tests/ui-custom/e2e/journeys-ui.mjs
node tests/ui-custom/e2e/accessibility-ui.mjs
node tests/ui-custom/security/security-ui.mjs
node tests/ui-custom/perf/performance-ui.mjs
node tests/ui-custom/demo-h.mjs
node tests/layout-alignment-ui.mjs
```

During parallel development, absent feature endpoints or modules print a named SKIP. `UC_REQUIRE_FULL=1` converts each absence to a failure. Authentication errors, server errors and broken assertions are never skips. Before merge, run the full commands with `UC_REQUIRE_FULL=1` and compare with the same checks on main. Skipped work does not satisfy acceptance.

The alignment matrix uses PUT `/api/ui/config` with If-Match for each fixture and then visits every enforced route in light/dark at 390/1280. `UC_LAYOUT_FIXTURE=<name>` selects a fixture during debugging; the release gate leaves it unset. `LAYOUT_OWNER` likewise narrows a development run only. Security corpora and generated fuzz strings are deterministic and contain placeholder data.

The performance harness writes measured results separately from its committed baseline. An absent baseline is reported as pending and fails the full gate. Establish one explicitly with `UC_RECORD_BASELINE=1` only on a fully integrated build; review the measurements before committing. Normal runs never silently replace a baseline or treat a missing measurement as zero.
