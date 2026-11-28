# HO-Q2 loop titles and message actions

Base and before checkout: main `949624b07c48ae93b7cdd57882c9fd7923684ae7`, including merged HO-Q #280. Work is on `ho-q2-nits`. Before captures use `.context/ho-q2/main` with only the updated polish fixture and capture script copied in, and `HO_POLISH_PHASE=before`. Both phases show the same seeded loop, independent handoff and output card.

## Reviewed behavior

- Group titles preserve the complete task name. Empty names and the generic placeholders Loop, Agent loop, New loop and Untitled loop use the maker and checker names, in role order: Coordinator and Research loop. Missing agent records use the role labels Maker or Checker. Names wrap without truncation.
- Chips contain only the pass count: 3 passes, or Pass 2 of 4 while running. The separate status remains Completed, Running, Stopped, Capped or Failed. Existing API responses are unchanged.
- The expand control names its loop: Show passes for Coordinator and Research loop, switching to Hide passes when expanded. Its 44px target, aria-expanded, aria-controls and collapsed default remain intact.
- Finished-message Copy and Message actions share one footer with an 8px gap between their 44px targets. Copy is visible in that footer. The overflow sits outside the bubble's paint containment, so its menu remains usable. The menu aligns with the message's left edge on narrow screens.
- The message-to-control gap stays 8px. The control-to-next-element gap changes from 24px to 8px. The overflow adds no separate row below the copy footer. These measurements use the controls' complete touch bounds.
- The default baseline pin and its reviewed UC-X2 geometry are unchanged. No new default-view exceptions are requested. FIX-5's Bot Activity work and the known demo-I New dashboard assertion are outside this change.

## Evidence and guards

The quality matrix adds named, long task-name and long agent-name receipts at 320, 390, 500 and 1280 in both themes. It verifies full titles, pass-only chips, live running counts, loop-specific expand labels, pass visibility and View navigation. The message checks verify both vertical gaps, Copy alignment, keyboard menu opening, Escape dismissal and focus return. Deliberately broken titles, chips, labels, truncation and gaps prove the guards reject regressions.

The 80px receipt-height cap applies to rows with one title and metadata line. Complete loop or agent names can require more title lines, including within expanded passes; only the measured extra title-line height is added to that cap. An artificially oversized wrapped row is also rejected by a guard. The common fallback title wraps at 390, producing an 81px row, and at 320 its chips also wrap. All target, typography, overflow and alignment checks remain active.

Twenty screenshot filenames are listed in [HO-Q2-SHOTS.txt](HO-Q2-SHOTS.txt). Images are in `/workspace/swarm-qa/handoffs/shots/polish/` and `.context/ho-q2/shots/`, with suffixes `-q2-before` and `-q2-after`. Receipts are captured at 320, 390, 500 and 1280; message actions at 390 and 1280. Logs and JSON evidence are under `.context/ho-q2/`.

| Main-region words | 390 before / after | 1280 before / after |
| --- | --- | --- |
| Receipt grouped | 64 / 66 | 72 / 74 |
| Receipt expanded | 109 / 111 | 117 / 119 |
| Message actions | 57 / 58 | 65 / 66 |

The small copy increase is the requested descriptive loop title. No helper text is added.

## Verification

| Check | Result | Log in `.context/ho-q2/logs/` |
| --- | --- | --- |
| Typecheck | Both workspaces pass | `typecheck.log` |
| Web build | Pass | `build-final.log` |
| All handoff and Flow tests, readiness KK and Composio, including integration I | 611/611 | `units.log` |
| Grouping and titles, separate focused run | 11/11, also included above | `group-receipts.log` |
| Demo D | 54/54 | `demo-d.log` |
| Demo E | 24 recorded replays, zero failures | `demo-e.log` |
| Demo G | 36/36 | `demo-g.log` |
| Demo I | Known main failure: New dashboard at line 225, expected 1, actual 0; 67 prior PASS lines | `demo-i.log` |
| Default geometry | 208/208 exact, zero reviewed exceptions or token differences | `defaults.log` |
| UI quality | 592/592 unique views and 31/31 guard cases | `quality.log` |
| Layout alignment | 842/842 route views, plus 42/42 customization checks | `alignment.log` |
| Navigation | 870/870, five widths and both themes | `navigation-{320,390,500,768,1280}.log` |
| Screenshots | 10 before + 10 after | `before.log`, `after.log` |

Layout includes 208 standard views, 42 UC-X2 dashboard views and 592 handoff views. Navigation ran one width at a time after the final web build; all five runs passed without retry. Demo I is unchanged from main and FIX-5 owns its stale label assertion. Its old success report is not used as evidence for this run. No new failures remain against the starting main commit.
