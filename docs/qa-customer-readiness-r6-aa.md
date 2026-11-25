# Customer readiness R6, stream AA

Scope: R6-2 live composer responsiveness, R6-4 Jump to latest spacing, R6-5 waiting status. Baseline: untouched `5b4265d189728a871d115fee5803aa4840fd8633` in a detached local worktree. All browser work uses local fixtures. No live sign-in or customer data is used.

## Findings and changes

- R6-2: every message's display-text hook subscribed to the complete Bot roster. A preview or presence update therefore bypassed the existing message memoization. The baseline fixture produced 1,800 historical message renders in three seconds, even without new message content. The hook now subscribes to names only and returns a stable cleanup function. Renames still update existing messages. Card rows are memoized as well.
- The composer was rendered by its parent for live state and transcript changes and subscribed to the full model catalog, including usage. It now has a memo boundary for its actual Bot inputs and selects only model-selection data. Draft text already lived in local state with an in-memory draft cache, so that behavior stays immediate. Voice level animation already wrote styles through refs without React state updates. Neither was a confirmed cause.
- Transcript anchoring scanned message rectangles after every live update and recreated its resize observer for every streaming delta. It now keeps the observer, avoids history measurements while following the latest message, and uses a binary search for the reading anchor when scrolled up. Resize observation still handles changes to activity text and the viewport.
- A browser trace of read markdown history showed document layouts with about 48,000 layout objects during typing. The transcript now contains its layout and paint work, and message rows use browser-managed offscreen rendering after recording their exact heights. Messages remain in the DOM for search and accessibility.
- R6-4: the absolute-positioned pill overlapped card content on the baseline at both widths. It now occupies a separate 48px strip below the clipped message viewport. The test checks the entire viewport and visible card text/control rectangles at three scroll positions, plus jumping back to the latest message.
- R6-5: the waiting row used a one-second phrase timer and a 100ms elapsed timer. Those timers updated their own components, not the whole transcript. The waiting row now displays `Needs your input` and `Waiting since <local time>` with a full local date/time tooltip. It has no active clock or spinner. Working phrase rotation is isolated to its text element.

The exact reported 3 to 6 second production delay was not reproduced locally. The baseline did reproduce unnecessary renders and presentation delays under live load: Event Timing p95 was 56ms on desktop and 48ms on phones, while input script p95 was already 3.0 to 3.7ms. These are browser fixture measurements, not a claim about the authenticated live session. A task scheduled after requestAnimationFrame sometimes ran after presentation and overstated paint latency, so the final test uses the browser's Event Timing API for presentation.

## Reproduction and regression test

Run `npm run test:composer-live`. To profile unchanged main, set `UI_WEB_ROOT` to the detached checkout's `web` directory and `UI_EVIDENCE` to a separate evidence directory. The regression assertions intentionally fail on the baseline.

`tests/composer-live-performance-ui.mjs` builds the real production app with instrumentation that exists only in the local test build. It runs at 1280 and 390, in light and dark, with normal animations and America/Los_Angeles local time. Each case includes:

- 300 messages, long markdown read into view, and four approval cards including a pending approval.
- SSE live state and a streaming voice follow-up every 250ms, preview/presence and voice captions every 500ms, native refreshes and usage snapshots every second, and voice levels sampled by the real animation-frame loop.
- Idle waiting, passive live updates, 100 typed characters under streaming load, and typing with only the voice meter active.
- Component body render counts and rates, queued input delay, script time to commit the value, next-frame value checks, and Event Timing presentation latency. Event Timing uses 8ms buckets; events below its minimum 16ms reporting threshold are conservatively counted as 16ms.
- Zero historic message/composer renders for passive updates, zero transcript renders for keystrokes or waiting ticks, preserved draft text across name changes, and updated redacted Bot names.

The gates are p95 input script time below 16ms, next-frame callback below 34ms, Event Timing presentation below 50ms p95 and 150ms maximum, no full-history rendering during streaming, no pill overlap, and a static waiting timestamp with its date tooltip. Raw render counts, interval durations, browser work totals, timing samples summarized by percentile, and screenshots are saved under `.context/composer-live-performance/`.

## Validation

Final production-build measurements, full unit failure-name comparison, targeted regression results, and deployment verification are recorded in the PR. Passive historical-message and composer renders fell from about 600/s and 7/s respectively to zero. Transcript renders from keystrokes and waiting ticks are zero. Streaming updates render the changing message, with no unchanged card renders. The baseline already memoized markdown parsing; the problem was history row rendering and geometry work, not reparsing every old markdown message.

The final offscreen-history profile passed all four cases:

| Width | Theme | Input script p95 | Event Timing presentation p95 | Maximum presentation |
| --- | --- | ---: | ---: | ---: |
| 1280 | Light | 3.0ms | 32ms | 40ms |
| 1280 | Dark | 3.2ms | 40ms | 48ms |
| 390 | Light | 4.4ms | 48ms | 56ms |
| 390 | Dark | 3.1ms | 48ms | 48ms |

This meets the requested sub-16ms script budget. Event Timing includes input queueing and presentation, and does not establish a literal sub-16ms physical-display latency on this VM.

Existing composer growth/performance, model loading, voice status, long identifiers, transcript pagination/search/anchoring, and chat-open checks pass. The pagination check includes 1280, 1024, 768, and 390 widths. The new loaded-chat check covers both requested widths and themes. Typecheck and the production build pass. Integration with the parallel model-recovery changes also passes 97 targeted unit tests and all four model-loading/recovery browser cases.

The complete unit command is `node --import tsx --test --test-reporter=tap --test-concurrency=1 tests/*.test.mts tests/*.test.mjs`. Untouched baseline and branch each report 2,328 tests: 2,232 pass, 72 fail, and 24 existing skips. One failure name differs between the complete runs; the exact branch timeout also reproduces on untouched baseline in the unchanged full test file, leaving no new failure names. The supplemental baseline file reports 11 pass and 2 fail, matching the branch rerun. Raw full-run logs and the supplemental baseline reproduction are retained separately in `.context/`.

Two existing browser failures reproduce on untouched `5b4265d`: `effort-animation-ui.mjs` cannot find `.mm-item__value.is-ultracode`, and `voice-entry-ui.mjs` fails `dictation never competes with another agent call`. Chat-open's throttled shell deadline was intermittent on baseline and branch; the final original test passes both widths without changes to its assertions. The one-second `cloud drain rechecks authorization after inventory waits and never issues a revoked stop` unit deadline also reproduces in the complete unchanged `legacy-background.test.mts` file on the baseline. None of these unrelated tests or their assertions were changed.
