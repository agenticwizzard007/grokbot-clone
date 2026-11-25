# Customer readiness R8: voice pill state and composer DOM value

## R8-1: post-call approvals

The old call summary stored an approval sentence as text. Deciding the card rewrote only the card, so the call pill and subsequent voice context could keep claiming the approval was pending.

New call records store the base call text, discussion, and exact references to approvals pending at call end. Each reference binds the approval ID, bot, generation, card sequence, and saved action description. Gmail subjects come from the card's saved arguments. Membership keeps the R7 account, call-start, call-end, generation, audience, and delegated-bot boundaries.

API snapshots, row reads, sidebar previews, SSE payloads, voice session context, recall, and search derive the status from durable approval records. A decision or expiry updates the linked call row revision and publishes it through the existing SSE stream, including when a delegated bot owns the card. Missing records have no current status available; they are never assumed pending. Allowed means permission was granted, not that the action executed.

Legacy pills contain a voice call ID but no approval IDs. Matching their subjects or prose would be unsafe. Their UI text remains historical, and voice context replaces their unverified status with a historical-call notice. No new pill uses that frozen representation.

Local browser verification uses the real API, SQLite persistence, and two connected SSE clients with fake providers. Pending, denial, reload, wrapping, and horizontal overflow passed at 1280 and 390 pixels in light and dark themes. Allow and always-allow are exercised only with local provider fixtures. Unit/integration tests also cover expiry, mixed states, delegated approvals, missing records, account boundaries, delayed summaries, legacy history, and voice recall.

Run:

```sh
node --import tsx --test tests/voice-coordinator.test.mts tests/voice-chat-timeline.test.mts
node tests/voice-pill-state-ui.mjs
```

Screenshots are written to `.context/voice-pill-state/`.

## R8-4: composer investigation

No composer change was warranted. `Composer.tsx` renders one visible native textarea with `value={text}` and immediate `setText(e.target.value)` in `onChange`. There is no deferred value, transition, debounced input state, highlighting overlay, or draft-store subscription on each key. The draft map is saved after render and restored when the selected conversation changes or a submission finishes. Neither path runs for ordinary typing.

Two measurement textareas live in an `aria-hidden` host with `visibility: hidden`, zero dimensions, and strict containment. They measure height only. They cannot be the visible text, and their values are copied from the visible textarea. A selector for this check must use `.composer__input`, not an arbitrary textarea or its HTML `value` attribute.

`tests/composer-dom-value-ui.mjs` builds the production app, mocks only local API/voice traffic, and sends 59 characters through three native input paths. It runs idle and with an animated voice meter, captions, and streaming rows at both widths and themes. A capture listener reads the actual DOM value synchronously on every trusted input event, then reads again in a microtask after React handling. Per-key CDP dispatch also reads `.value` with `Runtime.evaluate` immediately after every acknowledged key. It never assigns the textarea value to simulate typing.

Measured on this VM with Chrome and Node 24.22.1:

| Input path | Scenarios | Trusted input events | Completion for 59 characters | Largest input-to-microtask interval |
| --- | ---: | ---: | ---: | ---: |
| CDP `Input.insertText` | 8 | 8 | 2.6 to 7.7 ms | 0.2 ms |
| Playwright `keyboard.type`, 5 ms key delay | 8 | 472 | 504 to 738 ms | 0.2 ms |
| CDP keyDown/keyUp, with a synchronous DOM read after each key | 8 | 472 | 200 to 337 ms | 0.2 ms |

All 952 input observations contained exactly the expected prefix, and all post-React reads matched. Immediately after the final injection acknowledgement, every scenario had the complete value. There was no gradual restoration after typing completed and no divergence between the visible native field and its DOM value.

The test also demonstrates the distinction between enqueueing input and delivering it to Chrome. A local producer returns after scheduling 59 key pairs at 100 ms intervals. It returns in 0.08 ms with an empty value, while delivery finishes 6.23 seconds later. During this active-voice case, the app's isolated typing meter reports p95 32 ms. The value advances only when another input event actually arrives. A screenshot requested after delivery sees all characters. The meter measures browser-event-to-presentation latency; it cannot measure time spent in an external injector before browser events exist. Its Event Timing method has a 16 ms reporting floor.

These results reproduce the slow-delivery/fast-meter pattern through injection queueing, without an application DOM lag. They do not retrospectively prove the exact queue used in the original live xdotool run, because that run's key-event timestamps were not captured and no live account was accessed. A screenshot and an earlier CDP read are separate observations, not evidence of simultaneous divergence. To distinguish these cases in a future run, record injector completion, trusted input timestamps and values, the final CDP acknowledgement, and screenshot time on the same page.

Run:

```sh
node tests/composer-dom-value-ui.mjs
```

Per-event evidence and screenshots are written to `.context/composer-dom-value/results.json` and `.context/composer-dom-value/`. No production instrumentation or composer behavior was changed.
