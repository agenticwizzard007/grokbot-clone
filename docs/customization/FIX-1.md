# FIX-1 default-layout baseline review

Compared the original pin `fc3eab7` with main `e0d2cf9`, using the local layout seed, no customization, 390 and 1280 px, light and dark. All 208 token maps are unchanged. 184 route views match exactly; the 24 differences below all come from reviewed HO-G PR #265 (`b33d36a`). The later UC-G merge adds no differences to this default matrix.

The audit recorded both checkouts with the snapshot collector from `tests/ui-custom/unit/client-defaults-ui.mjs`. Full results are in `.context/fix-1/defaults-diff.json`. Chat was also recorded with its transcript and seeded coworker review loaded: all eight chat/room views match. Waiting for that data avoids accepting an initial loading state as a baseline.

| Differing route view | Reviewed reason |
| --- | --- |
| `1280-dark-bot-activity` | HO-G makes Flow the default for a new bot; the Flow page replaces Activity statistics. |
| `1280-dark-bot-setup-files` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-dark-bot-setup-harness` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-dark-bot-setup-history` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-dark-bot-setup-responsibilities` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-dark-bot-setup` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-light-bot-activity` | HO-G makes Flow the default for a new bot; the Flow page replaces Activity statistics. |
| `1280-light-bot-setup-files` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-light-bot-setup-harness` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-light-bot-setup-history` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-light-bot-setup-responsibilities` | HO-G adds the Agent flow compact card above the Setup content. |
| `1280-light-bot-setup` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-dark-bot-activity` | HO-G makes Flow the default for a new bot; the Flow page replaces Activity statistics. |
| `390-dark-bot-setup-files` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-dark-bot-setup-harness` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-dark-bot-setup-history` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-dark-bot-setup-responsibilities` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-dark-bot-setup` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-light-bot-activity` | HO-G makes Flow the default for a new bot; the Flow page replaces Activity statistics. |
| `390-light-bot-setup-files` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-light-bot-setup-harness` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-light-bot-setup-history` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-light-bot-setup-responsibilities` | HO-G adds the Agent flow compact card above the Setup content. |
| `390-light-bot-setup` | HO-G adds the Agent flow compact card above the Setup content. |

Source evidence: `web/src/components/DetailsPanel.tsx` selects the Flow default and `flow-page`; `web/src/components/config/AgentConfiguration.tsx` adds `FlowCompact` before every Setup subtab. These changes are in `git show b33d36a -- web/src/components/DetailsPanel.tsx web/src/components/config/AgentConfiguration.tsx`.

The baseline retains 208 views, the same widths, themes and fixed history timestamp. Its checkout directory now includes the pin, so a cached old checkout cannot survive a pin change. No geometry assertion or token comparison was removed. The collector waits for the actual details page, transcript and coworker review before measuring; immutable assets can use the browser cache.

FIX-1 routes Flow and its link sheet through shared navigation and removes the temporary duplicate header. Invalid flow models use the existing Retry state. Detail tabs can wrap on narrow desktop panes so the added Flow tab keeps every label visible. No theme or font code changed.
