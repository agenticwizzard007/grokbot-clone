# Swarm layout redesign

Swarm keeps its navy and lavender palette, bird artwork, name, Inter body font and Instrument Sans headings. The layout follows the owner's Grok Bot description: a compact Bots rail, calm central conversation, floating composer, and grouped settings rows. Light theme remains supported alongside Night; saved appearance preferences are preserved.

## Layout grid

| Viewport | Sidebar | Chat column | Outer gutters |
| --- | --- | --- | --- |
| 390px | Full-width Bots screen; hidden in chat | 358px | 16px |
| 1280px | 272px, collapsible to 76px | Up to 752px, centred in remaining pane | At least 32px; 128px when details are closed |
| 1440px | 272px, collapsible to 76px | Up to 752px, centred in remaining pane | At least 32px; 208px when details are closed |

The sidebar header is 40px with 16px below it. Sidebar padding is 16px; Bots rows are at least 64px with 8px vertical and 12px horizontal padding. The main Bot directory and settings column share a 752px maximum. Desktop chat has a compact context row and 64px identity header. Details retains its existing adjacent desktop pane and replaces chat on compact screens. Phone navigation, safe areas and all existing route/hash behavior remain intact.

## Tokens

- Spacing: `--space-1: 4px`, `--space-2: 8px`, `--space-3: 12px`, `--space-4: 16px`, `--space-5: 24px`, `--space-6: 32px`, `--space-7: 40px`, `--space-8: 48px`, `--space-9: 64px`. Main layout uses multiples of 8; 4px half steps are for icon gaps and compact controls.
- Type: Inter body 14/20, helper 13/20, caption 12/16, chat 15/24. Instrument Sans page title 24/32, phone title 22/28, panel title 17/24. Weights 400 regular, 500 medium and 600 semibold. Existing font assets and licenses stay in place.
- Radius: 8px small controls, 12px rows and buttons, 16px cards and bubbles, 24px composer, 9999px pills and round actions.
- Color: existing semantic Light/Night tokens; Night chrome/sidebar #17222F, pane #1D2A3B, elevated #253348, lavender primary #B5C1FF. Light primary #3043AB. No Grok branding assets.
- Elevation: subtle existing composer/popover tokens, a single border per surface, no stacked card outlines. Menus retain their focus ring and correct stacking above the transcript.

## Composer

The floating composer stays at the bottom of the chat flex column, outside the scrolling transcript. Its width matches the conversation. At rest it is 62px tall (64px test ceiling), with one 24px text line and 44px action targets. The phone placeholder is the compact `Message`, with the complete Bot name retained in its accessible label. The plus sits at the left; the model/billing chip is one line inside the composer; the circular microphone is the far-right action. Typing replaces the microphone with Send in the same 44px slot. A running empty draft shows Stop in that slot. Live voice and dictation remain reachable through existing voice controls and the plus menu when Send or Stop occupies the slot.

Long drafts grow upward within `clamp(112px, 24dvh, 240px)`, then scroll inside the textarea. At phone widths the model chip remains on one line and truncates its model name as necessary; the full selection remains accessible through its label and picker. Multiline mode moves the textarea above the same left/chip/right control row. Phone bottom padding is at least 16px and includes the real safe-area inset. No new fixed overlay covers the final message or keyboard.

## Transcript and scrolling

The content column has a dedicated 8px clearance from a thin 6px scroll rail. Scrollbar track is transparent; thumb is hidden at rest and appears on hover, keyboard focus or scrolling. The reserved gutter prevents geometry shifts and overlapping bubbles on systems with classic scrollbars. Bubble padding is 16px, message-group gap 16px, compact same-sender gap 4px. Existing sender attribution, timestamps, cards, interrupted replies, exchanges and group-chat behavior remain available.

Follow new content only when already within 40px of the bottom. Scrolling away preserves the visible row, including updates that resize earlier content and older-history paging. Show a labelled `Jump to latest` pill when away from the bottom. Activating it follows the bottom again, respecting reduced motion. Resize and late content growth follow the same rule. Search keeps its explicit destination and highlight. No forced jump on incoming messages while reading history.

## Settings and plan spacing

