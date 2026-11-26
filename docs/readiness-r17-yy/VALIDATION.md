# Round 17 YY

All checks use local fixtures and placeholder provider keys. No live sign-in or customer data was used. The supplied Round 16 recheck path was not present on this VM, so the detailed findings in the request were checked against c1c6c67 and reproduced locally.

| Item | Cause and result |
| --- | --- |
| R17-1 | The skill description required source references from session_search, and memory guidance also said to search first. Creation guidance now uses the current request. The API prompt supplies a validated source reference tied to the user job, including approval continuations. Past-chat search still asks at maximum approval, with a bounded query in the title. A declined optional lookup can be followed by the requested skill action. |
| R17-2 | API diagnostic recording retained the internal policy_denied classification after setting the result to denied. New API declines store a null error code; the UI also shows None for older denied records. Runner errors retain their codes. |
| R17-3 | Files fell back to the primary Bot. It now remembers actual chat/details/work visits and explicit Files choices in account-scoped session storage. With no context it shows Choose a Bot and does not request any Bot's files. Explicit scoped routes win, and a later chat visit replaces an older Files choice. The generic Files title remains until an explicit choice. |
| R17-4 | The api-keys alias was missing, and unknown settings hashes returned no screen. The alias resolves to keys; unknown settings sections resolve to Settings with a canonical hash. Existing aliases remain covered. |
| R17-5 | Both recognized overlays opened on untouched c1c6c67 when location.hash was assigned from Files and chat, at 1280 and 390 in both themes. That reported symptom did not reproduce, so the overlay implementation was retained. Unknown hashes did reproduce the stale-page/dead-hash problem. They now restore the previous valid screen with a corrected URL, or Bots without an origin. OAuth fragments remain reserved for authentication. |
| API explanation | Models & access used the shared control without its optional explanation. The maximum-approval explanation now always says that every action asks first, with the provider-search and Always allow notes in the same shared copy. |

## Coverage

- `tests/api-approval-level.test.mts`: current-message skill/task/memory creation; Allow and Don't allow; optional search denial followed by skill creation; search title and trimming; source provenance through resume; API diagnostics for direct, native OpenRouter and personal OpenRouter. Existing maximum-approval, catalog discovery, wrapper, CLI and external-write cases remain enabled.
- `tests/api-run-diagnostics.test.mts`: both API slots before and after continuation, persisted null error codes on decline, real runner error codes, account isolation and CLI-history preservation.
- `tests/api-approval-ui.mjs`: settings copy, skill/task/memory cards and writes, past-chat search wording, pending/denied/allowed diagnostics and reload, at 1280 and 390 in light and dark. The fixture now navigates directly back to its Bot instead of racing a history traversal with a second navigation.
- `tests/readiness-yy-ui.mjs`: 48 Files, reload, explicit-selection, typed-hash, overlay and fallback checks against production assets across the four width/theme combinations. External requests are blocked.
- `tests/navigation-history.test.mts` and `tests/qa-r3-settings.test.mts`: canonical routes, paired history events, aliases, fallback and preserved authentication fragments.
- Existing Files/synopsis and first routine-history fixtures now choose their intended Bot explicitly. Their assertions remain enabled.

Run `npm run test:readiness-yy` for the focused suite. Full-suite runs use `node --import tsx --test --test-concurrency=1 tests/*.test.mts tests/*.test.mjs`, once in a detached untouched origin/main checkout and once in this branch. Logs, comparison JSON and screenshots are in `.context/` on this VM.

Final local results: untouched c1c6c67 has 2,741 passes, 70 failures and 24 existing skips (2,835 tests). This branch has 2,745 passes, the identical 70 failure names and the same 24 existing skips (2,839 tests). Absolute checkout prefixes were normalized when comparing file-level test-hook failures. No tests were disabled or newly skipped.

Stream XX landed as 0ed2d593496d51cc58f6b0a3f11e2613ce3f4f40. The rebase was clean. After rebasing, the focused suite passed 225 unit tests, the four API approval width/theme scenarios and all 48 Files/hash checks. A further 75 CLI diagnostics and approval tests passed. Typecheck and production build passed. Earlier verification also passed all 124 CLI regression tests, 20 existing navigation scenarios and four existing Files/synopsis scenarios.

Composer layout, composer pill styles, provider icons and provider artwork are outside this change. Stream XX's Fly deployment succeeded and its public revision was verified before this PR was released. This PR's existing Fly deploy must also succeed and its public version revision must equal the latest main HEAD.
