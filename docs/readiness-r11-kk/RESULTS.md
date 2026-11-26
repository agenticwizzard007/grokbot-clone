# Customer readiness round 11, stream KK

Baseline: `614b8d2c677439f41ef391b614c31df8862bf2e3`, measured in a separate untouched checkout on this VM. No live sign-in, real mailbox access, account mutation, or paid resource changes.

## R11-2: CLI plan permission audit

The production CLI MCP callback and API Standard both dispatch through `processCalls` and `executionPolicyFor`. Deferred `tool_call` resolves its underlying tool before checking policy. `execute_code` dispatches each action through the same gate. Neither wrapper grants execution permission.

The named matrix in `tests/readiness-kk.test.mts` checks every registered native tool against an explicit inventory. It also checks Codex ChatGPT plan and API Standard app operations, Always allow, and mutation names carrying false read-only tags. No API maximum-approval setting or approval UI was changed.

External paths which could previously run without a card:

- Any write slug carrying only `readOnlyHint`, including `GMAIL_CREATE_EMAIL_DRAFT`, `GMAIL_SEND_EMAIL`, `SLACK_SEND_MESSAGE`, `NOTION_UPDATE_PAGE`, calendar creates, drive deletes, and social publish/post tools. The metadata attestation previously overrode the action name without checking for contradictions.
- Mixed read/write names such as `GITHUB_GET_AND_DELETE` and `GMAIL_FETCH_AND_MARK_READ` with a false read-only attestation. The synchronous policy also treated a read word anywhere in the slug as permission.
- Custom MCP send, draft, or publish tools when the server's broad `requireApproval` option was off. Known mutation names now require an action approval; an explicit per-tool Always allow still works.

`isExternalOnBehalfAction` is a shared helper for composition with API approval levels. Mutating names veto read attestations at discovery, policy, standalone execution, and tenant execution. Unknown or unattested app operations ask. A name alone never grants read access. Resource nouns in `GET_DRAFT`, `GET_POST`, and `GET_SEND_AS_ALIAS` remain eligible for attested reads.

| Tool family | Tools or classes audited | Default result |
| --- | --- | --- |
| Memory and sessions | session_search, remember, recall, correct_memory, forget_memory, manage_memory | No approval |
| Skills | list_skills, read_skill, apply_procedure, propose_skill, manage_skill | No execution approval; existing knowledge validation remains |
| Files and Library | save_file, list_deliverables, routine_history, deliver_artifact with library channel | No approval |
| Tasks and routines | create_task, update_task, create_routine, list_routines, update_routine, delete_routine, create_event_routine, list_event_triggers, set_checkins | No approval |
| Goals and workflows | create_goal, control_goal, verify_goal, get_workflows, create_workflow, start_workflow, control_workflow, add_workflow_dependency, delegate_workflow_task, complete_workflow_task | No approval |
| Team and subagents | get_team_state, get_team_records, read_team_source, read_team_job, inspect_teammate_setup, prepare_teammate_setup, send_to_bot, create_bot, replicate_bot, retry_bot_setup, spawn_subagent, list_subagents, message_subagent, stop_subagent, create_group, post_to_group | No approval |
| Platform and chat | get_platform_state, save_agent_setup, update_profile, stay_silent, ask_user, present_draft | No execution approval; in-chat previews never write to an app |
| Discovery and orchestration | list_app_connections, search_apps, request_app_connection, SWARM_APPS_SEARCH, tool_search, tool_describe, tool_call, execute_code | Discovery is free; underlying executions retain their gate |
| Computer observation | computer_screenshot, browser_snapshot, browser_take_screenshot, browser_find, browser_console_messages, browser_wait_for, wait_for_browser_access | No approval |
| Other computer tools | computer_click, computer_type, computer_key, computer_scroll, computer_drag, open_browser, shell, browser_navigate, browser_navigate_back, browser_click, browser_type, browser_fill_form, browser_select_option, browser_press_key, browser_hover, browser_drag, browser_file_upload, browser_handle_dialog, browser_tabs, browser_evaluate | Existing account computer preference preserved |
| Connected-app reads | Exact owner/account/revision and provider read-only attestation, without mutation contradiction | No approval |
| App writes | Create/update/delete, drafts, send/reply/forward, publish/post, uploads, sharing, membership, reactions, scheduling, payments, execution and other mutation verbs | Approval unless explicitly Always allowed |
| Unknown app operations | Unattested, conflicting, or unrecognized metadata | Approval, then normal ownership/schema checks |
| Report delivery | deliver_artifact outside library; retry_delivery | Approval unless explicitly Always allowed |
| Custom MCP | Existing server policy; known mutation names cannot use the server opt-out | Action approval for writes, with per-tool Always allow |
| Legacy Composio meta tools and raw app slugs | Not exposed by the app adapter | Cannot execute |

