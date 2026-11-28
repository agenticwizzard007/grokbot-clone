# Task workspace

The Tasks view groups work into the three states supported by the runtime. Needs input comes first; there is no empty, unsupported “To do” column.

| State | Column / filter | Primary card action |
| --- | --- | --- |
| `needs_input` | Needs input | Reply in chat |
| `working` | In progress | View progress |
| `done` | Done | View result |

Approvals, setup reviews, questions, and connection requests share the Needs input group. Their cards identify the request type and use the corresponding review action. Pending ordinary tasks show their full request note. Task cards show their owner and last update; the whole card is keyboard accessible and opens the owning conversation. Missing bots leave their tasks visible with disabled actions.

The page has a heading and Add task action, compact section navigation, a conditional review notice, and a toolbar for status, search, and bot scope. Review clears search and selects Needs input while preserving the chosen bot. Search matches task titles, notes, bot names, and pending requests, without case sensitivity. Status counts reflect the search and bot scope. The review notice always reflects all pending work in the chosen bot scope, so search cannot hide a request that needs attention.

All tasks is the default filter. Pending ordinary tasks sort oldest first; in-progress and completed tasks sort newest first. Each completed card retains the optional Send to agent action. Loop and handoff links have explicit labels and compact secondary styling. Add task opens a composer draft without sending it.

The desktop board uses three columns above 880px of available content width. Smaller surfaces stack the groups and use multiple cards per row when space permits. At 500px and below, cards become one column and status filters form a two-by-two grid. Controls retain a minimum 44px height. Text fields use 16px text on phones to avoid focus zoom. The app shell supplies the sidebar, back navigation, and phone tabs.

Loading and unavailable counts remain distinct from zero. Failed refreshes retain previous cards and an actionable retry. Searches do not report a successful empty state while a relevant data source is unavailable. Light and dark themes use the existing semantic color tokens.

## Paper source

Created through Paper Desktop MCP in [Swarms · Design delivery · Start here](https://app.paper.design/file/01M7XRD50KB121YXVPQPK0VG7S/p-3-0):

- **Tasks · Refined workspace · Desktop**
- **Tasks · Refined workspace · Mobile**

The implementation uses the design’s exported JSX and computed styles: Instrument Sans, 28px page headings, 14px task titles, 12px metadata, 32px desktop / 16px mobile horizontal gutters, 20px column gaps, and 16px card padding. Existing theme, density, and font-size tokens are preserved. Artboards use illustrative task data; the app continues to render API data and the existing bot avatars.

## Verification

Run `npm run typecheck -w web && npm run build -w web && npm run test:tasks`.

The isolated browser test covers 320, 390, 500, 768, 1280, and 1440px in light and dark mode. It checks search, status and owner filters, Review from a conflicting search, ordering, live updates, stale data, retry, keyboard navigation, long identifiers, missing bots, empty states, stable section navigation, and task creation drafts. Selected phone and desktop cases also check approval navigation, incomplete search results, initial failures, loop links, Send to agent dialog/focus restoration, and automated WCAG accessibility checks.

Screenshots are saved under `.context/tasks-refined/`. No live account or model provider is used.
