# Local validation record

All runs use local fixtures or disposable test databases. No live sign-in, provider account operation or manual deployment was performed. Existing workflow configuration is unchanged.

## Untouched-main baseline

Source: `3fbca49d3bd4807d70dc3e267b4dd49097af0813`, before this redesign and prerequisites #179, #180 and #181.

- Build and server/web typecheck passed.
- Focused chat, settings, connections, session, paging and voice units: 155 passed, 0 failed.
- QA suite: 110 units passed, 0 failed, plus 37 logged browser cases and MCP folder checks passed.
- Plan connections: 6 width/theme cases passed.
- Screenshot runner: 3 viewport journeys passed, 40 PNGs captured.
- Full unit sweep (`node --import tsx --test --test-concurrency=1 tests/*.test.mts tests/*.test.mjs`): 1,862 passed, 62 failed, 24 existing environment-dependent skips. Failures are in browser-recovery, cli-concurrency, latency, native-learning-lifecycle, release-gates and voice-coordinator. These are baseline results, not a green repository-wide test claim.
- Broad integrated browser inventory: 23 suites passed, 5 failed. Failures: work-paper-ui (Retry race), knowledge-paper-ui (settings navigation), bot-details-ui (old send payload expectation), suggested-integrations-ui (undefined fixture state), qa-r3-chat-ui (long-draft geometry). The integrated runner also stops in updated-ui-core on an old text-only send expectation; current main correctly includes a submissionId. Those API assertions are outside the owner's markup-only stale-test permission and remain unchanged unless separately authorized.
- Phone/tablet sweep: 338 views at 13 sizes passed, 18 existing tap-target warnings. The separate mobile-layout fixture exposes a 320px details-pane width issue, addressed in PR 1.

The prepared redesign regression fails on main at 390px because the resting composer measures approximately 102px instead of the 64px cap.

## PR 1, tokens and shell

Rebased onto #179, #180 and #181 after approximately 18 minutes of waiting. New shell checks verify the exact 752px desktop column, centering, 272px sidebar, 16px phone gutters and no horizontal page overflow at 390/1280/1440. Screenshots cover all required destinations. The long-name geometry assertion now permits a 60-character name without a label to fit the wider directory; full-text containment and long-label wrapping remain checked.

39 relevant unit tests pass. New shell journeys pass at all three widths; prerequisite visual polish passes four theme/width cases; mobile navigation passes five cases; settings simplification passes 53 icon/layout checks, 44 route/reload checks and 10 menu reopen cycles. Long-name and deep-link suites pass. Rebased again onto #182 and #183 before merge. The PR body records final checks.
