# Dashboard and Appearance polish

Rebased onto main `3cf57e0e43b0b4866d2aec33ba06f165dfaab12e`. Scope: dashboard view, editor, widget sheets, Appearance, and compact About you. No retired adaptation screens, data-model changes, API changes, patch-engine changes, or new theme/font/color choices.

About you shows the saved role and goals with one **Tell your agent** action. It opens an unsent draft. Profile updates and dashboard suggestions remain available through chat. The suggestion journey verifies the real agent tools, preview, Apply, persistence, unchanged navigation, and profile reset/Undo contracts.

The dashboard folder keeps its structure. The diff touches ten existing files: `AddWidgetSheet.tsx`, `DashboardEditor.tsx`, `DashboardView.tsx`, `Dialog.tsx`, `WidgetFrame.tsx`, `WidgetSettings.tsx`, and `widgets/{Chart,Empty,Shortcuts,Table}.tsx`. UC-X1's agent placeholder and disconnected-provider handling remain intact. UC-X2 owns the manager, switcher, and agent renderer.

## Local verification

All suites were run serially, against local seeded servers and the local scripted provider. No real user data or provider calls. Results below are the final runs; earlier failure logs are retained for diagnosis.

| Command | Result |
|---|---|
| `npm run typecheck` | Server and web pass |
| `node --import tsx --test tests/ui-custom/dashboard-model.test.mts tests/ui-custom/unit/appearance.test.mts tests/ui-custom/unit/appearance-runtime.test.mts` | 107 pass |
| `node tests/ui-custom/dashboard-data-ui.mjs` | 15 pass |
| `node tests/ui-custom/dashboard-editor-ui.mjs` | 37 pass |
| `node tests/ui-custom/dashboard-states-ui.mjs` | 215 pass |
| `node tests/ui-custom/dashboard-live-widgets-ui.mjs` | 46 pass |
| `node tests/ui-custom/dashboard-chat-ui.mjs` | 5 pass |
| `node --import tsx --test tests/ui-custom/adapt-chat.test.mts` | 6 pass |
| `node tests/ui-custom/appearance-ui.mjs` | 27 pass |
| `node tests/ui-custom/demo-f.mjs` | 12 pass |
| `node tests/ui-custom/demo-g.mjs` | 68 pass |
| `node tests/ui-custom/demo-p.mjs` | 144 polish checks plus 24 About you checks pass |
| `node tests/ui-custom/about-you-ui.mjs` | 24 pass after the standalone spacing correction |
| `node tests/ui-custom/e2e/suggest-dashboard-ui.mjs` | 42 pass |
| `node tests/ui-custom/unit/client-defaults-ui.mjs` | Default snapshots: 208/208 passed (182 matched, 26 reviewed) |
| `node tests/layout-alignment-ui.mjs` | 208 original route views, zero issues; 42 suggestion checks pass |
| `node tests/tasks-layout.mjs` | 10 width/theme cases pass |
| `node --import tsx tests/navigation-every-route-ui.mjs` | PASS navigation: 870 route/size/theme cases in 325.5s |
| `npm run build -w web` | Pass |

Logs: `.context/ui-custom/polish-rebased-checks/`. Demo reports: [after/results.json](after/results.json), [after/about-you-results.json](after/about-you-results.json).

Main's Add widget sheet crashes because the new Agent registry entry has no matching icon. The initial rebased editor run reproduced it; adding the missing icon and description fixes it. Before screenshots retain that broken state. The final editor run passes. No new failures versus main.

## Acceptance checklist

