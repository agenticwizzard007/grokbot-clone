# Customization rollout runbook

This runbook describes the release gates. It does not authorize a deployment, production data repair, or a rollout stage change. Local verification uses only disposable QA-Temp-* fixtures and the mock provider. CI is stopped: local checks are required, hooks remain enabled, and main is never force pushed.

## Release evidence

Merge UC-H last, after contracts, service, runtime, agent, shell, dashboards and Settings. Rebase on main, install from the lock file, then run:

```sh
npm ci
npm run typecheck
UC_REQUIRE_FULL=1 node tests/ui-custom/run-all.mjs
UC_REQUIRE_FULL=1 node tests/layout-alignment-ui.mjs
UC_REQUIRE_FULL=1 node tests/ui-custom/demo-h.mjs
UC_REQUIRE_FULL=1 node scripts/ui-customization-demo.mjs
```

Run existing suites that import the alignment audit: layout primitives, Settings v3, Paper Bots and Paper chat states. Compare failures with main at a recorded SHA. A pre-existing failure must be identified with matching evidence; new failures block merging. Never count SKIP as PASS.

Archive report JSON, command output with pass/fail/skip counts, main and candidate SHAs, performance measurements and screenshots. Required story screenshots: theme request/card/banner at 390 and 1280, applied theme after reload, dashboard request and live preview, applied dashboard at both widths in both modes, Undo, Appearance and safe mode recovery. Files live in `.context/ui-custom/story/`; the manifest records which steps actually ran.

The full gate requires ten journeys at both widths, zero enforced alignment issues, zero serious/critical axe findings across four presets/two modes/two widths/four routes, the security corpus through all three ingress paths, isolation/recovery, and every performance budget. A skeleton run with unavailable endpoints is development evidence only.

## Stages

| Stage | Flags and audience | Entry | Exit |
| --- | --- | --- | --- |
| 0 Dark launch | `UI_CUSTOMIZATION=off`, all accounts | All workstreams merged; local main gate has no new failures | Deployed version equals main SHA; default computed styles unchanged |
| 1 Internal | Global remains off; admin `ui_custom_enabled` override for test accounts | Stage 0 healthy for 24 hours; explicit stage decision | NL evaluation at least 90% first attempt and target 98% within three repairs; e2e/security on deployed build; no unexplained safe mode entries; manual 390/768/1280 pass |
| 2 First users | `UI_CUSTOMIZATION=on`; account default on | Stage 1 healthy for 48 hours; explicit stage decision | Apply/discard trends reviewed; support issues below 2% of users in one week; p95 budgets held |
| 3 General | Default on for everyone | Stage 2 healthy for one week; explicit stage decision | Help center published; remove feature flag after one more release |

Stage 0 deployment and enabling Stage 1 or later are separate decisions. Do not run real-provider NL evaluations during local verification. Their optional rollout evaluation is a separate authorized operation. Native shells loading the web UI still need explicit verification; web screenshots do not prove native behavior.

## Enable and disable

The service owns `UI_CUSTOMIZATION` (`off` or `on`, initially off) and the per-account `ui_custom_enabled` admin override. Use the deployment's existing environment and account administration mechanisms after the relevant stage is approved. UC-B stores the override in `account_preferences.ui_custom_enabled`: NULL inherits the environment, 1 enables, and 0 disables. An explicit account value wins even when the environment is off. Use an authorized account administration path; there is no public user-facing flag endpoint.

To disable one account, set its admin override false and confirm authenticated `/api/ui/config` returns `404 disabled`, UI tools disappear, cached config is ignored, and the existing app still renders. To disable globally, set `UI_CUSTOMIZATION=off`, clear explicit enable overrides because account overrides win, restart through the standard deployment process, and run the same smoke. Preserve configuration and history tables. No schema rollback or machine resize is needed.

UC-B owns the concrete admin override interface, reset script and metric sink. If their implementation is unavailable, stage changes and repair remain blocked; a guessed command is not a runbook substitute. Review this section against UC-B before rollout.

## Health checks

Use the service's operations metrics sink or count-only JSON logs. Never attach documents, titles, widget data, keys or message text to metric labels.

| Signal | What to review |
| --- | --- |
| `ui_preview_created`, `ui_preview_applied`, `ui_preview_discarded` | Apply/discard rates and changes by release |
| `ui_patch_rejected{code}` | Unexpected error codes or rejection growth |
| `ui_undo`, `ui_reset{scope}`, `ui_safe_mode_entered` | Recovery spikes; investigate safe mode from normal use |
| `ui_dashboard_count`, `ui_config_bytes` | Counts, median document below 4 KB, hard cap 256 KB |
| `ui_data_request_ms` | p95 below 150 ms under the seeded load profile |
| `ui_agent_apply_mode` | Ask/auto counts only |

Also verify config read p95 below 30 ms, typical compressed response below 16 KB, token application below 4 ms, validation p95 below 20 ms, dashboard first content below 500 ms, CLS at most 0.05, and bundle/font budgets from section 16. Fail measurements over budget or more than 25% slower than the reviewed baseline.

After deploy, `/api/version` must match `git rev-parse origin/main`. On a dedicated authorized test account: preview a theme, Apply, reload, Undo, open safe mode, confirm Settings remains reachable, and verify another test account does not inherit any change. Review errors and metric deltas before advancing.

## Repair with history preserved

First offer the user Undo or the safe-mode URL `/?ui=safe#settings/appearance`. Reset appearance keeps dashboards; Reset all removes them. Confirm the intended scope before any administrator repair.

UC-B provides `DB_PATH=/path/to/app.db node scripts/ui-config-reset.mjs <user-email>` for an explicitly authorized repair. The path must name an existing database. This command always resets scope `all`, including dashboards, and remains available when the feature is disabled. It does not implement an appearance-only flag. Confirm dashboard removal and the target environment, take the normal authorized backup, and use only the identified account. Verify that the script appends history and a new revision rather than deleting history. Confirm the account can load Settings, and that unrelated accounts remain unchanged. Never inspect or copy widget content to a support ticket.

For an invalid or future-version document, preserve the stored JSON for the authorized recovery path. The app must fall back without overwriting it automatically. If the reset utility or account targeting cannot be verified, stop the repair and request UC-B support.

## Rollback

Disable the feature, preserve additive tables and history, and redeploy the known-good build using the normal release process. Confirm disabled routes and tools, cache bypass, default layout, and version SHA. Recovery must not require a database rollback or a Fly resize. Record what failed, the release SHA, count-only diagnostics and rollback verification.

## First-user copy

"You can change how Swarm looks by asking your agent. Try: Make it dark with a teal accent. You can always undo, and Settings, Appearance has everything in one place."
