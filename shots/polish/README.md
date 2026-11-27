# Dashboard polish evidence

Scope: dashboards, their editor and sheets, Appearance, and the compact About you section. App-wide adaptation polish is removed from this branch.

About you has one action, **Tell your agent**. It opens an unsent draft. It does not write the profile or change the layout.

Dashboard file structure, data contracts and patch semantics are unchanged. UC-X2 can add its manager, switcher and agent widget independently.

## Verification

| Check | Passed |
|---|---:|
| Server and web typecheck | 2 |
| Dashboard model and Appearance units | 106 |
| Dashboard data | 15 |
| Dashboard editor | 32 |
| Dashboard states | 215 |
| Dashboard live widgets | 46 |
| Dashboard chat | 5 |
| Appearance | 27 |
| Demo F | 12 |
| Demo G | 68 |
| Demo P | 144 + 18 |
| About you | 18 |
| Existing alignment routes | 208, zero issues |
| Client defaults | 208 matched, zero reviewed differences |

The About you test covers empty and saved profiles, one action, readable type, card geometry, complete labels, keyboard use, and zero layout/profile/message writes. The retired UC-I journeys are outside the revised scope and must be removed or replaced by UC-Y.

## Remaining integration

1. UC-Y: remove the old route heading and adaptation flag/API behavior; retain the read-only profile endpoint used by About you.
2. UC-H: route integration remains gated on the explicit #269 merge notice.
3. Verify the combined UC-Y/UC-X2 changes before the final PR handoff.

## Main-region words

| Screen | 1280 before / after | 390 before / after |
|---|---|---|
| dashboard | 241 / 238 | 239 / 248 |
| appearance | 261 / 257 | 239 / 235 |

The phone dashboard includes explicit table field labels. These counts use identical placeholder content and exclude sidebar and phone tabs.

## Files changed

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
- `shots/polish/README.md`, comparison PNGs and result JSON files.

## Screenshots

Light: 320, 390, 500 and 1280. Dark: 390 and 1280. Before images come from main `3842013`; FIX-2 has no UI changes. The About you before images show the former Requirements form.

### Before (150 PNGs)

- [about-you-1280-dark.png](before/about-you-1280-dark.png)
- [about-you-1280-light.png](before/about-you-1280-light.png)
- [about-you-320-light.png](before/about-you-320-light.png)
- [about-you-390-dark.png](before/about-you-390-dark.png)
- [about-you-390-light.png](before/about-you-390-light.png)
- [about-you-500-light.png](before/about-you-500-light.png)
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

### After (156 PNGs)

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