- [x] One dashboard title; standard equal-width, 44px header actions. Evidence: `demo-p.mjs`, 144 checks; dashboard screenshots.
- [x] Four named keyboard/touch toolbar actions inside each card; Size segmented control in settings. Evidence: `dashboard-editor-ui.mjs`, 37 checks, including descriptions retained at four widths.
- [x] Readable list titles and secondary text, 44px targets, full-width separators, status pills. Evidence: `demo-p.mjs` typography, contrast, row-target and label-fit assertions.
- [x] Chart bars proportional to seeded values; readable values/dates and phone height. Evidence: `demo-p.mjs` bar-to-data ratio assertions; widget-chart screenshots.
- [x] Consistent empty-state text and standard action. Evidence: `dashboard-states-ui.mjs`, 215 checks; empty-dashboard and widget-meter screenshots.
- [x] Add/settings sheets have Close, phone Back, scrollable content, and usable footers at 320px. Evidence: `demo-p.mjs` geometry, label-fit and target checks; add-widget and widget-settings screenshots.
- [x] Appearance uses existing primitives/Switch; equal button pairs; named 44px order actions; compact About you. Evidence: `appearance-ui.mjs` 27, `demo-g.mjs` 68, About you 24 checks.
- [x] Realistic placeholder seed names; forbidden visible text rejected. Evidence: `dashboard-fixture.mjs`, `demo-p.mjs`, `about-you-ui.mjs`. PRIVATE markers remain only in hidden leak-test fields.
- [x] Empty/seeded dashboard, all ten original widget types, edit mode, both sheets, delete confirmation, Appearance and its dashboard menu captured at light 320/390/500/1280 and dark 390/1280. Evidence: 144 polish captures plus 18 About you captures in each phase; no after-state overflow or clipped labels.

## Main-region word counts

`innerText` excludes the sidebar, phone tabs and visually hidden chart/table content. Placeholder content is identical in both phases.

| Screen | 1280 before / after | 390 before / after |
|---|---:|---:|
| Dashboard | 239 / 238 | 237 / 248 |
| Appearance | 254 / 250 | 231 / 227 |

The phone dashboard adds complete table field labels. Counts include user content and the desktop Settings navigation.

## Integration requests and deviations

UC-H #269 was still open during this handoff. Per the explicit ownership gate, this branch does not edit `tests/layout-alignment-ui.mjs`. UC-H should register the remaining polish state routes after #269 merges. The polish demo already uses its shared `inspectAlignment` assertions for every captured state; UC-Y's existing About you/suggestion route integration remains covered.

About you intentionally replaces the old form with the requested compact section. Its only action opens chat; it does not submit a request automatically. The before capture is main 3cf57e0e; the Add widget crash is preserved as baseline evidence, not repaired in the baseline checkout.

## Changed source and test files

- `tests/ui-custom/about-you-ui.mjs`
- `tests/ui-custom/appearance-fixture.mjs`
- `tests/ui-custom/appearance-ui.mjs`
- `tests/ui-custom/dashboard-agent-fixture.mjs`
- `tests/ui-custom/dashboard-data-ui.mjs`
- `tests/ui-custom/dashboard-editor-ui.mjs`
- `tests/ui-custom/dashboard-fixture.mjs`
- `tests/ui-custom/dashboard-live-widgets-ui.mjs`
- `tests/ui-custom/dashboard-states-ui.mjs`
- `tests/ui-custom/demo-f.mjs`
- `tests/ui-custom/demo-g.mjs`
- `tests/ui-custom/demo-p.mjs`
- `tests/ui-custom/e2e/suggest-dashboard-ui.mjs`
- `web/src/components/config/AppearanceSettings.tsx`
- `web/src/components/config/appearance/Controls.tsx`
- `web/src/components/config/appearance/Dashboards.tsx`
- `web/src/components/config/appearance/LayoutControls.tsx`
- `web/src/components/config/appearance/Manage.tsx`
- `web/src/components/config/appearance/Requirements.tsx`
- `web/src/dashboards/AddWidgetSheet.tsx`
- `web/src/dashboards/DashboardEditor.tsx`
- `web/src/dashboards/DashboardView.tsx`
- `web/src/dashboards/Dialog.tsx`
- `web/src/dashboards/WidgetFrame.tsx`
- `web/src/dashboards/WidgetSettings.tsx`
- `web/src/dashboards/widgets/Chart.tsx`
- `web/src/dashboards/widgets/Empty.tsx`
- `web/src/dashboards/widgets/Shortcuts.tsx`
- `web/src/dashboards/widgets/Table.tsx`
- `web/src/styles/appearance.css`
- `web/src/styles/dashboards.css`

## PNG inventory

All paths below are relative to `shots/polish/`. Each directory contains the six required width/theme variants. The About you page is captured separately from its embedded Appearance section.

### Before