Keep the incoming settings simplification's Lucide icons, grouped navigation, SettingRow icon support, controls and tests. A row contains a 20px icon, label plus optional helper line, and trailing control. Use 16px vertical row padding with flat, aligned group edges, 16px icon/text/control gaps, 4px between label and helper, and 24px between groups. Row labels use 15/24 medium and helpers use 14/20 regular. Long content wraps without displacing controls outside the viewport; phone rows may stack a full-width control beneath the text.

Models & access uses 24px between its heading, `Choose how models are billed` group, provider tabs, plan connection block and advanced options. Inside each block use 16px padding and 8px or 16px gaps. Plan, Codex and Claude Code controls keep their official login, recovery, account-binding and disconnect behavior. Connections retains account email, status and connected-at details when supplied, plus explicit disconnect confirmation. Bot settings, Settings home, create Bot and sign-in use the same type, radius and spacing tokens. Sign-in retains existing provider gates and one primary action.

## Provenance and coordination

Paper MCP not available. Checked the environment's available tool catalog once on 2026-11-23 at task start.

Repository sources inspected:

- `9e21ecd`, Initial open-source release of grokbot-clone. Its README explicitly identifies Grok Bot as the layout inspiration; its original `shell.css`, `chat.css` and `tokens.css` preserve the compact rail, floating composer and bubble component geometry. These are historical layout references only; current Swarm branding and the owner's requested dimensions take precedence.
- `0ff0b857`, Implement the accepted Swarms UI and complete consumer feature access.
- `docs/updated-ui.md`, accepted Paper V13 directory, implementation provenance, route and feature inventory: https://app.paper.design/file/01M7XRD50KB121YXVPQPK0VG7S/p-1-0. Native exports and receipts described there are outside Git and unavailable in this workspace.
- `docs/agent-configuration-design.md`, Paper brand and settings links: https://app.paper.design/file/01M73GPA3GPRHEBRRXNDC09HDV/p-H-0 and https://app.paper.design/file/01M73GPA3GPRHEBRRXNDC09HDV/p-A-0.
- `docs/usage-mode-design.md`, earlier composer/billing layout, superseded by the owner's one-line chip requirement: https://app.paper.design/file/01M73GPA3GPRHEBRRXNDC09HDV/p-2-0.
- `docs/ui-refinements-20261122.md`, sign-in, Connections, Bot details, responsive and focus requirements.
- `web/src/styles/tokens.css`, `shell.css`, `paper-core.css`, `setup-paper.css`, `composer-models.css`, and self-hosted `web/public/assets/fonts/` and Swarm SVG assets.
- Merged PRs #9, #12, #49, #71, #72, #73, #74 and #75 describe earlier settings, Paper, voice, accepted UI and later layout changes. No checked-in Grok Bot screenshots, Figma exports or native Paper exports were found.

Initial main baseline: `3fbca49`. The settings simplification and 12-item visual polish workspaces were active at start; waited approximately 18 minutes, then rebased onto merged PRs #179 (account details), #180 (settings) and #181 (visual polish). Also rebased onto #182 (chat opening speed) and #183 (stopped replies and voice recovery), then onto latest main before each merge. Existing connection-detail, chat recovery, voice and chat-speed fixes are retained.

## Delivery and verification

1. Tokens and layout shell, this spec, baseline screenshots and shell checks.
2. Composer, transcript scroll behavior, bubbles and group chat with geometry and incoming-message checks.
3. Settings, plans, Connections, Bot settings, create Bot and sign-in with spacing checks and final screenshot inventory.

Local Playwright fixtures only, no live login or real user data. Capture the same deterministic scenes at 390, 1280 and 1440px in Night under `docs/design/redesign/before/` and `after/`; working capture files first live under `.context/`. Cover sidebar, Bot directory, chat at rest, typed composer, scrolled-up chat, plans, Connections, Settings home, create Bot, Bot settings, group chat and sign-in. Test Light as a regression path. Record baseline commit and capture instructions with the images. Preserve all existing feature tests, updating selectors or geometry only where the new markup/layout legitimately differs. Local passing tests and a mergeable PR are the merge gate. No CI workflow changes or manual Fly deployment.
