# Login, Connections and bot sidebar refinements

The selected bot’s details now open beside the conversation on wide screens. The same controls occupy the conversation area on compact screens, with clear close/back actions. This restores the curated sidebar requested in the design reference while keeping tasks, routines, files, setup, computer and voice available.

## Design decisions

- **Login:** a compact, centered layout keeps the brand and recognizable provider icons visible at every width. Full-width controls have touch-friendly targets. Provider availability and registration gates still come from the server. Google and OpenRouter disclosures remain visible beside their options.
- **Connections:** logos, names, descriptions and actions follow consistent rows. Search and category filters use the real catalog; connected-app counts link to the connected view. Wide containers use two columns; phones and compact landscapes use one. Account records clearly distinguish active/default, disabled and expired states. Dialog content scrolls together so filters never obscure the directory or its footer.
- **Bot details:** avatar, name and current activity introduce the panel. Activity combines upcoming routines, scoped tasks and goals, suggestions, computer and voice. Tasks, Files and Setup remain direct destinations. Cards use the existing color tokens, Inter body text and Instrument Sans headings in Light and Night.
- **Chat continuity:** desktop users can type and send while details are open. At 1100px and below, details take the conversation area and retain the draft. Closing returns focus to the opening control, including the bot-name menu. Compact voice entry reveals the active call’s mute/end controls; hiding the composer cancels dictation without submitting audio.
- **Working avatars:** every identity rendered through `BotAvatarFor` derives its flying-bird state from that bot’s user-facing activity. Awaiting-input, idle and internal-only states keep a static identity. Reduced-motion preferences and static avatar-editor previews are respected.

## Verification

Automated local-fixture browser checks cover desktop, tablet, short landscape and 320/375/390px phones in Light/Night, including keyboard routes, overflow, account changes, scoped task/routine payloads, draft preservation, voice cancellation/call controls and moving avatar pixels. Existing integrated Work, Knowledge, Access, model/usage, setup/import and Hermes journeys continue to run. Voice lifecycle and results-client tests use mocked transport; authenticated UI checks use local fixtures or isolated local test servers.

The release handoff preserves exact source hashes, commands, results, independent reviews and screenshots under `.context/login-evidence/`. Production identity/assets and signed-out responsive checks are performed separately after the coordinated release. No real provider authorization, connected-device operation or microphone session is part of the fixture checks.
