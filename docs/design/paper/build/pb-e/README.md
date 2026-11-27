# PB-E Paper v3 evidence

Source: `docs/design/paper/BUILD-SPEC.md` and its generator. References were rendered locally with `python3.12 docs/design/paper/gen/render.py /tmp/paper-html` and compared with the built screens. All accounts, messages, calls and mutations use local fixtures.

## Main region copy

Each pair is desktop 1280 / phone 390. Measurements exclude the app sidebar, phone tabs and hidden content. Message fixtures are identical before and after. The baseline is untouched `f605ab4c674f1383640d5ac2b6a69e50a3403a1d`. Search now includes saved files and tasks. Error now includes the connection banner and plan reconnect card. Join has no artboard and uses the 30 percent budget.

| Screen | Before | After | Paper budget |
|---|---:|---:|---:|
| chat-rest | 79 / 68 | 72 / 63 | 72 / 64 |
| chat-run | 70 / 61 | 66 / 57 | 82 / 74 |
| chat-voice | 91 / 80 | 78 / 69 | 78 / 71 |
| loading | 18 / 13 | 13 / 8 | 15 / 12 |
| empty | 30 / 25 | 33 / 24 | 35 / 27 |
| error | 31 / 24 | 38 / 29 | 56 / 53 |
| tasks | 97 / 95 | 35 / 31 | 41 / 33 |
| team | 114 / 112 | 23 / 21 | 35 / 29 |
| goals | 70 / 68 | 16 / 14 | 20 / 14 |
| files | 70 / 68 | 27 / 25 | 41 / 38 |
| search | 11 / 9 | 26 / 24 | 117 / 44 |
| landing | 68 / 68 | 34 / 23 | 34 / 32 |
| signin-code | 76 / 76 | 34 / 23 | 34 / 32 |
| first-run | new / new | 32 / 30 | 33 / 37 |
| join | 37 / 37 | 11 / 11 | 11 / 11 |

## Screenshots

35 built screenshots: `chat-rest`, `chat-run`, `empty`, `error`, `tasks`, `search`, and `landing`, each at 390 and 1280 in light and dark, plus 320 light. Names follow `<slug>-<width>-<theme>.png`.

## Behavior and adaptations

- Shared Page, Section, Card, Row and ButtonGroup primitives align the content. The composer dock shares the message column edges; its existing stable layout and picker remain intact.
- Approval buttons retain deny, always allow and allow behavior. Phone buttons stack.
- Tasks keep Team, Goals and Files navigation and the existing count loading and error states. The API has working, needs input and done states; To do is empty until a real queued state exists. The desktop board has four equal columns, tablets from 761 through 1100 use two equal columns, and phones use grouped rows.
- Add task opens a chat draft without sending it. Long task identifiers use a complete compact label with the full title retained in the accessible name and title.
- Search reads Bots, messages, tasks and saved files. Selecting work results opens the corresponding scoped workspace.
- New phone accounts enter Connect a model. Its choices open the existing plan or API key connection flow. Existing OAuth account creation redirects remain unchanged because this stream does not change server authentication.
- Phone code entry has one top-bar Back control. Nested work panels use Close actions so they do not add competing Back controls.

## Validation

`tests/paper-pbe-ui.mjs` checks all five widths and both themes, shared alignment, provider slots, complete labels, word budgets, approval decisions, retry, empty suggestions and first-run routing. `tests/layout-alignment-ui.mjs` enforces all PB-E routes and transient states at 390 and 1280. The Tasks, navigation, phone sizes and signed-out entry checks use current route controls.

Complete local totals and the untouched-main baseline comparison accompany the PR.