- [about-you-1280-dark.png](before/about-you-1280-dark.png)
- [about-you-1280-light.png](before/about-you-1280-light.png)
- [about-you-320-light.png](before/about-you-320-light.png)
- [about-you-390-dark.png](before/about-you-390-dark.png)
- [about-you-390-light.png](before/about-you-390-light.png)
- [about-you-500-light.png](before/about-you-500-light.png)
- [about-you-empty-1280-dark.png](before/about-you-empty-1280-dark.png)
- [about-you-empty-1280-light.png](before/about-you-empty-1280-light.png)
- [about-you-empty-320-light.png](before/about-you-empty-320-light.png)
- [about-you-empty-390-dark.png](before/about-you-empty-390-dark.png)
- [about-you-empty-390-light.png](before/about-you-empty-390-light.png)
- [about-you-empty-500-light.png](before/about-you-empty-500-light.png)
- [about-you-page-1280-dark.png](before/about-you-page-1280-dark.png)
- [about-you-page-1280-light.png](before/about-you-page-1280-light.png)
- [about-you-page-320-light.png](before/about-you-page-320-light.png)
- [about-you-page-390-dark.png](before/about-you-page-390-dark.png)
- [about-you-page-390-light.png](before/about-you-page-390-light.png)
- [about-you-page-500-light.png](before/about-you-page-500-light.png)
- [add-widget-1280-dark.png](before/add-widget-1280-dark.png)
- [add-widget-1280-light.png](before/add-widget-1280-light.png)
- [add-widget-320-light.png](before/add-widget-320-light.png)
- [add-widget-390-dark.png](before/add-widget-390-dark.png)
- [add-widget-390-light.png](before/add-widget-390-light.png)
- [add-widget-500-light.png](before/add-widget-500-light.png)
- [appearance-1280-dark.png](before/appearance-1280-dark.png)
- [appearance-1280-light.png](before/appearance-1280-light.png)
- [appearance-320-light.png](before/appearance-320-light.png)
- [appearance-390-dark.png](before/appearance-390-dark.png)
- [appearance-390-light.png](before/appearance-390-light.png)
- [appearance-500-light.png](before/appearance-500-light.png)
- [appearance-agent-1280-dark.png](before/appearance-agent-1280-dark.png)
- [appearance-agent-1280-light.png](before/appearance-agent-1280-light.png)
- [appearance-agent-320-light.png](before/appearance-agent-320-light.png)
- [appearance-agent-390-dark.png](before/appearance-agent-390-dark.png)
- [appearance-agent-390-light.png](before/appearance-agent-390-light.png)
- [appearance-agent-500-light.png](before/appearance-agent-500-light.png)
- [appearance-home-1280-dark.png](before/appearance-home-1280-dark.png)
- [appearance-home-1280-light.png](before/appearance-home-1280-light.png)
- [appearance-home-320-light.png](before/appearance-home-320-light.png)
- [appearance-home-390-dark.png](before/appearance-home-390-dark.png)
- [appearance-home-390-light.png](before/appearance-home-390-light.png)
- [appearance-home-500-light.png](before/appearance-home-500-light.png)
- [appearance-manage-1280-dark.png](before/appearance-manage-1280-dark.png)
- [appearance-manage-1280-light.png](before/appearance-manage-1280-light.png)
- [appearance-manage-320-light.png](before/appearance-manage-320-light.png)
- [appearance-manage-390-dark.png](before/appearance-manage-390-dark.png)
- [appearance-manage-390-light.png](before/appearance-manage-390-light.png)
- [appearance-manage-500-light.png](before/appearance-manage-500-light.png)
- [appearance-shortcuts-1280-dark.png](before/appearance-shortcuts-1280-dark.png)
- [appearance-shortcuts-1280-light.png](before/appearance-shortcuts-1280-light.png)
- [appearance-shortcuts-320-light.png](before/appearance-shortcuts-320-light.png)
- [appearance-shortcuts-390-dark.png](before/appearance-shortcuts-390-dark.png)
- [appearance-shortcuts-390-light.png](before/appearance-shortcuts-390-light.png)
- [appearance-shortcuts-500-light.png](before/appearance-shortcuts-500-light.png)
- [appearance-show-1280-dark.png](before/appearance-show-1280-dark.png)
- [appearance-show-1280-light.png](before/appearance-show-1280-light.png)
- [appearance-show-320-light.png](before/appearance-show-320-light.png)
- [appearance-show-390-dark.png](before/appearance-show-390-dark.png)
- [appearance-show-390-light.png](before/appearance-show-390-light.png)
- [appearance-show-500-light.png](before/appearance-show-500-light.png)
- [appearance-sidebar-1280-dark.png](before/appearance-sidebar-1280-dark.png)
- [appearance-sidebar-1280-light.png](before/appearance-sidebar-1280-light.png)
- [appearance-sidebar-320-light.png](before/appearance-sidebar-320-light.png)
- [appearance-sidebar-390-dark.png](before/appearance-sidebar-390-dark.png)
- [appearance-sidebar-390-light.png](before/appearance-sidebar-390-light.png)
- [appearance-sidebar-500-light.png](before/appearance-sidebar-500-light.png)
- [dashboard-1280-dark.png](before/dashboard-1280-dark.png)
- [dashboard-1280-light.png](before/dashboard-1280-light.png)
- [dashboard-320-light.png](before/dashboard-320-light.png)
- [dashboard-390-dark.png](before/dashboard-390-dark.png)
- [dashboard-390-light.png](before/dashboard-390-light.png)
- [dashboard-500-light.png](before/dashboard-500-light.png)
- [dashboards-manager-1280-dark.png](before/dashboards-manager-1280-dark.png)
- [dashboards-manager-1280-light.png](before/dashboards-manager-1280-light.png)
- [dashboards-manager-320-light.png](before/dashboards-manager-320-light.png)
- [dashboards-manager-390-dark.png](before/dashboards-manager-390-dark.png)
- [dashboards-manager-390-light.png](before/dashboards-manager-390-light.png)
- [dashboards-manager-500-light.png](before/dashboards-manager-500-light.png)
- [delete-confirm-1280-dark.png](before/delete-confirm-1280-dark.png)
- [delete-confirm-1280-light.png](before/delete-confirm-1280-light.png)
- [delete-confirm-320-light.png](before/delete-confirm-320-light.png)
- [delete-confirm-390-dark.png](before/delete-confirm-390-dark.png)
- [delete-confirm-390-light.png](before/delete-confirm-390-light.png)
- [delete-confirm-500-light.png](before/delete-confirm-500-light.png)
- [edit-1280-dark.png](before/edit-1280-dark.png)
- [edit-1280-light.png](before/edit-1280-light.png)
- [edit-320-light.png](before/edit-320-light.png)
- [edit-390-dark.png](before/edit-390-dark.png)
- [edit-390-light.png](before/edit-390-light.png)
- [edit-500-light.png](before/edit-500-light.png)
- [empty-dashboard-1280-dark.png](before/empty-dashboard-1280-dark.png)
- [empty-dashboard-1280-light.png](before/empty-dashboard-1280-light.png)
- [empty-dashboard-320-light.png](before/empty-dashboard-320-light.png)
- [empty-dashboard-390-dark.png](before/empty-dashboard-390-dark.png)
- [empty-dashboard-390-light.png](before/empty-dashboard-390-light.png)
- [empty-dashboard-500-light.png](before/empty-dashboard-500-light.png)
- [widget-botStatus-1280-dark.png](before/widget-botStatus-1280-dark.png)
- [widget-botStatus-1280-light.png](before/widget-botStatus-1280-light.png)
- [widget-botStatus-320-light.png](before/widget-botStatus-320-light.png)
- [widget-botStatus-390-dark.png](before/widget-botStatus-390-dark.png)
- [widget-botStatus-390-light.png](before/widget-botStatus-390-light.png)
- [widget-botStatus-500-light.png](before/widget-botStatus-500-light.png)
- [widget-chart-1280-dark.png](before/widget-chart-1280-dark.png)
- [widget-chart-1280-light.png](before/widget-chart-1280-light.png)
- [widget-chart-320-light.png](before/widget-chart-320-light.png)
- [widget-chart-390-dark.png](before/widget-chart-390-dark.png)
- [widget-chart-390-light.png](before/widget-chart-390-light.png)
- [widget-chart-500-light.png](before/widget-chart-500-light.png)
- [widget-list-1280-dark.png](before/widget-list-1280-dark.png)
- [widget-list-1280-light.png](before/widget-list-1280-light.png)
- [widget-list-320-light.png](before/widget-list-320-light.png)
- [widget-list-390-dark.png](before/widget-list-390-dark.png)
- [widget-list-390-light.png](before/widget-list-390-light.png)
- [widget-list-500-light.png](before/widget-list-500-light.png)
- [widget-meter-1280-dark.png](before/widget-meter-1280-dark.png)
- [widget-meter-1280-light.png](before/widget-meter-1280-light.png)
- [widget-meter-320-light.png](before/widget-meter-320-light.png)
- [widget-meter-390-dark.png](before/widget-meter-390-dark.png)
- [widget-meter-390-light.png](before/widget-meter-390-light.png)
- [widget-meter-500-light.png](before/widget-meter-500-light.png)
- [widget-note-1280-dark.png](before/widget-note-1280-dark.png)
- [widget-note-1280-light.png](before/widget-note-1280-light.png)
- [widget-note-320-light.png](before/widget-note-320-light.png)
- [widget-note-390-dark.png](before/widget-note-390-dark.png)
- [widget-note-390-light.png](before/widget-note-390-light.png)
- [widget-note-500-light.png](before/widget-note-500-light.png)
- [widget-routineSchedule-1280-dark.png](before/widget-routineSchedule-1280-dark.png)
- [widget-routineSchedule-1280-light.png](before/widget-routineSchedule-1280-light.png)
- [widget-routineSchedule-320-light.png](before/widget-routineSchedule-320-light.png)
- [widget-routineSchedule-390-dark.png](before/widget-routineSchedule-390-dark.png)
- [widget-routineSchedule-390-light.png](before/widget-routineSchedule-390-light.png)
- [widget-routineSchedule-500-light.png](before/widget-routineSchedule-500-light.png)
- [widget-settings-1280-dark.png](before/widget-settings-1280-dark.png)
- [widget-settings-1280-light.png](before/widget-settings-1280-light.png)
- [widget-settings-320-light.png](before/widget-settings-320-light.png)
- [widget-settings-390-dark.png](before/widget-settings-390-dark.png)
- [widget-settings-390-light.png](before/widget-settings-390-light.png)
- [widget-settings-500-light.png](before/widget-settings-500-light.png)
- [widget-shortcuts-1280-dark.png](before/widget-shortcuts-1280-dark.png)
- [widget-shortcuts-1280-light.png](before/widget-shortcuts-1280-light.png)
- [widget-shortcuts-320-light.png](before/widget-shortcuts-320-light.png)
- [widget-shortcuts-390-dark.png](before/widget-shortcuts-390-dark.png)
- [widget-shortcuts-390-light.png](before/widget-shortcuts-390-light.png)
- [widget-shortcuts-500-light.png](before/widget-shortcuts-500-light.png)
- [widget-stat-1280-dark.png](before/widget-stat-1280-dark.png)
- [widget-stat-1280-light.png](before/widget-stat-1280-light.png)
- [widget-stat-320-light.png](before/widget-stat-320-light.png)
- [widget-stat-390-dark.png](before/widget-stat-390-dark.png)
- [widget-stat-390-light.png](before/widget-stat-390-light.png)
- [widget-stat-500-light.png](before/widget-stat-500-light.png)
- [widget-table-1280-dark.png](before/widget-table-1280-dark.png)
- [widget-table-1280-light.png](before/widget-table-1280-light.png)
- [widget-table-320-light.png](before/widget-table-320-light.png)
- [widget-table-390-dark.png](before/widget-table-390-dark.png)
- [widget-table-390-light.png](before/widget-table-390-light.png)
- [widget-table-500-light.png](before/widget-table-500-light.png)
- [widget-taskBoard-1280-dark.png](before/widget-taskBoard-1280-dark.png)
- [widget-taskBoard-1280-light.png](before/widget-taskBoard-1280-light.png)
- [widget-taskBoard-320-light.png](before/widget-taskBoard-320-light.png)
- [widget-taskBoard-390-dark.png](before/widget-taskBoard-390-dark.png)
- [widget-taskBoard-390-light.png](before/widget-taskBoard-390-light.png)
- [widget-taskBoard-500-light.png](before/widget-taskBoard-500-light.png)
### After

