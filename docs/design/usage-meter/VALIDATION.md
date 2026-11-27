# USG-A local validation

Compared with `origin/main` at `0dd7807f76e4272abbe2cea46aff37581b507e9e`. All data was disposable fixture data. Provider interactions used local mock servers. No agent tools were registered.

| Check | USG-A | Main |
| --- | --- | --- |
| `npm run typecheck` | Server and web pass | Server and web pass |
| `tests/usage-summary.test.mts` | 14 pass | New suite |
| `tests/usage.test.mts` | 26 pass | 26 pass |
| Related regression command below | 190 pass | 190 pass |
| Failures | 0 | 0 |

```sh
node --import tsx --test tests/usage-summary.test.mts tests/usage.test.mts
node --import tsx --test --test-concurrency=1 --test-timeout=60000 \
  tests/openrouter.test.mts tests/model-request-policy.test.mts \
  tests/api-credits.test.mts tests/speech-routing.test.mts \
  tests/platform-voice.test.mts tests/conversation-usage.test.mts \
  tests/cli-catalog.test.mts tests/cli-cold-display.test.mts \
  tests/cli-subscription.test.mts tests/sse-stream.test.mts \
  tests/sse-reconnect.test.mts tests/ui-custom/sources-api.test.mts \
  tests/ui-custom/sources-performance.test.mts
```

Main ran the same existing suites without the per-test timeout. Its existing usage suite passed 26/26. The new reconciliation suite is absent on main.

Dashboard performance: 20 warm batches of 24 requests with 10,000 tasks, 100 bots, and 90 days of fixture usage. USG-A p95: 110.17 ms. Main p95: 127.88 ms. Both satisfy the 150 ms budget; this comparison does not claim a speedup.

Fixture input: `tests/fixtures/usage-summary.json`. Generated authenticated response: `.context/usage-summary.fixture.json`. Local logs: `.context/usage-tests.log`, `.context/regressions.log`, `.context/typecheck.log`, and corresponding `main-*` logs.

No screenshots are needed for this server workstream. The API integration contract and USG-B requests are in `API.md`. No scope deviations.
