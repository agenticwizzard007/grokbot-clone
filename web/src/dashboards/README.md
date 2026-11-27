# Dashboard client

`DashboardView` consumes UC-D's effective configuration and revision-aware patch hook. UC-E mounts it at the dashboard route. The ten renderers share `WidgetFrame`, the Paper `Card` primitive and an accessible region name. Each grid cell has its own `Section`; `assertGrid` checks the variable column spans independently of the generic card-column audit.

The grid uses 12, 6 and 2 columns, a 16 px gap and an 88 px minimum row unit. Tracks can grow to keep long labels, enlarged text and edit controls visible. This is an accessibility exception to the fixed 88 px wording in spec 8.2. Equal row spans still share track heights. Lists and tables alone use internal scrolling.

`useWidgetData` batches intersecting widgets, shares identical queries, preserves stale content during refresh, and clears its cache on account changes. Polling pauses in hidden tabs and waits at least 30 seconds between attempts, including failed attempts. One dashboard EventSource supplies the routine and roster invalidations that the existing global client event bridge does not expose. It closes when hidden or unmounted. SSE, manual refresh and visibility restoration use F1's `Cache-Control: no-cache` support.

Edits use guarded JSON patches through `useUiPatch`. Both dashboard and widget identities are tested so stale indexes cannot edit a neighboring widget. Native dialogs provide focus trapping and Escape handling. Shortcut drafts use the existing composer prefill function, which preserves existing drafts and never sends them.

Chat uses the registered `create_dashboard`, `add_widget`, `remove_widget`, `move_widget` and `update_widget` tools. After the user applies a proposal, UC-D's `ui_config` SSE subscription updates every open dashboard. Saved widget order and size survive reload. The browser tests send chat messages through the local mock provider, click Apply, observe real SSE events in two open dashboards and reload after every edit.

Empty source results show one short line and one action: Ask your agent creates an unsent draft, or Create a Bot opens setup when the account has no Bots. A zero stat with no matching source records is empty; a zero field within existing records remains meaningful data. Notes and shortcuts render saved configuration, not remote data. The frozen shortcuts schema requires at least one item, so its new-account starter is one working Tasks link with a short introduction.

Notes use a fixed parser and React text nodes. External links are HTTPS only, show their domain, and use `noopener noreferrer`. Charts use inline SVG and a visually hidden data table.

Local checks:

- `node --import tsx --test tests/ui-custom/dashboard-model.test.mts`
- `node tests/ui-custom/dashboard-states-ui.mjs`
- `node tests/ui-custom/dashboard-editor-ui.mjs`
- `node tests/ui-custom/dashboard-live-widgets-ui.mjs`
- `node tests/ui-custom/dashboard-chat-ui.mjs`
- `npm run build -w web && node tests/ui-custom/dashboard-data-ui.mjs`
- `node tests/ui-custom/demo-f.mjs`
- `node tests/layout-alignment-ui.mjs`

The fixture uses the seeded local server with provider fetches disabled. Evidence is written under `.context/ui-custom/`. The data check includes a real task SSE event, account isolation, offscreen deferral, hidden-tab pause, SWR, retry, polling bounds and warm route budgets.

`demo-f.mjs` captures the same dashboard at 390 and 1280: a new account, seeded source data, and a widget added, resized, moved and removed through chat. Its transcript, final document and screenshot manifest accompany the captures. UC-F tests and demos use the default appearance only; no cosmetic customization is added. Whole-app requirements profiles belong to UC-I.
