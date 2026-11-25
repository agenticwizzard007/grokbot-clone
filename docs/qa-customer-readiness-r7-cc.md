# Customer readiness round 7, stream CC

All checks used local fixtures. No live sign-in or customer data was used. Baseline source: d8602e918fa606094002b4eaa2ca63a92d84a3f4, in an untouched detached worktree on this VM.

## R6-2: typing latency and main-thread audit

Settings > General > Typing diagnostics and `window.__swarmInputLatency()` report p50, p95, session maximum, session sample count and rolling window size. The last 256 durations stay in memory. There are no keys, message contents, account identifiers, persistence or network writes in the meter. Account changes clear the session. There is no idle timer or React update per input. The panel refreshes on open or on demand.

The meter correlates composer keydown timestamps with beforeinput and Event Timing entries with interaction IDs where supported. Event Timing has 8 ms rounding and a minimum reporting threshold of 16 ms. Eligible interactions below that threshold conservatively count as 16 ms. IME, mobile input without keydown, and browsers without Event Timing use requestAnimationFrame followed by a zero-delay task. Hidden-tab samples are discarded and listeners are removed on unmount. The UI describes the estimate and reporting floor.

Production Playwright fixture: 320 already-read messages with long Markdown, no pending card, streaming reply plus live/presence/computer events every 100 ms, native invalidations every second. Each case types a 59-character sentence with `page.keyboard.type`, at delay 0 and delay 20 ms. The DOM must contain all 59 characters immediately after typing, every input must commit the expected prefix, and no PerformanceObserver longtask may occur during typing. Two widths and both themes give 472 measured keys per build.

| Width | Theme | Delay ms | Baseline paint p50/p95/max ms | Changed paint p50/p95/max ms | Changed script p95 ms | Long tasks, both builds |
| --- | --- | ---: | --- | --- | ---: | ---: |
| 1280 | light | 0 | 16/24/24 | 16/16/24 | 0.5 | 0 |
| 1280 | light | 20 | 16/16/16 | 16/16/24 | 0.8 | 0 |
| 1280 | dark | 0 | 16/16/24 | 16/24/24 | 0.6 | 0 |
| 1280 | dark | 20 | 16/16/16 | 16/16/24 | 0.7 | 0 |
| 390 | light | 0 | 16/24/24 | 16/24/24 | 0.7 | 0 |
| 390 | light | 20 | 16/16/16 | 16/16/16 | 0.8 | 0 |
| 390 | dark | 0 | 16/16/24 | 16/24/24 | 0.6 | 0 |
| 390 | dark | 20 | 16/16/16 | 16/16/16 | 0.7 | 0 |

The zero-delay sentences completed in 166 to 190 ms in the changed build; 20 ms delay completed in 1318 to 1337 ms. Each DOM value was complete immediately after typing. The reported two-second empty DOM and 16 characters/second growth were not reproduced. The fixture supports an automation/probing artifact as a possibility, not a proven diagnosis of the live tester's result.

An independent frame-plus-task probe exaggerated zero-delay latency: p95 162 to 180 ms despite Event Timing p95 16 to 24 ms. Continuous automated input can defer timer tasks while the browser continues presenting frames. This is why the meter prefers Event Timing and discloses the fallback. At 20 ms input spacing, the frame-plus-task p95 was 18 to 19 ms. Raw local evidence is in `.context/input-latency{,-baseline}/results.json`.

Code audit:

- Draft updates set component state and a Map entry. Storage is used only for an unacknowledged send, before POST, not per input. No synchronous serialization of a large draft occurs on typing.
- There is no mention or slash autocomplete parser on the composer input path. Model search filtering is confined to the model menu search field.
- Autosize already uses two mounted, contained measuring fields, cached geometry, and one coalesced animation-frame layout. It does not insert measuring nodes or scan the transcript per key.
- Modifier shortcut handlers return early for plain typing. Enter checks isComposing before sending; composition Enter regression coverage confirms the draft remains.
- SSE updates preserve prior message bodies and the composer has narrow memoized identity fields. The earlier live/voice fixture is rerun to check that keystrokes and voice meter updates do not render historical messages.
- No main-thread long task was observed in the requested typing cases. No speculative typing-path rewrite was made.

## R7-3: suggestions

The previous cache matched a complete draft plus connection/setup revisions and existed only in memory. Returning with a changed revision or reloading therefore showed Finding relevant apps immediately, even if this Bot already had useful suggestions. A versioned, account-scoped per-Bot last-result cache now survives reloads in sessionStorage. Rendering reads it synchronously, while requests continue quietly in the background. Only a true cold cache shows loading, after 500 ms. Existing bounded deadlines, debouncing, retry, version rejection and late-response/account isolation remain covered. Old responses cannot overwrite a newer Bot snapshot. Sign-out/account changes clear the prior account's snapshot.

## R7-4: plural copy

A small shared plural helper replaces user update(s), viewer(s), and report source revision(s), including singular verb agreement in generated report text. UI coverage checks 1 user update and 4 user updates. Source scanning checks UI string/template/JSX literals. Remaining matches in the full web/server grep are function calls, http(s), third-party license text and server-only provisioning/inbox logs, not customer count labels. CLI files were left alone.

## R7-5: navigation and footer

Bots previously rendered a history-derived Back label in the sidebar. Unscoped work tabs and Settings index also exposed Back controls. These top-level screens now omit those controls. Scoped work, Bot settings, app settings sections, routine history and other nested screens retain their parent controls. History entries and Back/Forward behavior are unchanged.

The usage footer previously rendered Previously loaded and Refreshing as soon as cached data was used. It now retains the stale value silently for two seconds, shows the note for longer refreshes, and preserves Retry on failure.

The new production fixture checks 1280 and 390 widths in light and dark: Bots to Settings index to Bots to chat to Bot settings, then Back and Forward across every entry; top-level Tasks, Team, Goals and Reports; cold/warm/reloaded suggestions; fast and slow usage refresh; Retry; Team pluralization; and horizontal overflow. Existing navigation/history fixtures retain nested Back, collapsed sidebar, deep-link, keyboard and route-title coverage, with top-level expectations updated to the new requirement.

## Reproduction

- `npm run test:input-latency`
- `npm run test:readiness-cc`
- `UI_BASELINE=1 UI_WEB_ROOT=.context/baseline/web UI_EVIDENCE=.context/input-latency-baseline node tests/input-latency-ui.mjs`
- `node --import tsx --test --test-concurrency=1 tests/*.test.mts tests/*.test.mjs`
- `node tests/suggested-integrations-ui.mjs`
- `node tests/customer-readiness-s-ui.mjs`
- `node tests/navigation-history-ui.mjs`
- `node tests/navigation-routes-ui.mjs`
- `node tests/composer-live-performance-ui.mjs`
- `node tests/composer-performance-ui.mjs`
- `node tests/composer-model-loading-ui.mjs`

Screenshots and detailed logs are under `.context/`. Full-suite baseline comparison and merge/deployment revisions are reported with the PR.
