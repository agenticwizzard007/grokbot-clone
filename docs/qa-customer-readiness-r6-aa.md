# Customer readiness R6, stream AA

Scope: R6-2 live composer responsiveness, R6-4 Jump to latest spacing, R6-5 waiting status. Baseline: untouched `5b4265d189728a871d115fee5803aa4840fd8633` in a detached local worktree. All browser work uses local fixtures. No live sign-in or customer data is used.

## Findings and changes

- R6-2: every message's display-text hook subscribed to the complete Bot roster. A preview or presence update therefore bypassed the existing message memoization. The baseline fixture produced 1,800 historical message renders in three seconds, even without new message content. The hook now subscribes to names only and returns a stable cleanup function. Renames still update existing messages. Card rows are memoized as well.
- The composer was rendered by its parent for live state and transcript changes and subscribed to the full model catalog, including usage. It now has a memo boundary for its actual Bot inputs and selects only model-selection data. Draft text already lived in local state with an in-memory draft cache, so that behavior stays immediate. Voice level animation already wrote styles through refs without React state updates. Neither was a confirmed cause.
- Transcript anchoring scanned message rectangles after every live update and recreated its resize observer for every streaming delta. It now keeps the observer, avoids history measurements while following the latest message, and uses a binary search for the reading anchor when scrolled up. Resize observation still handles changes to activity text and the viewport.
- R6-4: the absolute-positioned pill overlapped card content on the baseline at both widths. It now occupies a separate 48px strip below the clipped message viewport. The test checks the entire viewport and visible card text/control rectangles at three scroll positions, plus jumping back to the latest message.
- R6-5: the waiting row used a one-second phrase timer and a 100ms elapsed timer. Those timers updated their own components, not the whole transcript. The waiting row now displays `Needs your input` and `Waiting since <local time>` with a full local date/time tooltip. It has no active clock or spinner. Working phrase rotation is isolated to its text element.

The exact reported 3 to 6 second production delay was not reproduced locally. The baseline did reproduce unnecessary renders and delayed paint opportunities under live load. Baseline input script p95 was 2.4 to 3.9ms, but time through the next paint opportunity reached 160.6ms p95 and 230.2ms maximum. These are browser fixture measurements, not a claim about the authenticated live session.

## Reproduction and regression test

Run `npm run test:composer-live`. To profile unchanged main, set `UI_WEB_ROOT` to the detached checkout's `web` directory and `UI_EVIDENCE` to a separate evidence directory. The regression assertions intentionally fail on the baseline.

`tests/composer-live-performance-ui.mjs` builds the real production app with instrumentation that exists only in the local test build. It runs at 1280 and 390, in light and dark, with normal animations and America/Los_Angeles local time. Each case includes:

- 300 messages, long markdown read into view, and four approval cards including a pending approval.
- SSE live state and a streaming voice follow-up every 250ms, preview/presence and voice captions every 500ms, native refreshes and usage snapshots every second, and voice levels sampled by the real animation-frame loop.
- Idle waiting, passive live updates, 100 typed characters under streaming load, and typing with only the voice meter active.
- Component body render counts, counts per measured interval, keydown-to-committed-value script time, next-frame value checks, and a task after the rendering opportunity to include layout/paint. The last measurement is an upper bound that can include another queued task; it is not an optical display measurement.
- Zero historic message/composer renders for passive updates, zero transcript renders for keystrokes or waiting ticks, preserved draft text across name changes, and updated redacted Bot names.

The gates are p95 input script time below 16ms, next-frame callback below 34ms, time through the paint opportunity below 50ms p95 and 150ms maximum, no full-history rendering during streaming, no pill overlap, and a static waiting timestamp with its date tooltip. Raw render counts, interval durations, browser work totals, timing samples summarized by percentile, and screenshots are saved under `.context/composer-live-performance/`.

## Validation

The first fixed production-build run passed all four cases:

| Width | Theme | Input script p95 | Next frame p95 | Through paint opportunity p95 |
| --- | --- | ---: | ---: | ---: |
| 1280 | Light | 3.1ms | 18.2ms | 36.1ms |
| 1280 | Dark | 3.0ms | 17.9ms | 35.9ms |
| 390 | Light | 3.1ms | 16.0ms | 31.4ms |
| 390 | Dark | 3.2ms | 15.8ms | 29.5ms |

Passive historical-message and composer renders fell from 600/s and 7 to 7.3/s respectively to zero. Transcript renders from keystrokes and waiting ticks are zero. Streaming rendered 18 to 19 changing message rows over 4.4 to 4.8 seconds, with no unchanged card renders. The baseline already memoized markdown parsing; the problem was history row rendering and geometry work, not reparsing every old markdown message.

Full unit failure-name comparison, targeted regression results, post-rebase measurements, and deployment verification are recorded in the PR.
