# Latency

Measure click-to-feedback, time to first model output, each tool step, and computer input-to-frame separately. A faster viewer cannot speed up model inference, and changing the model does not fix a busy browser main thread.

## Changes in this workspace

| Path | Previous behavior | Updated behavior |
| --- | --- | --- |
| Screenshot tool | Always waits 700 ms | Captures immediately when no action preceded it |
| Computer actions | Reacquires the screen and waits 700 ms before a screenshot | Reuses the same screen and waits 150 ms by default |
| Cloud desktop navigation | Adds 2.5 seconds after Playwright has already waited for navigation | Skips that redundant wait when Playwright is available |
| Desktop viewer | One screenshot process per frame, originally capped at 2 fps | One low-priority FFmpeg encoder per watched Linux display: 1080p at 20 fps, sharing a 20 fps VM-wide budget and prioritizing screens under human control |
| Frame transport | Base64 JPEG inside JSON | Negotiated binary JPEG transport; one pending viewer update and latest-frame replacement under congestion |
| Playwright actions | Default 500 ms settling allowance, then sometimes a second snapshot call | 150 ms settling allowance, reading the snapshot already produced by the action |
| VM readiness | 500 ms companion polling; manual wake after opening the viewer | Immediate connection notification; opening a cloud viewer automatically wakes the VM |
| Connected apps in model context | Lists accounts for every model step | Shares concurrent lookups and caches prompt context for 30 seconds; management/connection checks remain fresh |
| App tool schemas | Fetches on every agent turn | Shared per cached user session; retried after failure and invalidated with the session |
| Model catalog | Cold or expired requests can each block for 20 seconds | Shared fetch, startup warm-up, 5-second timeout, stale refresh, 30-second outage backoff |
| Model preparation | Tool schemas, history compaction, prompt and metadata awaited sequentially | Independent preparation runs concurrently, including tool schemas |
| Model context | Repeated identical page snapshots and a changing timestamp before reusable instructions | Duplicate snapshots reference their latest copy; all unique observations remain; timestamp comes last to preserve a reusable prompt prefix |
| Text streaming | Buffered text waits for another provider event to flush | Pending deltas flush within 75 ms even while the provider pauses |
| Web app | Loads settings and overlays at startup | Loads settings, modals and computer viewer on demand; fingerprinted bundles have immutable caching |
| Hidden viewer | Continues streaming and keeping the VM awake in a background tab | Disconnects while hidden; reconnects and wakes the VM if needed when visible again |
| Thumbnail | Starts another capture every 4 seconds even if the previous request is pending | One preview when shown or after closing the viewer; no polling, no hidden-tab captures |
| Streaming UI | Parent UI changes rerender the transcript; each SSE wake leaves a heartbeat timer | Memoized transcript and cancellable heartbeat waits |

Computer actions still execute in order and return a fresh screenshot. The 150 ms pause is a rendering allowance, not proof that a page has finished loading. For web tasks, use the existing Playwright `browser_*` tools and explicit readiness checks. Slow desktop applications may need `COMPUTER_SETTLE_MS=700` (or a follow-up observation). The companion still waits when opening a native desktop browser without Playwright.

### Agent observations versus viewer frames

An unattended agent has **no continuous video feed (0 streamed FPS)**. Playwright returns page/DOM observations after requested browser actions. Desktop tools capture a fresh screenshot on demand or after an action. They do not wait for the viewer's next frame, and viewer FPS does not limit the agent's action rate. Agent screenshots remain capped at 1280 pixels wide independently; viewer frames are not sent to the model. Browser rendering and tool execution still consume CPU even with no viewer.

The virtual desktop stays at **1920×1080** while an agent works, so opening or closing a human viewer does not resize applications, move controls, or invalidate the agent's last screenshot coordinates. The **1080p video encoder** runs only while a visible human viewer is connected. An agent requesting a screenshot receives a **1280×720 still image** with the default dimensions, without starting the video encoder. Capturing/scaling that still image costs CPU for that request; it does not create a recurring 20 fps workload. Native desktop tasks may need these image observations; Playwright browser tasks normally use structured page information instead. Human viewing adds encoding/network overhead without changing the agent's observation rate or sending those viewer frames to the model.

