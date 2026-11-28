# FIX-6 default geometry and Saved chip review

Reviewed on main `a9b3e99`, including USG-A #285 (`b3ff21a`) and USG-B #286 (`443bb22`). The default pin stays at `bfe30f86`; widths, themes, history timestamp, route selection and snapshot collection stay unchanged.

## Review method

A temporary copy of `client-defaults-ui.mjs` used the same collector and exact comparator, caught comparison assertions per view, and saved every actual snapshot and failure under `.context/fix-6/`. Its baseline checkout was created by the test. The final acceptance run uses the original test command, with a fresh generated baseline.

USG-A supplies account-scoped plan accounting. USG-B mounts the shared Plan usage Section and Card in Models & access. The added section is 180px tall: a 24px section header, an 8px gap and a 148px card. Its following 24px section gap accounts for the 204px Page growth and downstream shift.

## All differing views

The audit collected all 208 views: 204 matched the pin completely and only these four differed. All 208 token maps match. No other Settings, Usage, shell or navigation geometry changed in the default matrix. Each exception records ten existing rectangles and three added nodes (Section, heading and Card).

| Reviewed view | Page height before to after | Reason |
| --- | --- | --- |
| `1280-dark-settings-subscriptions` | 605px to 809px | USG-B Plan usage section and 24px following gap; later sections move down 204px. |
| `1280-light-settings-subscriptions` | 605px to 809px | Same reviewed addition in desktop light theme. |
| `390-dark-settings-subscriptions` | 519px to 723px | Same reviewed addition in phone dark theme. |
| `390-light-settings-subscriptions` | 519px to 723px | Same reviewed addition in phone light theme. |

The temporary wrapper's `AUDIT: 208 views collected, 4 failures` line is its result; the inherited snapshot counter counts collected views, including failures. Replaying all collected snapshots through the committed comparator and manifest passes 204 exact matches plus four reviewed views.

## Design review

All four Subscriptions views were inspected against BUILD-SPEC sections 0b, 0c and 0d, including before/after screenshots and browser measurements. No usage-meter component repair was needed. Primary meter text is 14/20; secondary text is 13/18; section headings retain 13/18/600. The Card has a 1px border, 12px radius and 16px padding. Meter gaps are 8px, section gaps are 24px, controls retain their 44px minimum, and all labels remain complete. The added copy contains no test strings. Phone Back and desktop navigation remain available.

Settled visible word counts, excluding the sidebar and phone tabs: 390px 29 to 39; 1280px 52 to 62. The desktop figure includes Settings navigation. Content-only counts are 25 to 35 on phone and 28 to 38 on desktop, below the 49-word Models & access budget. The addition is 10 words in each view.

The existing sidebar usage audit additionally checks normal, warning, critical, no-limit, known/unknown CLI, own-key, loading, refresh, error, short viewport, drawer and collapsed rail states. It passed 57/57 checks. Its screenshot output was redirected to `.context/fix-6/usage-shots/`; assertions and fixtures were unchanged.

## Saved chip contrast

The Settings Agents Saved chip used the decorative `--color-success` token for text. Its light-theme contrast was 4.37:1, below the 4.5:1 requirement for this 12px label. The single CSS edit in `AppSettings.tsx` changes its foreground to the existing `--color-success-text` token. Background, type, dimensions and copy are unchanged.

| View | Before | After | Axe color-contrast | Geometry |
| --- | ---: | ---: | --- | --- |
| 390 light | 4.37:1 | 6.40:1 | Pass | Identical |
| 390 dark | 5.55:1 | 7.35:1 | Pass | Identical |
| 1280 light | 4.37:1 | 6.40:1 | Pass | Identical |
| 1280 dark | 5.55:1 | 7.35:1 | Pass | Identical |

These measurements use the rendered Saved state, computed foreground/background colors, WCAG relative luminance and axe-core's color-contrast rule. All four checks have zero violations and zero incomplete results. Comparing every visible layout node, the shell header and the Saved chip before/after applying the token gives identical rectangles, typography, padding, gaps and radii. No default geometry review or pin movement is needed for this fix. Evidence: `.context/fix-6/saved-contrast.json` and `saved-contrast.log`.

Fetched `origin/fix-a11y` at `f3059be5e76aa185be95ae7c3459d240e2dfda00`. Its AppSettings Add link accessible-name edit is on line 155; this fix is on line 128. A three-way file merge against the common base exits successfully and retains both changes. No FIX-A11Y edits are included here.

## Exact exception format

`reviewedDifferences` retains explicit before/after rectangles for existing nodes. An optional `insertions` array records each added node in full, including all captured styles and its exact rectangle. Each insertion is anchored to a full original node at an original snapshot index. Indices must be ordered, unique and within the pin; inserted rectangles must be finite and nonnegative in size. Only these explicit edits are applied to a clone of the pin, followed by full snapshot equality.

No tokens, styles, navigation, node ordering or unlisted geometry are ignored. Missing or extra nodes still fail. Reviews are rejected when the pin already matches. The 33 comparator tests cover the existing rules plus added-node geometry, styles, identity, order, missing/extra nodes, changed anchors and malformed entries.

Local evidence: `.context/fix-6/defaults-audit.log`, `failures.json`, `visual-review.json`, before/after PNGs, `usage-audit.log`, and the final check logs. Screenshots remain in `.context/`.

## Local validation

- `node --import tsx tests/ui-custom/unit/client-defaults-ui.mjs`: fresh **208/208 passed (204 matched, 4 reviewed)**, with all four reviewed views listed above. The final report fingerprint matches the committed collector and manifest.

- `node --import tsx tests/layout-alignment-ui.mjs`: 250/250 standard/dashboard views, 42/42 suggestion checks and 592/592 handoff views, zero issues.
- `node --import tsx tests/handoffs/demo-i.mjs`: 84/84 checks, zero real provider calls.
- `tests/handoffs/ui-quality.mjs`, filtered to all 14 `agentsSettingsScreens`: 112/112 Settings Agents views at 320, 390, 500 and 1280 in both themes, zero issues.
- Rendered Saved chip contrast: 4/4 at 390 and 1280 in both themes, with axe-core 4.14.1 and exact before/after geometry equality.
- `node --import tsx tests/navigation-every-route-ui.mjs`: 870/870 cases, run by width with `NAV_SIZES=320`, `390`, `500`, `768`, `1280`.
- `node --import tsx --test tests/ui-custom/unit/client-defaults-compare.test.mts`: 33/33.
- Sidebar usage audit: 57/57; plan usage display unit tests: 5/5.
- `npm run build -w web`: pass after the Saved chip change.

Navigation evidence is in `.context/fix-6/navigation-*.log` and `navigation-results.json`. Settings quality evidence is in `.context/fix-6/agents-quality-full/report.json`; the demo report is `.context/handoffs/demo-i/report.json`.
