# PB-A: Paper foundation

Implements P1 to P4 against Paper v2. Tokens match the table in BUILD-SPEC.md. Provider marks reserve 16 x 16 px, including loading; Claude stays #D97757 in both themes. Swarm marks use the supplied flock and wordmark assets. The working flock pulses the official artwork and respects reduced motion.

The composer uses one row above 480 px and two rows at or below 480 px, independent of draft length. Heights are 52/84 px plus 24 px per additional line, capped at six lines with internal scrolling. Phone chips retain a complete model family and effort. The picker uses a 340 px popover or a phone sheet, grouped billing, supported effort segments, and concise details. Close, Escape and system Back return focus; settings actions wait for the sheet history entry to close.

## Design verification

The supplied v2 archive SHA256 is `61e10c0453ad0b657fbe95173d4de361f5fe45b34b6ec2aa622c7bca41b67ab5`. Five empty-string expressions used single quotes inside single-quoted f-strings. Those expressions now use double quotes so the same HTML renders on this VM's Python 3.9. All 132 references render.

The generator uses desktop composer padding 8 px plus a border and 36 px controls, producing 54 px. Binding rule 0.1 requires 52 px. The implementation uses 7 px vertical padding to satisfy the binding height, then grows exactly 24 px per line. The phone reference and implementation both use 84 px. Phone input text uses 16 px to retain the existing iOS focus-zoom fix; line height stays 24 px.

`comparison-*.png` shows the Paper and app composers together. Full screen evidence covers empty, one line, three lines, six lines with scrolling, and picker open at 320, 390 and 1280 in both themes. The surrounding shell, thread and settings layouts belong to the other Paper streams. Reference-only screens are kept under `.context/paper-reference`.

## Copy counts

Counts use the same isolated fixture before and after, without sidebar or phone tab text. No live account was accessed. See `copy-counts.json` for text and counting details.

| Region | Before 1280 / 390 | After 1280 / 390 |
| --- | --- | --- |
| Composer including note | 6 / 3 | 8 / 6 |
| Open picker | 29 / 25 | 20 / 23 |
| Main with picker closed | 29 / 25 | 31 / 28 |
| Main with picker open | 58 / 50 | 51 / 51 |

The composer gains the required four-word safety note, which was absent on main. The picker removes repeated plan explanations and duplicate effort controls while exposing supported effort levels. Its 20/23-word limits match the Paper v2 picker addition; the full main region stays below the v2 chat and picker budgets. This stream does not claim a 70 percent reduction in the already short composer fixture.

## Intentional regression-test updates

Existing one-row phone and effort-flyout assertions now check the approved fixed two-row phone composer and inline effort segments. Tests retain provider status, missing metadata, stale quotas, failed-save rollback, keyboard cycling, motion, reduced motion, settings navigation and focus assertions. Loading tests preserve the recoverable-loading behavior already on main. Working-artwork tests check the official static SVG with CSS animation. Processing geometry waits for the cleared one-line field and measures message positions in content coordinates so normal transcript scrolling is not treated as a layout shift.

## Validation

See `validation.json` for completed checks and the baseline comparison. `baseline-failures.json` records the untouched-main failure names. Existing environment-gated skips are unchanged; no tests or workflows were disabled.
