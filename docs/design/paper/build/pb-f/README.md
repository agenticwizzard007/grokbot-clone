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
