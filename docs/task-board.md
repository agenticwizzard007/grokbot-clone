# Task board

The Swarms Tasks view uses a card-and-column layout and the task states already supported by the runtime:

| Runtime state | Column | Card label | Action |
| --- | --- | --- | --- |
| `needs_input` | Pending | Needs you | Reply in chat |
| `working` | In progress | In progress | View progress |
| `done` | Done | Completed | View result |

Pending cards come first, ordered by the oldest request for input. Other cards show the latest update first. An amber “Needs you” badge, a question icon, a stronger neutral border, and an explicit reply action distinguish pending work without relying on color. The pending request is shown in full. Clicking a card opens the owning bot’s conversation, where the user can answer questions or approve actions.

The dashboard follows the app’s existing composer and menu styling: white surfaces, 24px card corners, subtle borders and shadows, neutral selected controls, and rounded action pills. The pending summary uses the composer’s thin spectrum border and restrained exterior glow. The design scope is the Tasks content panel: its header, summary, filters, and task cards. The existing platform supplies the sidebar, account controls, outer navigation, and mobile device chrome.

The page shows all tasks by default. State filters and the bot selector work together, and all counts reflect the selected bot. A pending summary links to the pending filter. The summary has no redundant action while Pending is selected. Completed tasks remain available in the Done filter. Missing bots leave their tasks visible with a disabled action and an explanatory label.

Above 880px of available content width, the board has three columns. Below that, status groups stack vertically; cards can use two columns on tablets. At 500px and narrower, cards become a single list and all four status filters remain visible with 44px-or-larger targets. There is no horizontal board scrolling on phones. Each bot’s details panel uses the same status labels and card treatment. Light and dark themes share the same hierarchy.

Task events and connection changes refresh the data. A failed request shows a retry action rather than a successful empty state. A failed refresh preserves the last known cards and explains that they may be stale.

## Swarms design

The Swarms task board supports web and mobile layouts:

- **Tasks · Web · All tasks**: all nine sample tasks across Pending, In progress, and Done, with a pending summary, owner filter, and explicit card actions.
- **Tasks · Mobile · Pending**: a 390px phone layout with visible status filters and counts, three full-width pending cards, and a clear reply action on every card.

Both layouts use Swarms bot avatar shapes and shared composer styling. The web design is 1090px wide and the mobile design is 390px wide, with heights that fit the full content. The shared app implementation mounts the Tasks panel within the existing app shell.

## Verification

Run `npm run build -w web && npm run test:tasks`.

The isolated Playwright test uses sample data and checks 320, 390, 768, 1024, and 1440px layouts; task and bot filters; pending ordering; live updates; keyboard navigation to the correct bot; initial and refresh failures; retry; empty states; missing bots; long content; and dark mode. It does not call model providers or modify real tasks. Screenshots are written to `.context/tasks/`.

`npm run test:mobile` covers the existing mobile navigation and native app shell flows.
