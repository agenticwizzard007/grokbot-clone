# Round 18 AAA: current-message creation approvals

R18-3 was reported on 1957a7fc80f5fb6ebe777f4768d7f62c809b0e13. The supplied Round 17 recheck file is not present on this VM. No live sign-in or customer data was used.

## Root cause and evidence

The first-card guarantee existed only in model instructions. In `server/src/agent/loop.ts`, `processCalls` resolved and validated the model's chosen tool, then immediately passed it to `executionPolicyFor`. A model choosing `session_search` therefore produced a past-chat approval before any create action. Declining it returned the generic "Find another way, or tell the user what you could not do" result. There was no runtime route back to the current-message create. The #235 fixture selected `propose_skill` itself, so it did not exercise the reported model choice.

The requested checks against untouched main found:

| Surface | Finding |
| --- | --- |
| `agent/prompt.ts` | Says to create directly and not start with `session_search`, but also says "Cite sources", use recall before relying on old facts, and load skills with `list_skills` then `read_skill`. These instructions do not constrain runtime approval order. |
| `propose_skill` | Already says to use the current source and call the skill action directly. Its required evidence array has `minItems: 1`. The implementation passes evidence through without inference. |
| `manage_skill` | Already says a current-message create needs no session search. Evidence is required in its schema (no schema `minItems` here); ordinary skill mutations enforce nonempty valid evidence in `knowledge/skills.ts`. No source inference. |
| `session_search` | Offers original messages across current and archived conversations, with an anchor option. It does not itself distinguish a necessary older lookup from unnecessary current-message grounding. |
| `recall` | Explicitly points the model to `session_search` for original conversation evidence. |
| `list_skills` | Lists existing skill metadata and instructs loading a chosen skill. No creation prerequisite is enforced. |
| `remember` | Evidence is optional in the schema; omitted evidence is inferred only from a uniquely matching real user message. Skills do not have this fallback. |
| Catalog order | `CORE` lists `session_search` before `propose_skill`, but is a membership set, not a sort order. `assembleToolCatalog` filters the original array. `KNOWLEDGE_TOOLS` actually offers `propose_skill` before `session_search`. A native OpenRouter route fixture asserts this order. Reordering the set would have no effect. |
| API source reference | `POST /bots/:id/messages` appends the trimmed human message before enqueueing its user job. `callModel` passes `ctx.jobId` into `systemPrompt`; `currentUserMessageRef` binds to that durable job and follows approval resumes. The native OpenRouter chat-route fixture confirms the exact current message's reference in the model input. It is absent intentionally for internal, group or unbound triggers. |

The evidence requirement and general source/skill-loading guidance make an unnecessary lookup a possible model choice. Without the workspace key, the model's precise reason for choosing that tool cannot be independently established. The reproducible product defect is that runtime accepted this choice as the first approval despite the direct-create instruction. Neither missing provenance on the normal API path nor the proposed catalog-order explanation reproduced.

## Runtime change

For an explicit current-message skill, task or memory create under Ask before every action in API mode, source-preparation calls to `session_search`, `recall` and `list_skills` return a redirect result before approval creation. The result explicitly says no lookup was performed and supplies the current message's source reference and the corresponding create tools. The lookup implementation never executes. The create still passes through its normal schema, evidence, revision and approval checks. No fake search results or automatic write approvals are introduced.

Classification uses only the exact job-bound human message. Requests mentioning earlier chats or existing material keep the ordinary lookup approval, including the existing "search your past chats for ..." title. Declining such a lookup preserves guidance for creating from current-message details, or asking for essential missing details. Standard API mode, CLI behavior, tool discovery, wrapper resolution, external writes and background reviews retain their existing boundaries. Skill evidence requirements remain intact; the redirect supplies real provenance instead of relaxing validation.

## Validation

Five R18 regression tests in `tests/api-approval-level.test.mts` cover intent classification, a search-first model followed by direct/wrapped skill/task/memory actions, genuine lookup and decline behavior, the native OpenRouter HTTP chat route with `x-ai/grok-4.7`, and Standard/CLI/internal/source boundaries. The existing #235 tests remain enabled. The browser fixture adds a search-first skill request with both Allow and Don't allow at desktop/mobile widths in both themes.

The native OpenRouter route test uses a network-disabled model fixture. A real Grok 4.7 run is the remaining verification gap: this workspace has no `OPENROUTER_API_KEY`, equivalent OpenRouter environment entry, project env file containing one, or local provider-settings database. No live secret was retrieved and no replacement key was invented for a real request.


Final local results on this VM:

| Run | Passed | Failed | Existing skips | Total |
| --- | ---: | ---: | ---: | ---: |
| Untouched main, 1957a7fc | 2746 | 71 | 24 | 2841 |
| This branch | 2752 | 70 | 24 | 2846 |

There are zero new failure names. The baseline failure "real codex companion: voice uses the main chat approval and denial" did not recur; no change to that path is claimed. Full-suite logs and the normalized failure-name comparison are in `.context/r18-baseline.log`, `.context/r18-full-suite.log` and `.context/r18-suite-comparison.json`. The detached baseline has no tracked changes.

Both focused runs passed all 147 tests, including the CLI approval regressions. After the final fetch/rebase, the approval, diagnostics and tool-discovery run passed 44/44. Typecheck and production build passed again. All four API approval browser scenarios passed at 1280 and 390 in light and dark, with both approval decisions on the search-first skill case. No tests or workflows were disabled or newly skipped.

New test names:

- R18 explicit create detection preserves real lookups, negations and quoted examples
- R18 search-first model reaches the skill, task or memory card without reading older data
- R18 explicit older-context requests still ask before searching and can continue after decline
- R18 native OpenRouter chat route supplies current evidence and redirects a search-first Grok turn
- R18 current-create redirect leaves Standard, CLI, internal triggers and unbound sources unchanged
