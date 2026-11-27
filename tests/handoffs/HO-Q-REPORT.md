# HO-Q receipt rows, loop groups and copy

Base and before checkout: `origin/main` at `56e65ba529c6c26d798bc4a4542a5ff2eed38551` (HO-P). Before captures run with `HO_POLISH_PHASE=before` in `.context/ho-q/main`, with the new fixture and capture/audit files copied into that checkout. No implementation files are copied there. Main has no expand control, so its receipt-expanded captures show the original individual receipts.

## Reviewed behavior

- Consecutive handoff receipts with the same loop id become one collapsed Loop row. Messages, exchanges, date dividers, independent handoffs and other loops break groups. The pure grouping function preserves order and input objects.
- The existing loop detail endpoint supplies status and pass counts. Existing loop events, reconnect and resume notifications refresh the summary. Running copy is `Loop, pass 2 of 4`; completed copy is `Loop, 3 passes` with `Completed`. Endpoint response shapes are unchanged.
- Show passes / Hide passes is a 44px chevron button with aria-expanded and aria-controls. View opens the loop run. Expanded passes retain Handed off / Sent, their agent, status, pass chip and handoff View. Repeated pass instructions are available in the handoff detail and the View accessible name.
- Receipt padding is 8px vertically, with a 64px minimum height and 16px between adjacent rows. Passes have an 8px indent. A wrapped agent name at 320 can produce an 80px row. Metadata is 13/18; only chips use 12/16. A narrow group summary may wrap its chips onto two lines.
- Finished message actions use an icon-only 44px overflow control named Message actions. Final outputs continue to provide their existing output actions.
- Outputs copy originates in `server/src/flow/build.ts`. Reports, files and tasks now use exact counts and correct singulars. The cache input hash includes the displayed count copy so existing bucketed models refresh, including `1 reports`. All six Flow goldens are regenerated for these copy hashes; rich also changes to `1 report`, `3 files`, `2 tasks`. The UI consumes these strings directly, so no client-side range parsing is introduced.
- The fixture allocator now prevents selecting the same ephemeral port twice for API, UI and mock server. This fixes a collision observed during captures.

## Default geometry

The pin advances from `e9f28c3` to HO-P main `56e65ba5`, absorbing the already reviewed HO-P and Settings geometry into the baseline. No default view geometry changes are accepted for HO-Q. The old per-view exceptions are removed, and all 208 default views must match exactly, including tokens. The new receipt fixtures are audited separately at 320, 390, 500 and 1280 in both themes. No comparison logic or shared route collector is changed.

## Copy measurements

Visible main-region word counts exclude sidebar and phone tabs. Receipt and expanded-pass text includes work content, which is retained behind the expand control. Message-actions captures include the chat around the finished message.

| Screen | 390 before / after | 1280 before / after |
| --- | --- | --- |
| Receipt grouped | 131 / 64 | 139 / 72 |
| Receipt expanded | 131 / 109 | 139 / 117 |
| Flow Outputs | 120 / 116 | 120 / 116 |
| Message actions | 127 / 57 | 135 / 65 |

## Evidence

All 24 screenshot filenames are in [HO-Q-SHOTS.txt](HO-Q-SHOTS.txt). Images and capture JSON are in `/workspace/swarm-qa/handoffs/shots/polish/`; copies are in `.context/ho-q/shots/`. No image binaries are committed. Logs are in `.context/ho-q/logs/`.

The quality gate adds height, gap, metadata, count-copy and icon-only action assertions, plus collapsed/expanded group behavior, aria-expanded changes, View navigation and a live running-count update at every width and theme. Deliberately broken samples exercise the new gates. Grouping unit tests cover ordering, interleaving, distinct loop ids, live count updates, a standalone receipt, empty input and terminal statuses.

## Verification

| Check | Result | Log in `.context/ho-q/logs/` |
| --- | --- | --- |
| `npm run typecheck` | Both workspaces pass | `typecheck.log` |
| `npm run build -w web` | Pass | `build.log` |
| All handoff and Flow tests, readiness KK and Composio, including integration I | 600 / 600 | `units.log` |
| Demo D | 54 / 54 | `demo-d.log` |
| Demo E | 24 recorded replays, zero failures | `demo-e.log` |
| Demo G | 36 / 36 | `demo-g.log` |
| Demo I | 84 / 84 | `demo-i.log` |
| UI quality | 568 / 568 views, 23 / 23 distinct guards | `quality-phone.log`, `quality-wide.log` |
| Layout alignment | 776 / 776 route views, plus 36 / 36 customization checks | `alignment.log` |
| Default geometry | 208 / 208 exact, zero exceptions or token differences | `defaults-final.log` |
| Navigation | 870 / 870 across five widths and both themes | `navigation-{320,390,500,768,1280}.log` |
| Final receipt/list focus | 40 / 40, after preserving list Loop links | `quality-final-focus.log` |
| Screenshots | 12 before + 12 after | `before.log`, `after.log` |

Quality runs in two width batches (`HO_WIDTHS=320,390` and `500,1280`) with separate output directories; both include light and dark and run every screen and guard. The combined report has 568 unique view keys and zero issues. Navigation runs one width at a time after the web build, covering all five requested sizes and both themes. Its initial ten-context process was killed with exit 137 while several browser suites were running; the bounded rerun uses the unchanged navigation checks.

Final result: no new failures against main. All required matrices completed; screenshots and the final 40-view receipt/list audit use the reviewed row layout.

## Main integration after owner review

Merged main `bfe30f869b0e052d47dd28b97471164741901505` after UC-X2 #278 and FIX-4 #281. The only conflict was the default baseline JSON. Resolution starts with main and reapplies Q's pin and notes, pinning main `bfe30f86` so its reviewed UC-X2 geometry is included directly. The 26 former rectangle exceptions are already represented by that main commit; Q requests zero new geometry exceptions and all 208 views must match exactly. All 48 other incoming files are byte-identical to main. The original verification table above records the pre-merge owner-reviewed run.

Merge rerun logs are in `.context/ho-q/merge-main/logs/`. Typecheck and web build pass. Handoff unit tests pass 230/230, including the new FIX-4 coverage and grouping tests; a separate grouping rerun passes 8/8. Demo I reproduces main's known stale `New dashboard` assertion at `tests/handoffs/demo-i.mjs:225` (expected 1, actual 0). Its file is unchanged; FIX-5 owns that correction. The failure log records 67 completed PASS lines and does not write a fresh success report.

| Merge validation | Result |
| --- | --- |
| Typecheck and web build | Pass |
| Handoff unit tests | 230/230 |
| Separate group-receipts rerun | 8/8, also included in the 230 |
| UI quality | 568/568 unique views, 23/23 distinct guards |
| Default geometry | 208/208 exact, zero reviewed exceptions or token differences |
| Layout alignment | 818/818 route views, plus 36/36 customization checks |
| Navigation | 870/870, five widths and both themes |
| Demo I | Known main failure at the stale New dashboard label, unchanged for FIX-5 |

Layout includes the 42 new UC-X2 dashboard views alongside 208 standard and 568 handoff views. Navigation ran one width at a time; the first 390 run hit a menu-dismissal timeout, and its unchanged rerun passed all 174 cases. Both logs are retained. The original owner-reviewed captures remain valid because Q's application code is unchanged by this merge.
