# Customer readiness R16 UU

All four reported copy findings reproduce in source at `30a1da3`.

1. Saved work used Library in `save_file` and Transcript, Reports in the work page, Saved reports in the saved list, and Files in Bot details. The customer-facing destination is now Files, including View Files, the page and document titles, navigation, details summary, empty states, delivery labels and synopsis return links. The internal Reports route, library delivery channel, approval payload and Bot scope are unchanged. Historical View saved files links remain supported and repeated links are still suppressed by the app-rendered tool result.
2. Remaining static customer copy used agent in workflow validation and errors, Permissions, setup, device access, history, skill controls and a call tooltip. It now says Bot. The computer status and viewer say Starting the computer, while local connection progress retains Connecting to your computer. Internal identifiers, stored user text and model instructions are unchanged except the save tool's destination description.
3. Missing Usage and Analytics figures use a hyphen, synopsis quiet hours use to, and the saved MCP token placeholder uses a hyphen.
4. Search opening progress says Loading the message...

No layout, approval policy, voice-start behavior, provider configuration or save routing changes. No production sign-in or customer data access. CI and Fly configuration are unchanged.

Validation uses an untouched detached `30a1da3` checkout on this VM and the same Node 24.22.1 and dependencies as the candidate. Full-suite command:

```
node --import tsx --test --test-reporter=tap --test-concurrency=1 tests/*.test.mts tests/*.test.mjs
```

`npm run test:readiness-uu` covers navigation and computer status units, legacy and current save links, and local browser fixtures at 1280 and 390 in light and dark. Browser coverage includes populated and empty Files pages, Bot details, absent Bots, Permissions, computer startup and both connection labels, quiet hours, MCP placeholder, missing Analytics and Usage figures, and workflow lookup and validation errors. Screenshots are in `.context/readiness-uu/`.

Existing saved-file result checks exercise both installed CLI providers with local model fixtures, no provider account or live calls. They verify app-rendered results before the model reply, reload persistence, no duplicate links, same-tab navigation, the saving Bot's list and downloadable bytes. The saved-file link check also covers copied links and unavailable Bot scope. Existing details-label, work-route title, navigation and transcript paging checks retain their original behavior assertions with the updated copy.

Final full-suite counts, failure-name comparison and deployment verification are recorded in the PR.

The older `work-paper-ui.mjs` stops at its line 184 task-filter assertion (`all` versus the selected Bot) on both untouched baseline and candidate, before the Files checks. That existing failure is outside this copy change. The current scoped-route tests pass, including loading, unavailable Bots and retry behavior.