The existing fresh account time-zone confirmation is removed for CLI plans only. API behavior is preserved. Changes still require an explicit user request and retain timezone validation and the saved notice. Explicit saved policies and access restrictions remain authoritative.

The browser fixture uses the installed official Codex binary, its hosted MCP bridge, a local model endpoint, and local app fixtures. It verifies memory, file, and task execution without cards, Gmail draft and Slack write cards, Always allow availability, denial without execution, and SSE/UI rendering at 1280 and 390 in light and dark.

## R11-3: Gmail read and error diagnosis

A reproducible failure exists before provider execution: `appArguments` rejected every `user_id`, including Gmail's authenticated mailbox selector `user_id: "me"`. The same guard is used on the standalone and tenant paths. The public Gmail toolkit documentation describes `me` as the authenticated user: https://docs.composio.dev/toolkits/gmail.

The guard now permits only that exact literal for Gmail tools. It still rejects arbitrary mailbox IDs and provider/tenant identity overrides. The SDK's user identity and connected account remain selected by trusted server state. Disabled accounts are excluded both at admission and immediately before execution. Revision, owner, toolkit, pinned version, fresh read attestation, and replay checks remain enforced.

Two independent error-handling defects amplified any underlying failure:

1. `runComposioTool` called almost every exception a connection failure. It now exposes only fixed classifications for authorization, permission, rate limit, timeout, provider availability, invalid arguments, stale selection, or an unknown operation failure. Provider bodies and credentials are neither shown nor logged. Uncertain writes retain the warning to check for changes before repeating them.
2. `processCalls` persisted the app failure and then threw from the native MCP callback. The runner replaced it with `Native tool execution failed`. The callback now returns the sanitized failed result and stops, then the job records the original failure. Last CLI run retains the tool and safe error code.

The official hosted Codex fixture covers three returned Gmail subjects, non-auth provider failure, auth rejection, timeout, stale revision, missing connection, and expired connection. The tenant gateway fixture additionally checks identity/revision restrictions and a write falsely attested as a read. No live account logs or mailbox contents were inspected, so the exact private provider response from QA-Temp-1 is not claimed as observed.

## R11-4: one connection snapshot

The agent previously mapped raw connection records while Settings used `visibleConnections`. Unfinished OAuth attempts could therefore appear as expired apps only to the agent. The tenant gateway also dropped the `authorizationIncomplete` classification during projection.

`connectionSummary` now supplies the account list, usable toolkit set, and connected app count to both listing APIs and the agent tool. Settings calculates its headline from that same account snapshot instead of a separate catalog request. Unfinished/pending/failed sign-ins stay absent, real expired accounts remain visible with Needs reconnecting, and disabled accounts are explicitly identified. One Active app plus one expired app means one connected app and one visible expired account. Multiple Active accounts for one app count once.

Tests cover Active-only, Active plus expired, zero, unfinished OAuth, duplicate accounts, disabled accounts, and the tenant HTTP projection. Screenshots cover 1280 and 390, light and dark.

## Validation

Run `npm run test:readiness-kk` for the focused regression suite, real hosted Codex fixture, and browser fixture. Validation completed on this VM:

- Untouched 614b8d2 full suite: 2,371 passed, 70 failed, 24 existing skips (2,465 tests).
- Branch full suite: 2,640 passed, the same 70 failure names, the same 24 skips (2,734 tests). No new failure names.
- Final focused suite after rebasing: 347 passed, plus 7 official hosted Codex cases; zero failures and zero skips. This includes the additional read-resource and tenant-projection cases added during review.
- Browser fixture: all four combinations of 1280/390 and light/dark passed. Existing connected-account browser regression also passed at both widths.
- Typecheck and production build passed after rebase. The branch was mergeable.

The full suite command was `node --import tsx --test --test-concurrency=1 tests/*.test.mts tests/*.test.mjs` in both checkouts. No tests or CI workflows were disabled or newly skipped. Existing CI workflow configuration and Fly deployment are unchanged.
