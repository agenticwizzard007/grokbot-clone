# HO-I stage 2 Settings default geometry

After merging main `3842013` (UC-I #270 and FIX-1 #271), the Agents row changes 26 of the 208 default views. The baseline stays pinned to `5294c8567ff1c956a8731ad24e96437804cfcef7`, with the same timestamp, widths, themes and route count.

At 390 px, Agents adds a 48 px row to the Settings index. The Page, Workspace section and Workspace list grow by 48 px; the Connections section, heading and list move down by 48 px. Phone Settings detail views do not show this list and remain exact matches.

At 1280 px, the shared Settings sidebar gains a 44 px row and its existing 2 px gap. The Workspace section and list grow by 46 px; the Connections section, heading and list move down by 46 px. The content Page and its cards remain unchanged.

## Changed views

Each name below has its own plain reason and exact before/after rectangles in `tests/ui-custom/unit/client-defaults-baseline.json`. Entries are sorted by view name, one entry per line, and cover only Settings.

```text
1280-dark-settings
1280-dark-settings-account
1280-dark-settings-apps
1280-dark-settings-computer
1280-dark-settings-general
1280-dark-settings-keys
1280-dark-settings-learning
1280-dark-settings-mcp
1280-dark-settings-messaging
1280-dark-settings-permissions
1280-dark-settings-subscriptions
1280-dark-settings-usage
1280-light-settings
1280-light-settings-account
1280-light-settings-apps
1280-light-settings-computer
1280-light-settings-general
1280-light-settings-keys
1280-light-settings-learning
1280-light-settings-mcp
1280-light-settings-messaging
1280-light-settings-permissions
1280-light-settings-subscriptions
1280-light-settings-usage
390-dark-settings
390-light-settings
```

The reviewed-difference comparator applies only the recorded rectangles to the pinned snapshot, then compares the entire result. All token maps, styles, node counts, node identities and ordering stay unchanged. The other 182 views retain full snapshot equality; no view is skipped. The baseline pin and Flow/handoff views are unchanged.

Verification: web build and server/web typecheck pass; the requested unit/integration command passes 245/245, fresh defaults 208/208 (182 exact, 26 reviewed), handoff demo 84/84, layout alignment 208/208, and navigation 870/870. Logs are in `.context/handoffs/stage2/settings-baseline-review/`. The fresh run regenerated all pinned snapshots after an older cached Tasks snapshot exposed a loading fallback; no Tasks exception was added.
