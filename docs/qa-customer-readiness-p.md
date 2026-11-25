# Customer readiness P

Scope: U21 suggested integrations, U19 customer Setup and Harness text, U26 Files summaries.

## Reproduction and causes

On untouched `1ef3439627c74142506970d3de14a14edf3b90f2`, the exact description
"When asked, read the user's latest Slack messages and return a concise summary in this chat"
with instructions "Return concise summaries of messages in this chat. Do not send email."
returned Slack, BlueFox Email, Benchmark Email and Google Chat from the local fixture.

The filter treated any shared app-name token as relevance. Thus "chat" selected Google Chat and "email" selected the two email products. The alternative two-description-token test also admitted generic summary tools. Catalog categories influenced ordering, and model selections still passed through this permissive filter. The fallback used the same eligibility rule.

There are no database-backed suggestion records in this revision. The server ranker and `cachedSuggestions` hold memory-only snapshots. The route rechecked server cached rankings, but the browser could display an old unversioned snapshot during refresh or failure. Both cache namespaces now include `purpose-2`; the response carries that version and the client rejects old or unversioned responses. Successful responses use `Cache-Control: no-store`. Setup events also invalidate browser snapshots.

U19's earlier formatter only covered resource lists and Markdown file previews. Harness standing text, assembled instruction previews, working style, workflow fields and other Setup fields still rendered raw generated strings. A shared formatter now handles every connection enum at render time. Generated customer brief fields also normalize connection words, and the setup generator is told to use plain words. Stored Bot instructions are not rewritten. Expired connections say "Slack needs to be reconnected" and offer Connected apps without starting authorization.

U26's saved-report row had only an action, with no content read. Setup was a generic computer-folder row with no independent empty state. Files now reads report and setup availability separately and shows a specific empty, populated, loading or unavailable state for each. The Setup row opens the existing configuration view; the synthetic Setup folder is not duplicated.

## Validation

- `tests/fixtures/slack-summary.mjs` contains the exact description and realistic generic communication text, including an old conflicting email purpose.
- `tests/app-suggestions.test.mts` tests the exact fixture on model, fallback and cached route paths, connected exclusion, Gmail triage, CRM capability matches and normalization of new customer briefs.
- `tests/suggestion-cache.test.mts` proves old saved snapshots and old server responses cannot be displayed, including during errors.
- `tests/customer-copy.test.mts` covers every mapped enum, sentence grammar, Markdown preservation and non-mutating render copies.
- `node --import tsx tests/customer-readiness-p-ui.mjs` runs the full app at 1280 and 390 in light and dark. Both mounts use the production filter with noisy model choices. It verifies connected exclusion, old response rejection, Harness and Setup text, Files reconnect navigation, independent empty states, and horizontal overflow. Screenshots are under `.context/readiness-p/`.
- Existing suggestion, saved-report row, setup-copy and customer-phone-polish browser suites are included in the regression checks.
- The older active-setup browser test expected "Active configuration · Revision 32" on both untouched main and this branch. The UI already omitted that internal revision. Its assertion now checks the plain heading and verifies revision 32 in state.

Full-suite results, using `node --import tsx --test --test-reporter=tap --test-concurrency=1 tests/*.test.mts tests/*.test.mjs`:

| Checkout | Pass | Fail | Existing skips | Total |
| --- | ---: | ---: | ---: | ---: |
| Untouched `1ef3439` | 2,117 | 71 | 24 | 2,212 |
| Stream P final run before rebasing onto PR #201 | 2,123 | 72 | 24 | 2,219 |

The extra failing name, `cloud drain rechecks authorization after inventory waits and never issues a revoked stop`, also failed on untouched main in a supplemental run of `tests/legacy-background.test.mts`. That baseline rerun was 11 pass / 2 fail; the same unchanged file passed 13/13 on the branch rerun. Both baseline rerun failures were deadline races. Comparing all observed baseline names yields no new failure names. No tests were skipped or disabled by this change; the 24 skips are identical to the untouched baseline.

The focused P and earlier resource-copy tests pass 43/43. After rebasing onto `f50b0df` (PR #201), the combined P/Q checks are recorded in the PR. The rebase preserves the new composer plan label as well as the suggestion response version in the shared readiness M fixture.

Baseline uses an isolated checkout of `1ef3439`, with the same dependencies and Node version as the changed checkout. No live sign-in or customer data is used.
