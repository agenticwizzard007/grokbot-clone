Local visual evidence for the sign-in, chat, call and connections polish.

Baseline: `3fbca49d3bd4807d70dc3e267b4dd49097af0813` (origin/main before this pass). The final layout is rebased onto `565cf9cd87a685b2ab9baf91d6abfc13857a6af0` and preserves its connected-account details. After screenshots include a fake account details line to verify that integration.

The screenshots use real React components in a local Vite dev build, a temporary SQLite database, DEV_LOGIN=1, and local model and toolkit fixtures. The voice card and system event are injected into the local store. No live account, connection, or call is used.

Run `node tests/visual-polish-ui.mjs` to check the layout and capture the after images. Run the same test with `VISUAL_PHASE=before` in a baseline checkout to capture the before images without applying the new assertions.

Each combination has a before and after PNG:

| Screen | Filename screen segment |
| --- | --- |
| Main sign-in | `signin` |
| Model billing and provider tabs | `connect` |
| Expired-session form | `reauth` |
| Bot chat after a stopped run | `chat` |
| Connecting call card and composer | `call` |
| Connected apps list and MCP footer | `connections` |

Names follow `{before,after}-{screen}-{390,1280}.png` for dark theme and `{before,after}-{screen}-{390,1280}-light.png` for light theme. Viewport height is 900px.

The test checks equal provider widths, secondary alternatives, 12px gaps, heading consistency, full-width provider tabs, keyboard selection, inactive contrast, compact centered Details, one-line model metadata, content-sized bubbles, matched gutters and labels, a 32px left-aligned processing mark, no idle avatar after stopping, scrollbar clearance, call spacing and destructive contrast, shared system pills, connected-card alignment, and one MCP footer divider. It also checks the related connected-app layout in Settings.

Existing processing and avatar tests now require a 32px mark while preserving reply handoff and reduced-motion coverage. The connected-row regression test keeps long descriptions visible for unconnected apps and checks a single line for connected apps.
