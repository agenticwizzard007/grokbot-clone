# Native Hermes-derived capabilities

This implementation runs inside Swarm's existing TypeScript server, SQLite database, Bot queue, permission dispatcher and React application. It does not start Hermes or require a separate Python service. Upstream adaptations are pinned to `f0e7b68e439f8c1962fcf9dcb0341aadf1e2a898`; the MIT license is preserved in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

| Capability | Native implementation | Hermes code adapted |
| --- | --- | --- |
| Learned skills | Bots propose procedures with message evidence. Owners inspect the diff and approve/reject in Bot settings → Skills. Immutable revisions support rollback and stale-edit protection. Only skill metadata enters the prompt; `read_skill` loads approved instructions. | `tools/skill_ledger.py`, skill write/review patterns |
| Sourced memory | Facts reference original message generations, sequence numbers and content hashes. Corrections retain history and suppress old facts. Forgotten facts are excluded from recall and cannot be relearned from old sources. SQLite FTS retrieves current and archived messages. | `hermes_state_search.py`, `tools/session_search_tool.py`, memory write approval patterns |
| Deferred discovery | Large tool catalogs use ranked search, exact schema description and schema-bound calls. The dispatcher rechecks ownership, current membership, arguments and approvals for the actual tool. Custom MCP capacity is 4,096 tools per Bot; schemas are projected into a bounded model manifest. | `tools/tool_search_catalog.py`, `tools/tool_search.py` |
| Goals and delegation | Persistent goals carry acceptance criteria and budgets. Workflows persist dependencies, child assignments and results on Swarm jobs. Structured child output has one correction attempt. Pause/stop, unavailable accounting and lost execution block further work. | `hermes_cli/goals.py`, `hermes_cli/kanban_db*.py`, `tools/delegation_output_schema.py` |
| Routines and deliverables | Runs persist through approval/question continuations. `save_file` writes immutable artifacts and authenticated downloads. Delivery records claim individual sends and retry only definitely-not-sent outcomes using the same saved bytes and recipient. | `cron/executions.py`, `cron/delivery_queue.py` |
| Programmatic execution | `execute_code` runs JavaScript in QuickJS/WASM inside a bounded worker, without ambient filesystem, network, Node or secrets. Explicitly allowed tool calls return through Swarm permissions. Durable receipts replay completed results after approval and refuse uncertain effects. | `tools/code_execution_tool.py`, `tools/code_execution_rpc.py` |

The source files identify the exact translations and Swarm-specific extensions. This is selective code adaptation, not a claim of complete compatibility with every Hermes feature or skill package.

## Execution and recovery

The API account queue and selected subscription routing remain the execution authority. Dependency-ready work uses the existing API concurrency limits; subscriptions retain their supported concurrent Bot execution. An approval, question or app connection is a waiting state, not completed work. Goal-bound work uses structured delegation so child jobs share the budget and stop lifecycle. Pausing or cancelling a workflow targets its exact jobs and preserves unrelated conversations on the same Bot. Output contracts validate data shape; acceptance checks validate persisted references/content, not arbitrary semantic truth.

Token and spend budgets use observed provider usage, including compaction. Accounting settles before later actions, and the budget is checked again after compaction. Output token limits are passed where supported; input costs and an already-started call cannot be predicted exactly. Missing or partial provider counters remain explicitly unknown. When required accounting is unavailable, execution pauses. Unknown external outcomes require reconciliation instead of automatic replay.

Hosted messaging sends an authenticated artifact download link through the existing platform service. Approval pins the artifact hash, recipient, conversation and route revision; the platform rechecks that snapshot immediately before dispatch. Direct Inkbox iMessage also supports attachments. A lost provider acknowledgement remains unknown and cannot be retried automatically. Download links require the owning user's Swarm session.

Tool schemas and arguments are validated in disposable workers with time and memory bounds. Workflow result contracts accept a bounded JSON Schema subset; references and unsupported keywords are rejected. JavaScript programs allow at most 50 explicit tool calls and 60 seconds of interpreter execution, with normal permissions checked for each action. These limits are enforced by the native runtime.

All durable state is in the existing database and files tree. Restore fences pending external work because an older snapshot cannot prove that a later send did not occur. Account migration exports owned source rows and rebuilds the derived search index instead of copying cross-account FTS pages. Migration holds keep canonical records frozen: startup backfill, job/workflow recovery and delivery draining skip held ownership scopes while other accounts continue. Only the exact reviewed FTS index and its SQLite shadow tables are exempt from row fences; source records and the backfill marker stay protected.

## Validation

Focused regression tests cover revision conflicts, rollback, source isolation/correction/suppression, tool discovery, schema limits, program isolation and approval replay, workflow dependencies and budgets, routine continuation, artifact integrity and delivery retries. `tests/native-runtime.test.mts` exercises these paths through the actual agent loop. `tests/native-ui.mjs` uses the real server and UI with a mock model to exercise review, correction, downloads and dependent-task creation on desktop/mobile.

Run `npm run test:hermes-native` after installing workspace dependencies. This includes server/web typechecks, native tests, the production build, and desktop/mobile browser checks. Recovery regressions are in `tests/storage-recovery.test.mts`. With `TEST_DATABASE_URL` pointing to a disposable PostgreSQL database, run `node --import tsx --test --test-concurrency=1 tests/platform-messaging.test.mts tests/platform-messaging-dispatch.test.mts` to exercise hosted ownership and controlled delivery.

These tests use isolated storage and mocked providers. They do not establish deployment health, real provider delivery or Apple-device qualification.
