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

64 relevant unit tests pass, including the newly merged chat-speed and stop/voice tests. New shell journeys pass at all three widths; prerequisite visual polish passes four theme/width cases; mobile navigation passes five cases; settings simplification passes 53 icon/layout checks, 44 route/reload checks and 10 menu reopen cycles. Long-name and deep-link suites pass. Rebased again onto #182 and #183 before merge. The PR body records final checks.

## PR 2, composer and chat

The compact composer is 62px at rest. New three-width checks verify the round far-right mic, Send replacing it within 2px on all axes, no simultaneous mic/Send, single-line chip, multiline growth/cap and scrolling, bubble clearance including classic scrollbar gutters, hidden/hover/scroll thumb states, incoming-row position preservation, earlier-content expansion, Jump to latest and bottom following. Group chat checks the same action-slot geometry.

71 focused unit tests pass, 0 fail. Typecheck and build pass. Paging passes four widths; stop/voice recovery and chat-open each pass two widths; voice apps passes desktop and native/mobile; model selector passes six width/theme cases; model menu passes six widths; menu stacking passes two widths. QA chat passes redaction, long-draft resize/plan labels and Stop focus. Visual polish passes all four width/theme cases; its provider-button fixture now uses key reauthentication because #183 replaced subscription reauthentication markup with a recovery screen. The voice-entry suite passes draft/selection/keyboard and concurrent-work cases before an existing cancellation assertion fails; reproduced on untouched prerequisite main `0e8de1f`. That test expects a late cancelled session to issue `/api/voice/end`, whereas the merged voice-startup fix aborts the pending request. This unrelated request assertion is unchanged.

Legitimate test updates: jump accessible label, compact-row versus multiline bounds and cap, voice moved into the plus menu while typing/running, 16px bubble padding, side-by-side input/chip non-overlap, picker inline effort when the right-aligned anchor leaves insufficient flyout room, and rounded-corner hit-test points. The menu fixture now expects the 24 rendered initial history rows introduced by #182. Full API payload assertions remain unchanged.

## PR 3, settings and final evidence

Models & access has 24px between every top-level plan block in both Codex and Claude Code tabs. Rows have 16px icon/text gaps, 16px bottom padding and 4px label/helper gaps. Expanded account details use 16px row and 24px column gaps; advanced bridge content uses 24px padding/gaps. The 752px desktop settings column and 16px phone gutters align with chat. Create Bot, Bot settings and sign-in use shared spacing, title line heights and control radii. All routes, section identifiers, grouped Lucide icons and account metadata are retained.

56 focused unit tests pass, 0 fail. Build and typecheck pass. The full redesign runner passes all three viewport journeys with shell, mic/send, compact/multiline, scroll and both-provider spacing assertions. The final capture has 40 before and 40 after PNGs with matching names.

Browser regressions: settings simplification (53 icon/layout checks, 44 cold/reload cases, 10 rapid reopen cycles), delayed settings loading (2 widths), visual polish (4 width/theme cases), plan connections (6 width/theme cases), connected-account details (2 widths), access/session/MCP/key workflows, sign-in asset budget plus dev/built entry (4 viewport cases), mobile layout (9 cases), toast layout (15 cases), and QA settings (4 widths plus feature checks). Existing fixture suites that default to port 5193 were rerun against the active local Vite at 5198. One deep-link run hit an app-load timeout at 1440px during concurrent suite startup; the clean serial rerun passes all five widths. Draft retention passes with live and missed Bot events; create/import copy passes. Final PR 3 browser result: 14 suites passed, 0 failed.

The only PR 3 stale assertion change is provider-button spacing, now 16px instead of 12px. No tests, test workflows or CI gates were disabled. Repository-wide baseline failures listed above remain outside the UI changes; no old text-only API request assertion was changed.