- [about-you-1280-dark.png](after/about-you-1280-dark.png)
- [about-you-1280-light.png](after/about-you-1280-light.png)
- [about-you-320-light.png](after/about-you-320-light.png)
- [about-you-390-dark.png](after/about-you-390-dark.png)
- [about-you-390-light.png](after/about-you-390-light.png)
- [about-you-500-light.png](after/about-you-500-light.png)
- [about-you-empty-1280-dark.png](after/about-you-empty-1280-dark.png)
- [about-you-empty-1280-light.png](after/about-you-empty-1280-light.png)
- [about-you-empty-320-light.png](after/about-you-empty-320-light.png)
- [about-you-empty-390-dark.png](after/about-you-empty-390-dark.png)
- [about-you-empty-390-light.png](after/about-you-empty-390-light.png)
- [about-you-empty-500-light.png](after/about-you-empty-500-light.png)
- [about-you-page-1280-dark.png](after/about-you-page-1280-dark.png)
- [about-you-page-1280-light.png](after/about-you-page-1280-light.png)
- [about-you-page-320-light.png](after/about-you-page-320-light.png)
- [about-you-page-390-dark.png](after/about-you-page-390-dark.png)
- [about-you-page-390-light.png](after/about-you-page-390-light.png)
- [about-you-page-500-light.png](after/about-you-page-500-light.png)
- [add-widget-1280-dark.png](after/add-widget-1280-dark.png)
- [add-widget-1280-light.png](after/add-widget-1280-light.png)
- [add-widget-320-light.png](after/add-widget-320-light.png)
- [add-widget-390-dark.png](after/add-widget-390-dark.png)
- [add-widget-390-light.png](after/add-widget-390-light.png)
- [add-widget-500-light.png](after/add-widget-500-light.png)
- [appearance-1280-dark.png](after/appearance-1280-dark.png)
- [appearance-1280-light.png](after/appearance-1280-light.png)
- [appearance-320-light.png](after/appearance-320-light.png)
- [appearance-390-dark.png](after/appearance-390-dark.png)
- [appearance-390-light.png](after/appearance-390-light.png)
- [appearance-500-light.png](after/appearance-500-light.png)
- [appearance-agent-1280-dark.png](after/appearance-agent-1280-dark.png)
- [appearance-agent-1280-light.png](after/appearance-agent-1280-light.png)
- [appearance-agent-320-light.png](after/appearance-agent-320-light.png)
- [appearance-agent-390-dark.png](after/appearance-agent-390-dark.png)
- [appearance-agent-390-light.png](after/appearance-agent-390-light.png)
- [appearance-agent-500-light.png](after/appearance-agent-500-light.png)
- [appearance-home-1280-dark.png](after/appearance-home-1280-dark.png)
- [appearance-home-1280-light.png](after/appearance-home-1280-light.png)
- [appearance-home-320-light.png](after/appearance-home-320-light.png)
- [appearance-home-390-dark.png](after/appearance-home-390-dark.png)
- [appearance-home-390-light.png](after/appearance-home-390-light.png)
- [appearance-home-500-light.png](after/appearance-home-500-light.png)
- [appearance-manage-1280-dark.png](after/appearance-manage-1280-dark.png)
- [appearance-manage-1280-light.png](after/appearance-manage-1280-light.png)
- [appearance-manage-320-light.png](after/appearance-manage-320-light.png)
- [appearance-manage-390-dark.png](after/appearance-manage-390-dark.png)
- [appearance-manage-390-light.png](after/appearance-manage-390-light.png)
- [appearance-manage-500-light.png](after/appearance-manage-500-light.png)
- [appearance-shortcuts-1280-dark.png](after/appearance-shortcuts-1280-dark.png)
- [appearance-shortcuts-1280-light.png](after/appearance-shortcuts-1280-light.png)
- [appearance-shortcuts-320-light.png](after/appearance-shortcuts-320-light.png)
- [appearance-shortcuts-390-dark.png](after/appearance-shortcuts-390-dark.png)
- [appearance-shortcuts-390-light.png](after/appearance-shortcuts-390-light.png)
- [appearance-shortcuts-500-light.png](after/appearance-shortcuts-500-light.png)
- [appearance-show-1280-dark.png](after/appearance-show-1280-dark.png)
- [appearance-show-1280-light.png](after/appearance-show-1280-light.png)
- [appearance-show-320-light.png](after/appearance-show-320-light.png)
- [appearance-show-390-dark.png](after/appearance-show-390-dark.png)
- [appearance-show-390-light.png](after/appearance-show-390-light.png)
- [appearance-show-500-light.png](after/appearance-show-500-light.png)
- [appearance-sidebar-1280-dark.png](after/appearance-sidebar-1280-dark.png)
- [appearance-sidebar-1280-light.png](after/appearance-sidebar-1280-light.png)
- [appearance-sidebar-320-light.png](after/appearance-sidebar-320-light.png)
- [appearance-sidebar-390-dark.png](after/appearance-sidebar-390-dark.png)
- [appearance-sidebar-390-light.png](after/appearance-sidebar-390-light.png)
- [appearance-sidebar-500-light.png](after/appearance-sidebar-500-light.png)
- [dashboard-1280-dark.png](after/dashboard-1280-dark.png)
- [dashboard-1280-light.png](after/dashboard-1280-light.png)
- [dashboard-320-light.png](after/dashboard-320-light.png)
- [dashboard-390-dark.png](after/dashboard-390-dark.png)
- [dashboard-390-light.png](after/dashboard-390-light.png)
- [dashboard-500-light.png](after/dashboard-500-light.png)
- [dashboards-manager-1280-dark.png](after/dashboards-manager-1280-dark.png)
- [dashboards-manager-1280-light.png](after/dashboards-manager-1280-light.png)
- [dashboards-manager-320-light.png](after/dashboards-manager-320-light.png)
- [dashboards-manager-390-dark.png](after/dashboards-manager-390-dark.png)
- [dashboards-manager-390-light.png](after/dashboards-manager-390-light.png)
- [dashboards-manager-500-light.png](after/dashboards-manager-500-light.png)
- [delete-confirm-1280-dark.png](after/delete-confirm-1280-dark.png)
- [delete-confirm-1280-light.png](after/delete-confirm-1280-light.png)
- [delete-confirm-320-light.png](after/delete-confirm-320-light.png)
- [delete-confirm-390-dark.png](after/delete-confirm-390-dark.png)
- [delete-confirm-390-light.png](after/delete-confirm-390-light.png)
- [delete-confirm-500-light.png](after/delete-confirm-500-light.png)
- [edit-1280-dark.png](after/edit-1280-dark.png)
- [edit-1280-light.png](after/edit-1280-light.png)
- [edit-320-light.png](after/edit-320-light.png)
- [edit-390-dark.png](after/edit-390-dark.png)
- [edit-390-light.png](after/edit-390-light.png)
- [edit-500-light.png](after/edit-500-light.png)
- [empty-dashboard-1280-dark.png](after/empty-dashboard-1280-dark.png)
- [empty-dashboard-1280-light.png](after/empty-dashboard-1280-light.png)
- [empty-dashboard-320-light.png](after/empty-dashboard-320-light.png)
- [empty-dashboard-390-dark.png](after/empty-dashboard-390-dark.png)
- [empty-dashboard-390-light.png](after/empty-dashboard-390-light.png)
- [empty-dashboard-500-light.png](after/empty-dashboard-500-light.png)
- [widget-botStatus-1280-dark.png](after/widget-botStatus-1280-dark.png)
- [widget-botStatus-1280-light.png](after/widget-botStatus-1280-light.png)
- [widget-botStatus-320-light.png](after/widget-botStatus-320-light.png)
- [widget-botStatus-390-dark.png](after/widget-botStatus-390-dark.png)
- [widget-botStatus-390-light.png](after/widget-botStatus-390-light.png)
- [widget-botStatus-500-light.png](after/widget-botStatus-500-light.png)
- [widget-chart-1280-dark.png](after/widget-chart-1280-dark.png)
- [widget-chart-1280-light.png](after/widget-chart-1280-light.png)
- [widget-chart-320-light.png](after/widget-chart-320-light.png)
- [widget-chart-390-dark.png](after/widget-chart-390-dark.png)
- [widget-chart-390-light.png](after/widget-chart-390-light.png)
- [widget-chart-500-light.png](after/widget-chart-500-light.png)
- [widget-list-1280-dark.png](after/widget-list-1280-dark.png)
- [widget-list-1280-light.png](after/widget-list-1280-light.png)
- [widget-list-320-light.png](after/widget-list-320-light.png)
- [widget-list-390-dark.png](after/widget-list-390-dark.png)
- [widget-list-390-light.png](after/widget-list-390-light.png)
- [widget-list-500-light.png](after/widget-list-500-light.png)
- [widget-meter-1280-dark.png](after/widget-meter-1280-dark.png)
- [widget-meter-1280-light.png](after/widget-meter-1280-light.png)
- [widget-meter-320-light.png](after/widget-meter-320-light.png)
- [widget-meter-390-dark.png](after/widget-meter-390-dark.png)
- [widget-meter-390-light.png](after/widget-meter-390-light.png)
- [widget-meter-500-light.png](after/widget-meter-500-light.png)
- [widget-note-1280-dark.png](after/widget-note-1280-dark.png)
- [widget-note-1280-light.png](after/widget-note-1280-light.png)
- [widget-note-320-light.png](after/widget-note-320-light.png)
- [widget-note-390-dark.png](after/widget-note-390-dark.png)
- [widget-note-390-light.png](after/widget-note-390-light.png)
- [widget-note-500-light.png](after/widget-note-500-light.png)
- [widget-routineSchedule-1280-dark.png](after/widget-routineSchedule-1280-dark.png)
- [widget-routineSchedule-1280-light.png](after/widget-routineSchedule-1280-light.png)
- [widget-routineSchedule-320-light.png](after/widget-routineSchedule-320-light.png)
- [widget-routineSchedule-390-dark.png](after/widget-routineSchedule-390-dark.png)
- [widget-routineSchedule-390-light.png](after/widget-routineSchedule-390-light.png)
- [widget-routineSchedule-500-light.png](after/widget-routineSchedule-500-light.png)
- [widget-settings-1280-dark.png](after/widget-settings-1280-dark.png)
- [widget-settings-1280-light.png](after/widget-settings-1280-light.png)
- [widget-settings-320-light.png](after/widget-settings-320-light.png)
- [widget-settings-390-dark.png](after/widget-settings-390-dark.png)
- [widget-settings-390-light.png](after/widget-settings-390-light.png)
- [widget-settings-500-light.png](after/widget-settings-500-light.png)
- [widget-shortcuts-1280-dark.png](after/widget-shortcuts-1280-dark.png)
- [widget-shortcuts-1280-light.png](after/widget-shortcuts-1280-light.png)
- [widget-shortcuts-320-light.png](after/widget-shortcuts-320-light.png)
- [widget-shortcuts-390-dark.png](after/widget-shortcuts-390-dark.png)
- [widget-shortcuts-390-light.png](after/widget-shortcuts-390-light.png)
- [widget-shortcuts-500-light.png](after/widget-shortcuts-500-light.png)
- [widget-stat-1280-dark.png](after/widget-stat-1280-dark.png)
- [widget-stat-1280-light.png](after/widget-stat-1280-light.png)
- [widget-stat-320-light.png](after/widget-stat-320-light.png)
- [widget-stat-390-dark.png](after/widget-stat-390-dark.png)
- [widget-stat-390-light.png](after/widget-stat-390-light.png)
- [widget-stat-500-light.png](after/widget-stat-500-light.png)
- [widget-table-1280-dark.png](after/widget-table-1280-dark.png)
- [widget-table-1280-light.png](after/widget-table-1280-light.png)
- [widget-table-320-light.png](after/widget-table-320-light.png)
- [widget-table-390-dark.png](after/widget-table-390-dark.png)
- [widget-table-390-light.png](after/widget-table-390-light.png)
- [widget-table-500-light.png](after/widget-table-500-light.png)
- [widget-taskBoard-1280-dark.png](after/widget-taskBoard-1280-dark.png)
- [widget-taskBoard-1280-light.png](after/widget-taskBoard-1280-light.png)
- [widget-taskBoard-320-light.png](after/widget-taskBoard-320-light.png)
- [widget-taskBoard-390-dark.png](after/widget-taskBoard-390-dark.png)
- [widget-taskBoard-390-light.png](after/widget-taskBoard-390-light.png)
- [widget-taskBoard-500-light.png](after/widget-taskBoard-500-light.png)
