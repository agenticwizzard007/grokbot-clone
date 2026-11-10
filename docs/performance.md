# Latency

Measure click-to-feedback, time to first model output, each tool step, and computer input-to-frame separately. A faster viewer cannot speed up model inference, and changing the model does not fix a busy browser main thread.

## Changes in this workspace

| Path | Previous behavior | Updated behavior |
| --- | --- | --- |
| Screenshot tool | Always waits 700 ms | Captures immediately when no action preceded it |
| Computer actions | Reacquires the screen and waits 700 ms before a screenshot | Reuses the same screen and waits 150 ms by default |
| Cloud desktop navigation | Adds 2.5 seconds after Playwright has already waited for navigation | Skips that redundant wait when Playwright is available |
| Desktop viewer | Capture target of 2 fps | Target of 8 fps, with obsolete frames dropped when the companion connection is congested |
| Connected apps in model context | Lists accounts for every model step | Shares concurrent lookups and caches prompt context for 30 seconds; management/connection checks remain fresh |
| App tool schemas | Fetches on every agent turn | Shared per cached user session; retried after failure and invalidated with the session |
| Model catalog | Cold or expired requests can each block for 20 seconds | Shared fetch, startup warm-up, 5-second timeout, stale refresh, 30-second outage backoff |
| Model preparation | History compaction, prompt and metadata awaited sequentially | Independent preparation runs concurrently |
| Web app | Loads settings and overlays at startup | Loads settings, modals and computer viewer on demand; fingerprinted bundles have immutable caching |
| Thumbnail | Starts another capture every 4 seconds even if the previous request is pending | One request at a time; aborts on unmount and pauses while the viewer is open |
| Streaming UI | Parent UI changes rerender the transcript; each SSE wake leaves a heartbeat timer | Memoized transcript and cancellable heartbeat waits |

Computer actions still execute in order and return a fresh screenshot. The 150 ms pause is a rendering allowance, not proof that a page has finished loading. For web tasks, use the existing Playwright `browser_*` tools and explicit readiness checks. Slow desktop applications may need `COMPUTER_SETTLE_MS=700` (or a follow-up observation). The companion still waits when opening a native desktop browser without Playwright.

`SWARM_VIEWER_FPS` belongs to the **companion process**, not just the API server. `--viewer-fps` overrides it. Captures remain sequential and actual FPS depends on capture time, CPU and bandwidth. Higher rates increase CPU and bandwidth usage. Existing companions need to restart with the updated script; cloud VM companions fetch it at boot.

## Validation

In an isolated local server with a mock model and real Chrome:

- All 19 existing local-computer integration scenarios passed, including navigation, typing, scrolling, browser safety checks, screenshots, live viewer and take-control.
- A real Xvfb desktop companion produced **7.98 fps** in a local capture test (18 frames), compared with the previous 2 fps cap. This does not include a WAN or a loaded multi-Bot VM.
- Opening a test form, clicking a field, typing and submitting completed in about **0.93 seconds**. This includes local tool round trips, but does not measure production inference or WAN latency.
- Initial JavaScript payload decreased from **663.54 KB to 535.51 KB (19.3%)**, measured from the production build and browser resource entries. Deferred chunks still download when used.
- An isolated screenshot-provider test took 0.3 ms for a read and about 903 ms for six actions; the old unconditional waits alone were 700 ms and 4,200 ms respectively. These are application-overhead checks, not real screenshot capture timings.
- Cache regression tests cover concurrent callers, user isolation, invalidation, expiration, failures and stale metadata refresh.

Run `npm run typecheck`, `npm run build`, and `node --import tsx --test tests/latency.test.mts tests/composio.test.mts`. The existing `tests/local-computer.mjs` suite requires an isolated server pointing at `tests/mock-provider.mjs`; see its setup comments.

## Measuring production

Enable `SWARM_LOG_LATENCY=1` on the server. `[latency]` JSON records contain duration in milliseconds and a Bot ID, plus model or tool name where applicable:

- `queue`: time waiting for the Bot's previous turn.
- `tools_prepare`: tool schema preparation.
- `model_prepare`: history/compaction, prompt and metadata preparation.
- `model_first_text`: provider request to first text delta (tool-only responses have no text delta).
- `model_complete`: provider request to completed response, including server-side tools and streaming.
- `tool`: each executed tool, including its screenshot if applicable.
- `turn`: whole turn after leaving the queue.

Logs contain no prompts, tool arguments, responses or credentials. API responses also expose `Server-Timing: app;dur=...` for server handling time. It excludes network transfer and does not measure browser rendering. Streaming events are excluded from this header.

Compare p50 and p95 for warm chat, first request after VM sleep, desktop input and multi-step browser tasks. Record provider/model, reasoning effort, input tokens, region, CPU and active Bot count with each benchmark. Example targets to validate: local UI feedback under 100 ms, warm API handling under 100 ms, remote control feedback under 250 ms, and first model text under 1–2 seconds for simple requests. These are targets, not measured production guarantees.

## Next deployment decisions

1. **Model inference:** if `model_first_text` dominates, benchmark a faster vision/tool-capable model and lower reasoning effort for routine tasks using the existing Bot settings. Keep more capable reasoning for difficult work. Measure task success as well as speed; no model settings were changed by this patch.
2. **VM wake-up:** the checked-in Fly configuration sleeps user VMs after 5 idle minutes. A 15–30 minute idle window can reduce repeated wakes at additional cost. Keep active workflows warm; don't create a VM merely to load a chat page.
3. **CPU contention:** the app currently requests one shared CPU and 1 GB RAM. If event-loop delays or CPU saturation rise with concurrent Bots, benchmark a dedicated CPU/larger machine. Desktop capture at 8 fps also needs capacity on each user's VM.
4. **Geography:** the app and VM are configured in `iad`. Measure user-to-app and app-to-VM latency before choosing a closer region; keep those services close together and plan SQLite ownership before adding multiple app replicas.
5. **Long computer sessions:** if capture and bandwidth still dominate, replace per-frame screenshot processes/base64 JPEG transport with a persistent video encoder and a low-latency video transport such as WebRTC. That requires a separate protocol change and cross-platform testing.

These infrastructure/model changes have not been deployed or benchmarked against live provider accounts.