| User activity | Capture policy |
| --- | --- |
| Viewer closed or browser tab hidden | No video encoder or periodic viewer captures; agent tools still work |
| Watching | Target 20 fps at 1080p by default |
| Taking control | Target 20 fps; mouse/keyboard input is sent immediately, independently of capture timing |
| Multiple watched Linux desktops | Share a 20 fps aggregate budget; control receives three times the weight of watching (one control + one watch becomes 15 + 5 fps) |
| Visible thumbnail | One still preview when shown or after closing the viewer; never a polling loop |

`SWARM_VIEWER_FPS` and `SWARM_CONTROL_FPS` both default to 20 and belong to the **companion process**, not just the API server. CLI overrides are `--viewer-fps` and `--control-fps` (1–60). `SWARM_VIEWER_BUDGET_FPS` defaults to 20 across watched Linux displays. Raising a single display to 60 fps requires raising its target **and** the aggregate budget; this is optional, not the default. `SWARM_VIEWER_WIDTH` defaults to 1920, and cloud desktops default to 1920×1080 (`SWARM_SCREEN_WIDTH` / `SWARM_SCREEN_HEIGHT`). Set the widths to 1280 and height to 720 to opt into a smaller desktop/stream, with less workspace and potentially more compact website layouts. Viewer input carries framebuffer dimensions so clicks remain correctly scaled. Local browser-only companions keep Chrome's changed-frame stream separate from the Linux desktop budget; skipping every Nth changed frame could suppress the only update after a click.

Linux uses one FFmpeg X11 capture/encoder process per watched desktop, shared by all viewers of that display, with one encoding thread and one filter thread. Its scheduler priority is lowered (`nice +10`, best effort) so agent tools and Chrome receive preference under CPU contention. The FPS budget bounds capture work; it is not a hard CPU quota or a CPU-utilization feedback loop. Encoding stops on last-viewer close, screen deletion, or disconnect. Without FFmpeg, or after encoder failure/stall, the companion falls back to sequential screenshots capped at 8 fps. macOS continues using this fallback. The binary protocol is negotiated at connection time; older servers and companions retain JSON compatibility. The transport is MJPEG over the existing WebSocket/noVNC connection, not WebRTC/H.264, so high-motion scenes still consume substantial bandwidth. Network congestion drops frames rather than delaying control responses.

Playwright's actionability checks remain enabled. `SWARM_BROWSER_SETTLE_MS` controls its additional settling allowance (default 150 ms). Dynamic sites may still need an explicit readiness condition; no fixed delay proves an application is ready.

Higher frame rates/resolution and a longer VM idle window use more CPU, bandwidth and uptime. Existing companions need to restart with the updated script; cloud VM companions fetch it at boot. Desktop dimensions take effect when virtual screens are created; existing screens keep their size until recreated on an idle restart. **The cloud VM image must also be rebuilt to install FFmpeg.** Restarting an old image alone keeps the fallback path.

## Validation

In an isolated local server with a mock model and real Chrome:

