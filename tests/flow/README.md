# HO-G verification and integration

Run from the repository root with the existing lockfile dependencies:

```
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/flow/*.test.mts
node tests/flow/demo-g.mjs
node tests/layout-alignment-ui.mjs
node --import tsx --test --test-concurrency=1 tests/*coordination*.test.mts tests/agent-*.test.mts tests/structural-navigation.test.mts tests/navigation-labels.test.mts tests/central-setup.test.mts tests/suggestion-cache.test.mts tests/suggestion-display.test.mts
```

The six committed golden models cover rich, empty, suggestions, non-English instructions, long labels and the 30-routine/40-app fixture. The SQLite/API tests use a temporary database, forbid fetch, check tenancy and flags, measure cold/warm reads, and exercise the real FlowStore. Performance measurements are written to `.context/flow/performance.json`.

The demo uses `tests/layout-fixture.mjs` for the real application shell, with deterministic flow/link API responses and a local SSE stream. This keeps the demo runnable before HO-I mounts the routers. Screenshots, click destinations and checks are in `.context/flow/demo/report.json`. No provider is contacted. Link refusal uses HO-A's cycle validator. Actual link persistence belongs to HO-B. With no installed axe dependency, `accessibility.mjs` checks ordered lists, accessible names, labels, decorative SVGs, touch targets and modal semantics; the demo separately verifies keyboard order, focus return, focus containment, reduced motion, full labels, and light/dark alignment.

## Integration requests for HO-I

- Mount `flowApi` from `server/src/flow/routes.ts` at `/api`. Mount HO-B's handoff routes for link GET/PUT.
- Wire HO-C's `write_flow_summary` adapter to `flowStore` from `server/src/flow/summary.ts`.
- Call `configureFlowRefresh(enqueueSystemRequest)` using HO-B's transport function before serving requests. The durable ten-minute rate limit and transactional enqueue are in HO-G.
- Call `recordFlowConnections(userId, apps)` from `server/src/flow/cache.ts` after existing connected-account reads. Pass public `{ id: toolkitSlug, name, attention }` facts only. The existing reader always contacts a provider, so flow generation deliberately cannot call it. Until a snapshot exists, the chart says to refresh Connected apps. This display snapshot never authorizes execution.
- Add shared Flow and loop routes, and consume `FlowNode.target.focus` for routine/app/MCP/skill highlighting. HO-G preserves the focus key in `history.state.flowFocus` and emits `swarm:flow-focus`. Cold Flow links and loop destinations await this shared routing change. Node return focus and warm Flow/link URLs already work through the local adapter.
- Route main SSE `flow` events to `notifyFlow(botId)` or bump `flow:<botId>`. Then HO-G can remove its temporary shared subscription, local hash/header adapter, and Activity-backed local tab state. Existing configuration/native events already refetch mounted flow surfaces without polling.
- Writers may call `touchFlow(botId)` after commit for an explicit 500 ms debounced invalidation. Hash invalidation is sufficient for correctness.

`DetailsPanel.tsx`, `AgentConfiguration.tsx` and `SuggestedIntegrations.tsx` remain HO-G-owned. Other workstreams should request changes to these files rather than edit them.

## Local baseline

Untouched main `4b47341` passes both typechecks, all 168 selected regression tests and all 208 layout views. The legacy `central-setup-ui.mjs` and `agent-history-ui.mjs` fail on main because of stale UI selectors. The history failure is the same missing History heading on this branch; setup reaches a later stale pinned-tile selector here. `suggested-integrations-ui.mjs` passes on both branches (12 viewport/theme combinations). Full logs are in `.context/flow/` with `baseline-` prefixes for main.

The chart uses intrinsic HTML/CSS row heights so wrapped labels remain fully visible. Its five equal columns switch to stacking below 800 px of actual column width, including expanded sidebars. Numeric fixed-height boxes from HO-A are not used to clip HTML text. Two local persistence tables hold public connection snapshots and refresh timestamps alongside the specified `bot_flow_cache`.
