# Chat open performance

Issue identifier: chat-open performance report, 2026-11-24 02:58 Asia/Dubai. The brief supplied no numeric issue ID, and repository issues are disabled.

Expected: a chat frame within 300 ms, latest messages within 3,000 ms cold and 1,500 ms warm, with earlier history loaded on demand. Reported behavior: about 14 seconds before a phone chat was usable.

## Local measurement

The before profile used main commit `3fbca49d3bd4807d70dc3e267b4dd49097af0813`. Both profiles used the same deterministic Bot fixture: 720 rows, alternating user messages, roughly 54 KB tool-call bodies, and assistant markdown with lists, links, and code blocks. Each run uses a temporary SQLite database, a real DEV_LOGIN session, local mocked model backends, and a production web build. No live app or production data was used.

Chromium runs at widths 390 and 1280 with 80 ms latency, 500,000 bytes/s download, 125,000 bytes/s upload, and 4x CPU throttling. Timing starts at the actual conversation-row click. The shell measurement requires a visible header and composer; the message measurement requires the latest row to intersect the transcript viewport. Cold means the first open after a fresh document; warm means the second open in the same browser context.

| Viewport | Session | Before shell / message (ms) | After shell / message (ms) |
| --- | --- | ---: | ---: |
| 390 | cold | 2014 / 10743 | 28 / 2649 |
| 390 | warm | 189 / 189 | 35 / 35 |
| 1280 | cold | 1981 / 9912 | 45 / 2135 |
| 1280 | warm | 198 / 198 | 35 / 35 |

## Measured causes

- The old first page contained 200 rows and 3,745,007 response bytes. Its cold network duration was 9,604 ms at 390 px and 8,858 ms at 1280 px. It was already paginated, but the initial window was too large for substantial tool bodies.
- The ChatView chunk was 48.36 KB, with a static 165.31 KB markdown dependency. Assistant markdown ran for all 67 assistant messages in that page. The response-complete to first-message interval was about one second, including JSON processing, React rendering, and layout. This interval is not an isolated markdown benchmark.
- Latest and older row queries already used `sqlite_autoindex_rows_1` with a bounded LIMIT. No per-row query loop was needed for the history response. The largest measured first-page SQLite select was 1.681 ms; network transfer and rendering dominated.
- Setup repair ran on the first-page path and performed full Bot-history candidate scans before JSON filtering. Its question scan peaked at 7.293 ms. This was a secondary cost. Repair now remains on activation and roster/setup reads, with a partial card index; the observed question scan maximum fell to 0.061 ms. The first-page handler performs no repair or JSON scan.
- Routines and mark-read already start independently. Exchanges begin after history loads but do not block message rendering. SSE starts at shell boot, not at the chat click; neither its connection nor reconnect is a render prerequisite. Model loading is independent, Details has its own lazy boundary, and no plan or connection-detail request gates the latest page.

The new first response is 447,242 bytes, an 88% reduction. The following phone waterfall entries include browser queueing and transfer time. Every request shown completed with status 200; API timings are not presented as server-only execution times.

| Request | Before duration (ms) / bytes | After duration (ms) / bytes |
| --- | ---: | ---: |
| Latest rows | 9604 / 3,745,007 | 2559 / 447,242 |
| Routines | 1357 / 15 | 1071 / 15 |
| Mark read | 1452 / 11 | 1088 / 11 |
| Attention summary | 1184 / 12 | 862 / 12 |
| Models | 173 / 640 | 411 / 640 |
| Exchanges | 87 / 34 | 90 / 34 |

The full request-by-request JSON also includes asset transfers, warm navigation, and the explicit older-page fetch. The latter still returns up to 200 rows, and is requested only when the reader scrolls up or selects the earlier-messages button.

## Changes

The eager chat skeleton shows the header, transcript frame, and composer while ChatView loads. The first history request explicitly asks for 24 rows and returns an older cursor. Scrolling to the top fetches the previous 200-row window; the existing button, retry, reading-position preservation, and deep search remain available.

Markdown now has a separate lazy renderer, with plain text available immediately. Rich formatting starts near the viewport. Resize observation preserves the latest-message position and the reader's anchor as formatting changes heights. The renderer is 164.31 KB and no longer blocks the chat route. The rebased ChatView chunk is 49.57 KB.

Reconnect publishes the latest page immediately, then requests only changed revisions in the previously opened range. Recovery pages have a 200-row LIMIT and use `rows_rev`; unchanged cached history is not downloaded again. A completed revision watermark advances only after recovery succeeds. Generation changes, departed accounts, newer streamed revisions, failure/retry, empty-history bursts, and a 5,001-row missed burst are covered.

`rows_cards(bot_id, generation, created_at) WHERE kind='card'` is created with `IF NOT EXISTS`. Query-plan tests verify both existing history/revision indexes and this additive index. No data rewrite or paid infrastructure change is required.

## Validation and artifacts

Run `npm ci && npm run typecheck`, then `npm run test:chat-open`. The performance test enforces the actual 300/1,500/3,000 ms limits at both widths; it has no baseline mode that disables assertions. It also holds the chat chunk, SSE, models, routines, and exchanges to check that non-critical work cannot gate the shell or messages. It scrolls up to verify history loading.

Local results: clean install and both typechecks pass; 84 unit/API tests and five event-stream tests pass. The performance checks pass at both widths, including held-dependency checks. Additional existing tests cover setup, API behavior, session boot, store state, pagination/search/retry/cancellation at 390, 768, 1024, and 1280 px, and the event-stream reconnect and slow-reader behavior from #176.

The local profile writes request-by-request network waterfalls with durations, status codes, and response sizes, SQL statement timings without parameters or row contents, EXPLAIN QUERY PLAN results, timing JSON, and screenshots under `.context/chat-open/`. The before and after profiles are separate directories.

`fly.toml` is unchanged. Its existing settings keep auto-stop off and at least one machine running. No Fly logs or live session were accessed, no machine size/count was changed, and no manual deployment was run.