- All 19 existing local-computer integration scenarios passed, including navigation, typing, scrolling, browser safety checks, screenshots, live viewer and take-control.
- A sequential comparison using the same test page at 20 fps measured **35% of one CPU core at 1920×1080**, versus **16.5% at 1280×720** for FFmpeg encoding: about **53% less encoder CPU** with the optional lower resolution. **1080p remains the selected default**, and its recurring encoding cost occurs only during human viewing/control. These CPU measurements cover the encoder only, not Chrome, Xvfb, the server, or model inference, and vary with hardware/content. They are not production capacity guarantees. Two simultaneously watched desktops shared **20 fps total**. Viewer clicks and separately scaled agent clicks pass at both resolutions.
- A real desktop click produced a visibly changed encoded frame in **36 ms locally at 720p**, versus **67 ms in the 1080p comparison run**. These are single-click samples, not latency percentiles; timing within a 50 ms frame interval affects the result. The benchmark timestamps input sent to the companion and the first received JPEG with the button's changed color. This includes actual X11 input and frame capture/encoding, but excludes Internet latency, the production relay, and the viewer's decode/display time. Input bypasses the agent's post-action screenshot settling delay; old frames are replaced rather than queued under congestion.
- Filling two fields and submitting through the real Playwright MCP path completed in **234 ms locally at 720p**, including updated page results. During agent-only actions and screenshots, the test verifies **zero streamed frames and zero encoder processes**. This excludes model inference and WAN latency.
- Encoder cleanup on stop/disconnect/screen deletion, fallback with no FFmpeg, legacy JSON compatibility, binary framing, and delayed-provider text flushing are covered by regression checks.
- The 31 focused tests cover latency, connection caching, and VM-image upgrade ordering/metadata retention (5 latency, 23 connection/auth, and 3 VM-image tests). Built-UI checks cover automatic cloud wake, intermediate status events, failure/retry, local-PC connection handling, hidden-tab disconnection/resume in both watch and control modes, waking after the VM sleeps while hidden, and removal of thumbnail polling. Wake requests show progress immediately and cannot be duplicated while pending.
- Opening a test form, clicking a field, typing and submitting completed in about **0.93 seconds**. This includes local tool round trips, but does not measure production inference or WAN latency.
- The first pass reduced initial JavaScript from **663.54 KB to 535.51 KB (19.3%)**. The isolated latency PR measures 533.76 KB of initial JavaScript in the browser. Deferred chunks still download when used.
- An isolated screenshot-provider test took 0.3 ms for a read and about 903 ms for six actions; the old unconditional waits alone were 700 ms and 4,200 ms respectively. These are application-overhead checks, not real screenshot capture timings.
- Cache regression tests cover concurrent callers, user isolation, invalidation, expiration, failures and stale metadata refresh.

Run `npm run typecheck` and `npm run test:performance` for the build, focused unit tests, real cloud-companion benchmark, and viewer wake checks. The latter needs Linux, Chrome, Xvfb, xdotool and ImageMagick; it uses the existing `ffmpeg-static` dependency unless `SWARM_FFMPEG` is set. No live model or cloud account is needed. Connection cache tests run with `npm run test:composio`. The existing `tests/local-computer.mjs` suite requires an isolated server pointing at `tests/mock-provider.mjs`; see its setup comments.

To compare resolutions after a build, run `node tests/vm-performance.mjs` followed by `node tests/vm-performance.mjs --720p`. Run them sequentially so the encoders do not compete during the CPU measurements. The default run leaves desktop/viewer dimension overrides unset, verifying the actual 1080p defaults and independently scaled 1280×720 agent screenshots. The 720p comparison deliberately requests a smaller agent screenshot to preserve coordinate-scaling coverage there too.

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
2. **VM wake-up:** the checked-in Fly configuration now keeps user VMs warm for 15 idle minutes (previously 5), reducing repeated wakes at additional cost. Keep active workflows warm; don't create a VM merely to load a chat page.
3. **CPU contention:** the app currently requests one shared CPU and 1 GB RAM. If event-loop delays or CPU saturation rise with concurrent Bots, benchmark a dedicated CPU/larger machine. User VMs now share a 20 fps capture budget only while watched, with low-priority encoders. Measure task completion under load before raising that budget or the resolution.
4. **Geography:** the app and VM are configured in `iad`. Measure user-to-app and app-to-VM latency before choosing a closer region; keep those services close together and plan SQLite ownership before adding multiple app replicas.
5. **Long computer sessions:** if capture and bandwidth still dominate, the persistent encoder and binary JPEG transport are now implemented. If bandwidth still dominates, use inter-frame video compression and WebRTC; that requires a separate viewer protocol and cross-platform testing.

## Rollout

1. Build and publish a **new, versioned VM image** from `infra/vm-image/Dockerfile` (FFmpeg is installed there). Set `VM_IMAGE` on the app to that new tag or digest; reusing `v1` does not trigger the existing image-upgrade comparison.
2. Deploy the app/companion changes and updated 15-minute idle setting together. Old companions remain compatible with the new relay, and new companions fall back to JSON with old relays.
3. Let the existing VM upgrade process move idle VMs to the new image. Preserve the `/home/agent` volume and avoid interrupting active tasks. Check companion logs for screenshot fallback, then verify a real viewer and browser task.
4. Compare `[latency]` timings and actual viewer FPS on representative user connections. Model generation still depends on the selected provider/model; no model or reasoning-effort settings were silently changed.

These changes are verified locally, **not deployed to Fly**. This workspace has no configured Fly API token. Production model/WAN benchmarks remain outstanding.
