# Dashboards and requirements

Swarm can build dashboards and change your home and navigation through chat. Accounts with no saved configuration keep the existing defaults. Availability depends on the account's feature flags. Requirements adaptation, About your use and All sections are pending UC-I integration; the section below describes that planned workflow.

## Ask your agent

In a personal Bot conversation, describe your role and goal:

- "I coordinate operations. I need daily reports and usage on my home."
- "Build a weekly dashboard with my tasks, what needs me, and upcoming routines."
- "Add a task board. Remove the note. Move usage after tasks."
- "Make the task list wider and the chart taller."
- "Open Tasks first and put Tasks first on my phone."
- "My work changed to support. Help me monitor queues and responses."

The agent proposes a dashboard or arrangement in a preview. Apply saves it, Discard returns to the saved version, and Show before lets you compare. Saved changes persist across reloads and sync to your other tabs. A preview alone does not save; pending previews expire after 15 minutes.

Widgets display your account's tasks, Bots, routines, runs and usage. They show an explanatory empty state when there is no matching data. Widgets do not create data, connect applications, or run arbitrary code. Notes support a small Markdown subset. A shortcut that prepares a message never sends it for you.

Dashboard Edit provides Add widget, Move earlier, Move later, Narrower, Wider, Shorter, Taller, Settings and Remove. These actions work with a keyboard. Labels wrap rather than truncate.

## About your use

Requirements adaptation is owned by UC-I. Once integrated, the agent saves only requirements you state, including role, goals, workflows and focus. Saving the profile alone does not rearrange the app. A deterministic engine proposes the home dashboard, emphasized navigation, suggested Bots, templates and default views; Apply confirms the proposal.

Settings, Appearance and layout, About your use (`#settings/appearance/use`) is the central place to view and edit the profile, re-adapt, or reset. A requirement change produces a new proposal. Values you changed by hand are kept and identified in the preview. Suggested Bots and templates require their own explicit create action.

All sections (`#all`) keeps every section reachable even when adaptation demotes it. It is available from the sidebar footer, phone More tab and command palette. Reset requirements clears the profile and proposes the default arrangement; it keeps your dashboards. Undo is available.

## Undo and recover

Use Undo after applying, or restore an earlier revision from Settings history. Undo creates a new revision. History retains up to 50 revisions for 90 days.

Open `/?ui=safe#bots`, or press Cmd+Alt+0 on Mac or Ctrl+Alt+0 elsewhere, to ignore saved customization in this tab. The recovery banner offers Reset and Undo. Opening safe mode does not delete the saved document. The banner's reset keeps dashboards; Reset all removes them too. Read the confirmation before proceeding.

Invalid stored documents fall back to defaults without being silently overwritten. Import validates the entire configuration and requires a preview before Apply. Exports contain configuration, not widget data.

An agent that has read a document, website, email, file or other outside content during a turn must wait for your confirmation even when automatic application is enabled. Outside content cannot authorize dashboard, navigation or profile changes. Routines and workflow workers do not receive customization tools.

## Developer guide

Use the frozen interfaces in [spec section 22.2](customization/SPEC.md). Shared schema and patch validation live in `server/src/ui-config`, persistence in `server/src/ui`, runtime in `web/src/customization`, and widgets in `web/src/dashboards`. Agent, manual edits and import use the same validator, preview and revision checks.

The current scope adds dashboards, layout, navigation and requirements adaptation. Do not extend cosmetic configuration or add cosmetic fixtures. The default document and users without requirements must retain main's geometry and styles.

### Extend navigation

Register ids and allowed states, then wire the shared hooks and exactly one marker per registered component. Hidden optional components must leave no gap or orphan border. Essential controls, Settings, recovery, approvals and All sections cannot disappear. Verify home routing, phone tabs, keyboard access and default alignment.

### Add a widget

1. Register strict options, compatible sources, defaults and a plain label. Reject unknown keys.
2. Implement loading, empty, error with Retry, and populated states using the Paper layout primitives. Dashboard Page is `wide`; chart data has an accessible table.
3. Send edits through `useUiPatch` with revision checks. Never render arbitrary HTML, scripts, embeds or automatic external assets. Keep labels readable at every breakpoint.
4. Extend all-widget seeded and empty fixtures, keyboard editing, chat editing, reload persistence, axe, alignment and measured performance checks.

