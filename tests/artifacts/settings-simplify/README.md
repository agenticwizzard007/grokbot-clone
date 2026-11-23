# Settings simplification evidence

Local synthetic accounts only. No live app sign-in or real user data.

The 24 PNGs compare the unmodified `3fbca49d3bd4807d70dc3e267b4dd49097af0813` baseline with this change. Names use `{before,after}-{390,1280,1440}-{home,general,account,apps}.png`. Phone captures are 390x844; desktop captures are 1280x900 and 1440x900. Desktop home opens General with the navigation alongside it; phone home opens the section list. Screenshots show the top of each scrollable page.

The navigation has 11 icons, restored from `ed1f0ad41e502adceed11c145f8f3afa416cbb66` (Merge pull request #68 from agenticwizzard007/agenticwizzard007/voice-gap-recovery-20261120). The last icon-map change was `97896599226bc476e950f9b7419389f8bda57a7f` (feat: add native learning controls and Quinn team board). Both Learning and Connected apps retain Blocks.

Before: Personal (General, Account, Messaging, Usage), Bots (Learning, Computer, Permissions), Integrations (Connected apps, MCP servers, Models & access, API keys).

After: Workspace (General, Account, Messaging, Usage, Learning, Computer, Permissions), Connections (Connected apps, MCP servers, Models & access, API keys). All section IDs, search keywords and deep links remain unchanged.

`after-counts.json` records visible navigation and row icon assertions across every section and expanded Learning, Messaging, MCP and subscription bridge forms. Every SettingRow and AccessRow requires a Lucide icon; custom rows use the same decorative 20px, stroke 1.75 icon renderer. The regular fixture pages contain 64 rows per viewport, 91 including expanded forms. Dynamic account/session/server lists have one icon per rendered row.

Regression coverage:

- All 11 routes on direct load and reload at 390 and 1280, including later page landmarks and both General layout toggles plus keyboard shortcuts.
- Ten immediate Settings open/close/reopen cycles from the account menu at 1280, and correct trigger toggle behavior.
- Collapsed sidebar strip, phone Learning navigation, search, keyboard entry, and no horizontal page overflow at 390, 1280 and 1440.
- Unsaved MCP draft survives resizing between phone and desktop.
- Delayed Settings bundle displays a full-size, dismissible loading surface and supports close/reopen before loading completes at 390 and 1280.

Run from the repository root with the local Vite frontend on port 5193:

```sh
npm run dev -w web -- --host 127.0.0.1 --port 5193
node --import tsx --test tests/settings-simplify.test.mts tests/qa-r3-settings.test.mts tests/qa-ws4-settings.test.mts tests/plan-connections.test.mts tests/connected-account-details.test.mts
UI_ORIGIN=http://127.0.0.1:5193 node tests/settings-simplify-ui.mjs
UI_ORIGIN=http://127.0.0.1:5193 node tests/settings-open-ui.mjs
UI_ORIGIN=http://127.0.0.1:5193 node --test tests/qa-ui-i07-settings-search.mjs
node tests/access-settings-ui.mjs
node tests/qa-r3-settings-ui.mjs
node tests/bot-settings-deep-link-ui.mjs
node tests/settings-disconnect-ui.mjs
node tests/connected-account-details-ui.mjs
UI_ORIGIN=http://127.0.0.1:5193 node tests/settings-model-picker-ui.mjs
node tests/mcp-folder-overflow-ui.mjs
UI_ORIGIN=http://127.0.0.1:5193 node tests/plan-connections-ui.mjs
node tests/destructive-menu-contrast-ui.mjs
npm run typecheck
npm run build
```

To capture the baseline, serve the baseline checkout on another local port and run the screenshot script with `BEFORE=1 UI_ORIGIN=http://127.0.0.1:5194`. Before mode captures screenshots only; it does not assert restored icons or the new regressions. The script first saves images in `.context/settings-simplify/`, then copies them here for review in the PR.
