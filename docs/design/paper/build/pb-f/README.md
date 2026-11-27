# PB-F layout recheck

Baseline: untouched tracked files at `40b6632339e203e30f05aede5a5ab80f77a09493` in a detached local worktree. The same extended alignment test and local SQLite seed run against both versions. Dependencies are shared through local symlinks. No live account is used.

Diagnostics now uses a shared Section footer, with its text aligned to the card's left edge. Section text actions center their labels and end at the column edge. Tasks shows a warning Card immediately after its heading whenever ordinary tasks or approval items need input. Review selects the pending filter, including when Done was selected. An empty waiting list hides the notice.

The generic equal-cell audit also found unequal Bot task filters, desktop Theme cells, Bot details tabs, Setup tabs, and phone Bot settings tabs. These now share equal widths. Longer tab sets use equal grid columns that wrap between complete labels.

## Reproduction

```sh
node tests/layout-alignment-ui.mjs
LAYOUT_ROUTES=bots,settings-general,tasks LAYOUT_WIDTHS=320,390,500,768,1280 node tests/layout-alignment-ui.mjs
LAYOUT_ROUTES=bot-tasks,bot-setup,bot-settings-general LAYOUT_WIDTHS=320,390,500,768,1280 node tests/layout-alignment-ui.mjs
LAYOUT_ROOT=.context/pb-f-baseline LAYOUT_ROUTES=bots,settings-general,tasks LAYOUT_WIDTHS=320,390,500,768,1280 LAYOUT_EVIDENCE=.context/pb-f/before node tests/layout-alignment-ui.mjs
```

The baseline command intentionally fails. These four new check failures are copied from that run:

```text
FAIL settings-general 390 light: Diagnostics text left edge: 6.00px inset
FAIL bots 390 light: Section action text not centered: header.layout-section__header Rooms New room (9.00px)
FAIL tasks 1280 light: Tasks needs-input banner missing for 1 waiting task
FAIL tasks 1280 light: Unequal segmented cells: div.task-filters Open Done All 2 (52.28, 51.50, 68.88)
```

`before-geometry.json` and `after-geometry.json` record both themes at all five widths. Checks include text edges, shared Section typography, action alignment, equal segmented cells, complete words, visible 16px provider slots, the waiting banner in the first viewport, Review from Done, task chat navigation, and the zero-waiting state. The generic route matrix also checks every visible tab row and segmented control.

## Screenshots and Paper comparison

Built screenshots are `<slug>-<width>-<theme>.png`, with matching baseline images in `before/`. All three screens have 320, 390 and 1280 screenshots in both themes. `references/` contains local Playwright screenshots of the unmodified Paper generator at 390 and 1280. Python 3.12 was used because the generator uses modern f-string syntax.

The shared geometry follows BUILD-SPEC 0d and the exact values in `gen/comp.py`, `gen/shell.py`, and `gen/screens2.py` / `gen/screens3.py`: centered form/list columns, symmetric gutters, 12px Card corners, 16px Card padding, 44px controls, 13/18 weight-600 Section titles, and equal segmented cells. The existing Bots card/Rooms order and Tasks board/group order are retained. The phone Settings artboard is the Settings index; the General subpage uses the shared form geometry. The new waiting Card is the explicit PB-F addition to the Tasks artboard.

The matching screenshots use fixture names and the waiting/working task text from `phone-qa.seed.mts`. Deterministic Bot avatars keep the comparison consistent. Paper's sample content is not substituted for application data.

## Copy count

Visible words exclude the app sidebar, phone tabs, and accessibility-only text. Values are desktop 1280 / phone 390, identical in light and dark.

| Screen | Before | After |
| --- | --- | --- |
| Settings General | 38 / 17 | 38 / 17 |
| Bots | 23 / 22 | 23 / 22 |
| Tasks | 39 / 33 | 45 / 39 |

Tasks adds exactly six words: `1 task needs your input` and `Review`. The existing PB-E copy-budget assertion permits these six words only while the approved waiting notice is visible. No other copy budget changes.

## Browser and build verification

- All 208 alignment route/width/theme views pass.
- All 60 changed-screen and equal-control cases pass at 320, 390, 500, 768 and 1280 in both themes after fetching and rebasing on main.
- All 10 layout primitive cases pass.
- The phone/tablet sweep passes 416 views across 13 sizes. It reports eight small-link tap-target warnings on Models and access, outside these fixes.
- Navigation passes 770 route/width/theme cases. The final production build also passes all 308 navigation cases at 390 and 1280, including task and approval chat returns.
- All four API approval browser cases pass, covering both settings surfaces, pending/denied/allowed cards, reloads, CLI history and decisions.
- All 10 PB-E Tasks layout and copy-budget cases pass.
- Web production build and server/web typecheck pass.

The optional `tasks-attention-ui.mjs` fails identically on untouched main and this branch at line 237: it expects the old `Pending input could not load.` alert in Bot details, while that page now uses `Could not refresh`. Its first eight cases pass in each run. The existing test is not skipped or changed. The new banner and task/approval navigation are covered separately above.

The complete unit suite has identical results on untouched main and this branch: 2,950 tests, 2,856 passed, 70 failed, 24 existing skips, zero cancelled and zero todo. The 70 failure names match exactly after normalizing Node file-level failures to repository-relative paths. There are no new failure names. See `verification.json` for the names and the full comparison.

Main advanced to `6fa7cf928bf6b4e67699ce126c431fd841608cd7` during verification. That commit adds only `docs/customization/SPEC.md`; application code, tests and dependencies are identical to the measured baseline. The branch was rebased on it, and targeted alignment, primitive, navigation and phone checks were rerun.

After that rebase, all 60 layout cases, 10 primitive cases, 64 phone/desktop views and 308 navigation cases pass again.