### Add a data source

1. Register strict parameters and an explicit output field allowlist; implement `resolve(userId, params)`.
2. Scope every query to the authenticated user. Validate Bot ownership without revealing whether another account's id exists. Never return raw database rows, prompts, memory, keys or message content.
3. Respect result caps, timeout, user-scoped cache, and batch rate limits. Return a per-key error without failing unrelated requests.
4. Test distinct account sentinels, invalid parameters, output fields, caps, cache isolation and refresh. Use only disposable fixtures and the local mock provider.

### Extend adaptation

Keep recipes deterministic and validate generated patches. Profile updates alone cannot mutate UI config. Re-adaptation changes only managed paths and preserves hand edits. Keep every route reachable through All sections. Suggestions never create Bots, spend money, connect applications or send messages. Validate profile text, size limits, ownership, revision conflicts and taint handling through both chat and REST.

## Local quality gate

```sh
npm run typecheck
npm run build -w web
node --import tsx --test tests/ui-custom/security/*.test.mts tests/ui-custom/perf/*.test.mts
node tests/ui-custom/e2e/alignment-audit-ui.mjs
node tests/ui-custom/e2e/provider-adapter-ui.mjs
node tests/ui-custom/e2e/service-ui.mjs
node tests/ui-custom/e2e/journeys-ui.mjs
node tests/ui-custom/e2e/accessibility-ui.mjs
node tests/ui-custom/security/security-ui.mjs
node tests/ui-custom/perf/performance-ui.mjs
node tests/ui-custom/demo-h.mjs
node tests/layout-alignment-ui.mjs
```

The fixture launches a disposable SQLite database and loopback mock services. UC-B checks are mandatory: missing config routes, authentication failures and server errors fail. Unmerged client or UC-I features emit a named SKIP; `UC_REQUIRE_FULL=1` makes missing features fail. Skips never establish acceptance.

The alignment command preserves main's existing default 208-view audit. The custom matrix uses 320, 390, 500 and 1280 light plus 390 and 1280 dark with default cosmetic values. `fixtures/routes.mjs` registers seeded and empty dashboards with all ten widget types, edit mode, widget settings, add widget, Appearance, Preview and safe mode. Requirements, All sections and adaptive home are route-list entries gated on UC-I availability. Configurations go through PUT `/api/ui/config`; adaptation uses its real chat tools. Independent screens use a fresh local server every four cases to respect production rate limits.

The quality auditor checks visible text, body 14px minimum, explicit secondary text 13px minimum, contrast, control heights, card tokens, spacing, ButtonGroup flex, one phone Back, duplicate titles and helper copy. Existing geometry and complete-label checks remain active. Active sheets are audited independently of their inert background. All custom screens and demo captures reject `mock`, `Fixture`, `PRIVATE`, `QA-`, `undefined`, `null` and `[object`. Natural prompts stay in conversation history; scripted replies are injected only into the loopback provider request.

`tests/ui-custom/fixtures/uc-p-known-issues.json` is the temporary UC-P inventory explicitly authorized for dashboard and Appearance polish. Each entry matches an exact rule, element, observed value and route/width/theme. New violations fail. Fixed entries fail as stale until removed. Forbidden text and missing screens cannot be waived. `UC_REQUIRE_FULL=1` rejects every known issue as well as unavailable features. The inventory is never updated by a test run.

Use `UC_CAPTURE_PHASE=before` before a polish change and the default `after` afterward. Both runs save PNGs even when assertions fail, plus `observations-<phase>.json` and a complete `screenshots-<phase>.md` path list under `.context/ui-custom/alignment-matrix/`. H's initial before/after pair records the same production UI with the expanded harness; it does not establish that UC-P has fixed it. `UC_LAYOUT_FIXTURE`, `LAYOUT_OWNER`, `LAYOUT_ROUTES` and `LAYOUT_WIDTHS` narrow development runs only. `LAYOUT_ROOT` selects an external default baseline and is rejected by the full gate.

Evidence goes under `.context/ui-custom/`. The story manifest lists only screenshots actually captured. Performance records configuration reads and size, patch validation, data batches, dashboard content/CLS and lazy bundle size. `UC_RECORD_BASELINE=1` refuses incomplete runs; review measurements before committing. An absent baseline fails the full gate.
