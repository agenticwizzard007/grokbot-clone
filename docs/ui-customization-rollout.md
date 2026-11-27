# Dashboard and adaptation rollout

This runbook records the release gates. Local verification uses disposable QA-Temp-* accounts and the mock provider. CI is stopped; hooks remain enabled. UC-H merges last, after the other workstreams including UC-I. Deployment and each rollout stage remain separate release decisions.

## Evidence before release

Rebase on main and record both main and candidate SHAs. Run typecheck, the workstream suites, demo and alignment audit locally. Compare existing suites that import the auditor against the same main baseline: layout primitives, Settings v3, Paper Bots and Paper chat states. New failures block merging.

```sh
npm ci
npm run typecheck
npm run build -w web
UC_REQUIRE_FULL=1 node tests/ui-custom/run-all.mjs
UC_REQUIRE_FULL=1 node tests/layout-alignment-ui.mjs
UC_REQUIRE_FULL=1 node tests/ui-custom/demo-h.mjs
```

Archive command output, exact pass/fail/skip counts, reports, performance measurements and screenshots. A skip is incomplete evidence. The scope correction replaces the original cosmetic matrix and story with these gates:

- Ten journeys at 390 and 1280: chat dashboard creation and add/remove/reorder/resize, layout by chat, keyboard editing, recovery, two-tab sync, isolation, offline navigation, injection rejection, different requirements use cases, and requirement change/reset.
- Main's unchanged default alignment coverage plus default, dashboard and navigation routes: every widget type, empty and seeded, Preview, safe mode, and All sections.
- Zero serious or critical axe findings on default Bots/chat and those dashboard/navigation surfaces at both widths.
- XSS through API/import/agent, hostile CSS strings in navigation/dashboard enums, taint and injection, lockout recovery, account isolation and network boundaries.
- Recorded performance budgets for config reads and size, validation, data batches, dashboard content/CLS and lazy bundle size.

Required story evidence is the role/goal dashboard proposal, preview, confirmed add/remove/reorder/resize, reload persistence, Undo, safe mode recovery, two different requirements use cases with home/navigation/suggestions, a requirement change, All sections and reset. Screenshots are at 390 and 1280 under `.context/ui-custom/story/`; `manifest.json` lists completed steps. Do not add cosmetic fixtures or screenshots. Existing merged tests stay intact.

## Stages and flags

Start with the feature disabled. First enable only authorized test accounts, then a small cohort, then broader availability after reviewing the evidence and support signals. Users without config or requirements keep the defaults. Native shells require separate verification; web screenshots do not prove native behavior.

UC-B owns `UI_CUSTOMIZATION` and `account_preferences.ui_custom_enabled`. NULL inherits the environment, 1 enables and 0 disables; an explicit account override wins. There is no public flag endpoint. A disabled account must receive `404 disabled`, lose customization tools, bypass cached config and still render the normal app. To disable globally, clear explicit enable overrides as well as setting the environment off. Preserve documents and history.

UC-I adds `UI_ADAPT` and its account flag. Verify its exact released flag values and precedence before enabling a cohort. Profile-less accounts must remain unchanged. A profile update alone must not rearrange the app. Confirm preview/Apply, preserved hand edits, suggested Bots requiring confirmation, All sections reachability, and reset with Undo before expanding adaptation.

Do not call real providers during local verification. Optional natural-language evaluations and live test-account smoke checks require their own authorized release operation. No Fly resize is needed.

## Signals

UC-B's metrics sink emits `{metric,value,label?}` with allowlisted labels. Review counts and timings only; never attach documents, names, titles, widget data, credentials or message content.

| Signal | Review |
| --- | --- |
| `ui_preview_created`, `ui_preview_applied`, `ui_preview_discarded` | Apply/discard trends by release |
| `ui_patch_rejected` | Unexpected rejection codes or growth |
| `ui_undo`, `ui_reset`, `ui_safe_mode_entered` | Recovery spikes |
| `ui_dashboard_count`, `ui_config_bytes` | Counts and document size |
| `ui_data_request_ms` | Batch latency |
| `ui_agent_apply_mode` | Ask/auto counts |

Enforce the reviewed budgets in `tests/ui-custom/perf/baseline.json`: config read p95 below 30 ms, patch p95 below 20 ms, 24-request data batch p95 below 150 ms, dashboard first content below 500 ms and CLS at most 0.05. Reject regressions above 25 percent. Report missing measurements explicitly.

After an authorized deployment, verify `/api/version` equals the release SHA. On dedicated test accounts, build and edit a dashboard, reload, Undo, change requirements and Apply, visit All sections, reset, and recover through safe mode. Confirm another account inherits no changes. Review errors and metrics before advancing.

## Recovery and rollback

Offer Undo or `/?ui=safe#bots` first. The recovery banner reset keeps dashboards; Reset all removes them. Requirements reset clears the profile and restores arrangement through a preview while keeping dashboards. Confirm the intended scope for any administrator repair.

The existing utility `DB_PATH=/path/to/app.db node scripts/ui-config-reset.mjs <user-email>` resets all UI config, including dashboards, and works when customization is disabled. It does not implement a dashboard-preserving option or reset the separate requirements profile. For an explicitly authorized repair, verify the account and environment, use the normal backup process, and confirm the utility appends history and a new revision. Do not inspect or copy widget content into support tickets.

Invalid and future-version documents must fall back without automatic overwrite. Preserve additive tables and history when rolling back. Disable flags through the normal administration path and redeploy the known-good build. Confirm disabled routes/tools, default layout, cache bypass and version SHA. Record the failure and count-only diagnostics.

## First-user copy

"Tell your agent what you do and what you need to see. It can propose your home dashboard and navigation. Add, remove, reorder or resize widgets in chat. Preview changes before saving, and reset your requirements in About your use. All sections always keeps everything reachable."
