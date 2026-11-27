# PB-D Bot pages

Reference: `docs/design/paper/BUILD-SPEC.md` sections 0b, 0c and 0d, and the v3 generator. Render with `python3.12 docs/design/paper/gen/render.py /tmp/paper-html`.

The screenshots use a disposable local account with two Bots and one room. Fixture names, values, model access and content differ from the Paper examples. No live account or user data was accessed. Compare the centered columns, equal cards and actions, tab order, single phone Back control, creation sheet, and sticky settings footer. The existing shell and official provider marks are retained.

Files: `{bots,create-bot,bot-activity,bs-general,room}-{390,1280}-{light,dark}.png`, plus each screen at `320-light.png`.

## Copy counts

Visible main-region words include the shell header and exclude the sidebar and phone tab bar. Both versions use the same local fixture. Before is untouched `f605ab4`; after uses this change. Every count is below the corresponding Paper v2 budget, including Analytics and Learning. The room gains a member list and Add Bot action.

| Screen | Before 1280 / 390 | After 1280 / 390 |
|---|---|---|
| bots | 33 / 33 | 22 / 21 |
| create-bot | 76 / 71 | 55 / 32 |
| bot-activity | 231 / 174 | 28 / 25 |
| bot-tasks | 111 / 41 | 20 / 17 |
| bot-files | 124 / 54 | 23 / 20 |
| bot-setup | 140 / 70 | 31 / 28 |
| bs-general | 147 / 141 | 27 / 24 |
| bs-skills | 62 / 55 | 23 / 19 |
| bs-memories | 99 / 92 | 22 / 18 |
| bs-routines | 69 / 62 | 22 / 18 |
| bs-analytics | 78 / 71 | 21 / 17 |
| bs-learning | 219 / 212 | 37 / 33 |
| room | 22 / 16 | 26 / 20 |

## Behavior and scope

- Bot lists use the 880px Page and equal card columns. Creation keeps the IME and delayed-keystroke safeguards while adding role and model choices.
- Details use a 640px Page at every width. Activity shows actual available run counts, pending approvals and estimated saved time. Counts limited by the existing 200-job endpoint use a plus suffix. Tasks retain approval routing and chat actions. Files keep saved reports and setup access.
- General, Skills, Memories, Routines, Analytics and Learning keep their existing writes, revision checks and draft guards. Secondary controls and detailed analytics are available in disclosures. Completed imports survive a route change without interrupting the newer screen. Cancel and Save use the shared footer geometry.
- Rooms gain colored member identities, Add Bot, recoverable member loading and a typing indicator. Room action hit areas are 44px without changing the approved composer height sequence.
- Per-Bot "Ask before every action" is not implemented. The current API and enforcement are account-wide across tools, voice, native search, learning and nested calls. That backend work is outside the assigned UI file area. General links to the working account Permissions page; it does not present a nonfunctional switch.

## Validation

The route matrix in `tests/paper-bots-ui.mjs` covers 19 Bot routes at 320, 390, 500, 768 and 1280 in light and dark. It checks complete labels, split words, 16px provider marks, copy budgets, tab order, card equality, and one phone Back. All PB-D routes are enforced in `tests/layout-alignment-ui.mjs`.

`tests/paper-bots-actions-ui.mjs` checks real local creation, model and role persistence, General and Learning saves, tab drafts, leave guards, room setup restrictions, member-load recovery and focus return.

Earlier UI checks were updated for the approved full-page details layout, shell navigation, concise labels and controls moved into disclosures. The header check now expects complete wrapping labels. The composer check preserves its stable slot and height assertions while allowing the required 44px Room action hit areas.

Full unit baseline at f605ab4: 2,856 passed, 70 failed, 24 existing skips. The working branch produced exactly the same counts and failure names. After rebasing on 77bb487, the 196 targeted unit checks passed on both untouched main and this branch, including the two unit suites changed by PB-C. The phone audit at 390 and 1280 passed 52 views on main and 64 views here. Unit and UI details are recorded in the PR body. Known failures are compared by name with untouched main on this VM; no test was disabled or newly skipped.
