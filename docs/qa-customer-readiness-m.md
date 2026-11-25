# Customer readiness: stream M

All browser checks use local fixtures. No live account login or customer data is used.

- U4: phone messages previously shared a flex row with copy/time controls and an 80% bubble cap. At 390 the fixture measured 257.6px inside a 322px column. Phone bubbles now use 358px of a 358px column, with copy controls underneath and user bubbles capped at 85%. The desktop fixture remains 560px inside a 716px column. Subscription chips show Codex or Claude on phones, with the full model and billing description in title and accessible text.
- U7/U15: General passes draft description/instructions; Details passes the selected Bot's saved strings. The user, Bot and connection revision otherwise share the same cache keys. A stable DetailsPanel on baseline 6f2b15b reaches Retry within five seconds at 390 and 1280 in both themes. The reported ten-second stable-instance stall was not reproduced. However, the component-local deadline reset on every draft change and was lost on remount. A new regression fails on baseline when repeated edits/remounts prevent debounce from starting a request. Unfinished deadlines now survive those changes, so both mounts reach results, an empty message, or an error with Retry. Retry explicitly starts a fresh window. Late responses and account isolation remain covered.
- U8: subscription billing is identified as a ChatGPT or Claude plan. Codex copy explains model selection and links to ChatGPT usage and Settings > Models & access.
- U11: a searchable keyboard-accessible picker displays city names and current UTC offsets, ordered by offset, with common legacy aliases mapped to modern IANA IDs. Writes still contain IANA IDs. Unset accounts display Not set (using UTC), with a separate browser-zone suggestion. Messaging numbers have their own Bot number or Your number labels.
- U14: the phone Bots screen scrolls as a whole, including usage and account actions. There is no fixed footer overlay, and safe-area padding follows the footer. The last row is fully visible after scrolling.
- U21: model-ranked and fallback suggestions must meaningfully match the Bot's work. Generic summary/activity/message terms do not qualify unrelated apps; named apps rank first; the result list is capped at four. The saved-suggestions refresh note appears only after a refresh starts and disappears when it settles.

## Why the time zone appeared to change

There were three writers/display paths: TimeZoneRow displayed the browser zone while its hint described UTC; store startup silently PATCHed the browser zone into an unset account; and the primary Bot's update_profile tool could infer and save a zone during onboarding. Startup no longer writes a zone. The Bot prompt now requires an explicit request, and every Bot time zone write requires fresh chat confirmation, even if an old Always allow policy exists. The confirmation offers only one-time permission. A successful change appends a visible chat notice and sends the new zone to connected UI sessions. Explicit check-in schedule zones are preserved.

## Local checks

- `node tests/customer-readiness-m-ui.mjs`: actual app, DetailsPanel, Account and Messaging at 390 and 1280, light and dark, with touch emulation at 390.
- `node tests/suggested-integrations-ui.mjs`: results, empty, network errors, hung requests, Retry, cache refresh, account isolation, late replies, and repeated draft/remount changes before request start.
- `node --import tsx --test --test-concurrency=1 tests/time-zone-options.test.mts tests/account-time-zone.test.mts`: seven checks for option labels, aliases, DST, fractional offsets, Intl fallback, chat confirmation, visible change events and invalid IDs.
- `tests/app-suggestions.test.mts`: additional relevance and result-limit checks.
- Existing plan connections, model selector/menu, voice/composer and touch-copy browser regressions are also exercised.

Full unit results are compared by failure name against a detached checkout of baseline main. Existing browser failures are also checked on baseline rather than attributed to this change.
