# Swarm app: build spec from the Paper design

Design source: Paper file "Swarm app screens" in folder "Swarm"
URL: https://app.paper.design/file/01M8CT12KB4A736XV3ZVYEFZ87 (file id 01M8CT12KB4A736XV3ZVYEFZ87)
Designed: 2026-11-26, Europe/Vienna evening. Repo baseline: agenticwizzard007/grokbot-clone main d510420.
Reference renders: python3 docs/design/paper/gen/render.py /tmp/paper-html writes <slug>-<d|m>-<l|d>.html for every artboard (d = desktop 1280x900, m = phone 390x844; l = light, d = dark; root element #artboard). These match the Paper PNG exports.
Generator (HTML source of every artboard, the exact values): docs/design/paper/gen/*.py.

Paper v3 (layout system 0d, copy diet 0b, Back label 0c) updated 2026-11-27. Sections 0b, 0c and 0d are binding.
Pages in the file: Read me, 00 Tokens and components, 01 Entry, 02 Chat, 03 Bots, 04 Settings, 05 Work and search, 06 States and navigation.
Each screen row on a page holds 4 artboards left to right: Desktop Light, Desktop Dark, Mobile Light, Mobile Dark.

## 0. Binding rules (checked in every PR)

1. Composer height is stable while typing. Desktop and tablet: one row grid (add, field, model chip, send or voice), 52 px tall at 1 line. Phone (max-width 480 px): fixed two row box (field row on top at full width, controls row below), 84 px tall at 1 line. Both grow 24 px per wrapped line up to 6 lines, then the field scrolls inside. The layout never switches based on text length.
2. Provider logo (Claude, ChatGPT or Codex, OpenRouter, xAI and others) is shown wherever a model, plan or effort label is shown, in a fixed 16 x 16 slot (flex: 0 0 16px, overflow visible), never clipped, never hidden by a breakpoint. Claude mark uses brand color #D97757 in both themes; OpenAI and OpenRouter marks use the ink color.
3. No label truncates or ellipsizes at any width (no text-overflow: ellipsis, no line-clamp on labels, no clipping overflow). When space is tight use a shorter complete label (Sonnet 4.5 to Sonnet, sk-or-v1-...4f2a to "•••• 4f2a"), wrap, or stack.
4. Navigation is clear for first customers: desktop sidebar always shows All Bots, Tasks, Files, Your Bots, Create a Bot, Usage and Settings; phone shows a tab bar (Bots, Tasks, Search, Settings) on top level screens and a Back button inside a Bot.
5. No em or en dashes in copy. No owner names. Placeholder data only (Test User, user@example.com, team@example.com, keys shown masked).
6. Tests: every chunk adds or extends Playwright checks at 320, 390, 500, 768 and 1280, light and dark: scrollWidth <= clientWidth on every label, logo bounding box fully inside its parent, composer height sequence while typing.

## 0b. Copy diet and clutter rules (owner requirement, Nov 27; binding)

The owner found Models and access far too cluttered. Target: about 70 percent less copy on every screen. Paper v2 holds every artboard to these rules, and every build PR must too:

1. One short title per section (1 to 3 words). No section has both a title and a sentence that repeats it.
2. At most one short helper line per screen or card (8 words or fewer), or none. No paragraphs.
3. Status is a small pill, never a sentence: Connected (success), Not connected (neutral), Key saved, In use, Sign in needed (danger). Status sentences such as "Claude Code installed · Not signed in · Eligible plan not confirmed" are removed.
4. One primary action per row (filled button). At most one secondary action, shown as a text link or outline button. Destructive or rare actions (Disconnect, Reset connection, Refresh status, Remove key) live in a Manage menu.
5. No repeated explanations. A sentence may appear once in the whole app, ideally inside a tooltip. "Connected plans stay signed in" and "Credentials stay in that CLI's profile" appear nowhere on the page.
6. Duplicate controls are merged. Use API providers, Manage API keys, OpenRouter sign in and Paste your API key become one OpenRouter row: pill + Connect (OpenRouter sign in) + Paste key link. Which billing Bots use is one segmented toggle: Plan | API key.
7. Extra detail goes behind a small info button (24 px hit area, 16 px info icon, accessible name, opens a popover on click and on keyboard focus, closes on Escape) or a single Learn more link per screen.
8. Every label stays complete (rule 3 above): short labels, never ellipsis.
9. Measured: each PR body lists the visible word count of the main region (body innerText minus the app sidebar and phone tab bar) before and after, at 1280 and 390. The new number must be at or under the Paper v2 column below, or 30 percent of live for screens without an artboard.

### Models and access, v2 layout (artboard models)
- Title "Models & access". No subtitle.
- Row "Bots use" + info button ("Plan uses your subscription. API key pays per use.") + segmented toggle Plan | API key (maps to the existing switch between plan billing and API providers).
- Card "Plans": row Claude (logo, pill, Manage when connected or Connect when not), row ChatGPT (logo, pill, Connect). Connect opens a sheet with the CLI sign in steps for Claude Code or Codex; the computer bridge option and the CLI wording live only inside that sheet behind Learn more. Manage opens a menu: Refresh status, Reset connection, Disconnect.
- Card "Pay per use": one OpenRouter row (logo, pill, Paste key link, Connect button). Paste key expands an inline masked field with Save. When a key is saved the pill becomes Key saved and the action becomes Manage (Replace, Remove).
- One Learn more link at the bottom (docs). Nothing else.
- API keys page (artboard keys): one list of provider rows with the same row component (OpenRouter Key saved + Replace, xAI and Gemini Not connected + Add key) and Default API model. No explanatory copy.

## 0c. Back navigation (owner requirement, Nov 27; binding)

- Phone (max-width 760): every screen that is not a top level tab (Bots, Tasks, Search, Settings) has a visible Back control at the left of the top bar: chevron + the word "Back", 44 px tall hit area, primary color. Target is the previous screen in history, or the structural parent when there is no history (chat to Bots, Bot settings to the Bot chat, a settings page to Settings, Models & access to Settings).
- Desktop: the app sidebar is always visible or reachable (collapsed rail with an expand button) on every route, including Settings and Bot settings. Settings keeps "Back to chat" in its header.
- Phone tab bar is shown on the four top level screens.
- Test: tests/navigation-every-route-ui.mjs opens every route at 390 and 1280 and asserts a Back control (phone, non root), sidebar or rail (desktop) or tab bar (phone, root), and that home is reachable in at most 3 clicks.

### Word count per screen, before and after
Live counts: current main (801496e) on a local seeded server (tests/phone-sizes-ui.mjs fixture), main region words at 1280 x 800 and 390 x 844. Paper counts: artboard text minus the app sidebar, status bar and tab bar (desktop settings counts include the 22 word settings nav). Chat sample messages are content, not copy, and are not cut. Live Search at 390 opens with an empty query, the artboard shows results. Create a Bot desktop counts include the Bot list behind the modal.
Across the 17 screens that exist live: 2984 words at 1280 today, 895 in Paper v2 (70 percent less).

| Screen | Paper slug | Live main today, 1280 / 390 | Paper v1, 1280 / 390 | Paper v2 (this spec), 1280 / 390 | Cut vs live, 1280 / 390 |
|---|---|---|---|---|---|
| Signed out landing and sign in | landing | no live screen | 56 / 54 | 34 / 32 |  |
| Sign in code with error | signin-code | no live screen | 57 / 55 | 34 / 32 |  |
| First run: connect a model | first-run | no live screen | 75 / 78 | 33 / 37 |  |
| Chat | chat-rest | 239 / 196 | 77 / 63 | 72 / 64 | 70% / 67% |
| Chat: typing one line | chat-typing | no live screen | 81 / 67 | 76 / 68 |  |
| Chat: multi line composer at max | chat-multiline | no live screen | 118 / 104 | 113 / 105 |  |
| Model and effort picker | chat-picker | no live screen | 112 / 101 | 92 / 87 |  |
| Run log and approval card | chat-run | no live screen | 96 / 82 | 82 / 74 |  |
| Voice in main chat | chat-voice | no live screen | 89 / 70 | 78 / 71 |  |
| Room with several Bots | room | no live screen | 80 / 65 | 72 / 66 |  |
| Bot list | bots | 239 / 0 | 85 / 75 | 40 / 41 | 83% / n/a |
| Create a Bot | create-bot | 70 / 48 | 123 / 80 | 67 / 49 | 4% / -2% |
| Bot details: Activity | bot-activity | 415 / 157 | 68 / 63 | 55 / 51 | 87% / 68% |
| Bot details: Tasks | bot-tasks | no live screen | 44 / 39 | 44 / 40 |  |
| Files and Saved reports | bot-files | 67 / 49 | 53 / 49 | 41 / 38 | 39% / 22% |
| Setup tabs | bot-setup | no live screen | 63 / 58 | 36 / 32 |  |
| Bot settings: General | bs-general | 126 / 103 | 58 / 53 | 46 / 42 | 63% / 59% |
| Bot settings: Skills | bs-skills | 56 / 33 | 60 / 55 | 37 / 33 | 34% / 0% |
| Bot settings: Memories | bs-memory | 93 / 70 | 63 / 58 | 45 / 41 | 52% / 41% |
| Bot settings: Routines | bs-routines | 70 / 47 | 57 / 52 | 39 / 35 | 44% / 26% |
| Settings: General | settings | 107 / 85 | 73 / 22 | 40 / 22 | 63% / 74% |
| Models and access | models | v2: "Bots use" toggle Plan or API key with info button; Plans card (Claude, ChatGPT rows: logo, pill, one action); Pay per use card (one OpenRouter row: pill, Paste key, Connect); one Learn more. See 0b. | Live has 468 words: Codex / Claude Code tabs, status sentences, CLI authentication, API providers with two buttons, a second OpenRouter section that repeats the same explanations. v2 has 49. |
| API keys | keys | v2: one provider list (OpenRouter Key saved + Replace, xAI and Gemini Not connected + Add key) and Default API model with logo. No helper copy. | Live repeats the OpenRouter explanations from Models and access (418 words); v2 has 45. |
| Usage | usage | 93 / 71 | 81 / 58 | 63 / 41 | 32% / 42% |
| Permissions | permissions | 117 / 95 | 102 / 79 | 52 / 30 | 56% / 68% |
| Connected apps | apps | 70 / 48 | 63 / 40 | 46 / 24 | 34% / 50% |
| Tasks | tasks | 82 / 64 | 47 / 33 | 41 / 33 | 50% / 48% |
| Search | search | 254 / 15 | 125 / 47 | 117 / 44 | 54% / -193% |
| Empty state: new chat | empty | no live screen | 53 / 39 | 35 / 27 |  |
| Loading state | loading | no live screen | 15 / 11 | 15 / 12 |  |
| Error state | error | no live screen | 75 / 71 | 56 / 53 |  |
| Navigation: collapsed sidebar, account menu, mobile drawer | nav | no live screen | 89 / 109 | 84 / 107 |  |

| Live screen with no own artboard | Live main today, 1280 / 390 | Word budget v2 (30% of live), 1280 / 390 |
|---|---|---|
| settings account | 100 / 78 | 30 / 23 |
| settings computer | 86 / 64 | 26 / 19 |
| settings messaging | 80 / 58 | 24 / 17 |
| settings mcp | 31 / 9 | 9 / 3 |
| settings learning | 177 / 155 | 53 / 46 |
| bot settings analytics | 81 / 58 | 24 / 17 |
| bot settings learning | 213 / 190 | 64 / 57 |
| work Team | 116 / 98 | 35 / 29 |
| work Goals | 66 / 48 | 20 / 14 |

## 0d. Layout system v3 (owner requirement, Nov 27; binding)

The owner found the app not symmetrical, boxes not aligned and containers of different sizes. Paper v3 regenerates every artboard on this system; every route in the app must follow it.

1. Page types and one content max-width each: form pages (Settings pages, Bot settings, Bot details tabs, Create a Bot) 640 px; list pages (Bot list, Tasks, Files, Search results page, Usage) 880 px; chat column 760 px. The content column is centered in the main area (equal space left and right).
2. Page padding is equal left and right: 16 px on phone (max-width 760 px), 32 px on desktop. The desktop page header uses the same 32 px side padding. Phone sheets use 16 px.
3. Spacing scale: 8 px steps only (4 allowed inside a control). Gaps: 8 inside a card, 16 between cards, 24 between sections.
4. One card style: radius 12, padding 16, 1 px border (--color-border), background --color-elevated, width 100 percent of its column (align-self: stretch). No other radius or padding values on cards.
5. Cards in one list or section have the same width. Cards side by side share the row equally (flex: 1 1 0, min-width 0).
6. Rows and buttons are 44 px tall (min-height 44 for rows that wrap). Icon buttons 44 px hit area on phone, 36 px visible size allowed on desktop toolbars.
7. Buttons in a group have equal widths (ButtonGroup: each child flex 1 1 0) or are full width (stacked on phone).
8. Labels align to one left edge per column. Section headers share one style: 13/18, weight 600, --color-text-2, 24 px min height, optional trailing action.
9. One Back control per screen (phone: chevron plus "Back" at the left of the top bar). No second Back link inside the page body or the settings nav on phone.
10. Shared primitives, used by every route: Page (type: form, list, chat; sets max-width, centered, symmetric padding), Section (header plus stack), Card, Row, ButtonGroup. No route defines its own outer padding, card radius or button height.
11. Test: tests/layout-alignment-ui.mjs opens every route at 390 and 1280 and asserts: cards in the same column have equal width (within 1 px) and shared left and right edges; cards in the same row have equal width; ButtonGroup children equal width; page content padding left equals right (within 1 px); buttons and rows are at least 44 px tall; no element extends past the viewport (no horizontal scroll).

Design check: the same assertions were run on all 128 v3 screen artboards (local renders of the generator): 0 issues.

## 1. Tokens

Map to existing CSS variables in web/src/styles/tokens.css (keep variable names; update values where they differ).

| Paper token | Light | Dark | Existing CSS var |
|---|---|---|---|
| pane | #FFFFFF | #1D2A3B | --color-bg-pane |
| sidebar | #FBFAF7 | #17222F | --color-bg-sidebar |
| active | #EDEFFA | #30415E | --color-bg-active |
| subtle | #F5F6F7 | #223144 | --color-bg-tertiary / --color-bg-subtle (make solid) |
| hover | #EEF0F2 | #283A50 | --color-bg-hover |
| ink | #18202A | #FFFFFF | --color-text-primary |
| text2 | #525B5E | #C4CBD5 | --color-text-secondary |
| text3 | #697176 | #AFB9C6 | --color-text-tertiary |
| border | #DCDEE0 | #3A4859 | --color-border-secondary |
| bsoft | #EBECEE | #2B394B | --color-border-tertiary |
| primary | #3043AB | #B5C1FF | --color-primary |
| onprimary | #FFFFFF | #17222F | --color-on-primary |
| bubbleuser | #EDEFFA | #3043AB | --color-bubble-user |
| bubbleagent | #FBFAF7 | #243347 | --color-bubble-agent (dark changes from #1D2A3B so agent text is not on bare pane) |
| elevated | #FFFFFF | #253348 | --color-bg-elevated |
| success / successbg | #27804F / #ECF4EE | #3CC384 / #173A2E | --color-success, --color-success-bg |
| warn / warnbg | #9A5B08 / #FCF0DA | #F0B45A / #3A3020 | --color-warn-text, --color-warn-bg |
| danger / dangertext / dangerbg | #E72E3B / #A1353D / #FCEDEE | #F05A64 / #FF9AA1 / #3D2229 | --color-danger, --color-danger-text, --color-danger-bg |
| scrim | #10161E73 | #00000099 | --color-bg-scrim |
| bot accents pink, green, orange, teal | #E52F8B #14A862 #E8620E #13A592 | #F93498 #14C16F #FD690F #13B7A2 | --color-bot-* |

Type: Inter for UI, Instrument Sans for titles and wordmark. Display 32/40 700, Title 24/32 600, Panel 17/24 600, Message 15/24 400, Body 14/20 400, Caption 12/16 500, Tab label 11/14. Large type tracking -0.02em.
Spacing: 4, 8, 12, 16, 24, 32, 40, 48. Radius: sm 8, md 12, card 16, composer 24, full.
Containers: sidebar 272 (collapsed rail 76), chat column 752, settings content 640, settings nav 220. Breakpoints: phone 480, mobile shell 760 (existing), desktop 1024.
Touch targets: 44 px on phones, 36 px on desktop.

## 2. Component specs (exact sizes)

- Sidebar (desktop >= 761): width 272, padding 12, gap 12, bg sidebar, 1 px right border bsoft. Brand row 40 high (Swarm mark 24 + "swarms.so" Instrument Sans 20/28 600, use existing /assets/swarms/wordmark.svg), collapse button 32. Search field 40 high, radius 12, border, "Ctrl K" hint. Nav rows 36 high, radius 10, icon 18, label 14/20 500 (600 when active, fill active). Section label "Your Bots" 12/16 600 text3. Bot row: padding 8 10, avatar 36 radius 11, name 14/20 600, Primary chip, subtitle 12/16 text3, selected fill active. "Create a Bot" row 40. Footer: Usage card (padding 12, radius 12, bg subtle; provider logo 16 + plan name 13/18 600 + chevron; 4 px meter; caption) and a Settings row 44 (avatar initials 28 + "Settings" + gear).
- Collapsed rail: width 76; mark 28, buttons 40 (collapse, search, tasks), Bot avatars 36 with a 2 px primary ring on the selected one, add button 40 bordered, footer provider logo 20 and avatar 32.
- Desktop header: 64 high, padding 0 24, bottom border bsoft. Back link (chevron 16 + 13/18 500 text2), avatar 32, title 15/22 600, subtitle 12/16 text3, right actions (voice icon 36, Details or Open chat button 32).
- Phone top bar: 56 high, padding 0 8, back or menu icon button 40, avatar 32, title 16/22 600, subtitle 12/16, right icon buttons 36.
- Phone tab bar: shown on Bots, Tasks, Search, Settings only. Cells flex 1, 56 high, icon 22, label 11/14; active uses primary color for icon and label plus weight 600. Top border bsoft, bg sidebar, plus safe area.
- Buttons: height 36 desktop / 44 phone, padding 0 16, radius 10, label 14/20 500, nowrap, size to content. Variants: primary (primary / onprimary), secondary (elevated + 1 px border), ghost, quiet (subtle), danger (dangerbg / dangertext). On phones a button row stacks to full width (primary last visually on top via column-reverse where there is Cancel).
- Icon button: 36 (40 on phone headers), radius 10; primary round variant for send and voice.
- Chip: 20 high, padding 0 8, radius full, 12/16 500. Kinds: neutral, success, warn, danger, primary.
- Model chip: height 36, padding 0 10, gap 6. Logo slot 16. Model name 13/18 600 nowrap. Billing badge chip ("Plan" or "API"). Effort 12/16 500 text2. Chevron 14. Phone (<= 480): drop badge and chevron, short model name (Sonnet, Opus, Codex, Kimi K2), keep logo and effort.
- Composer desktop: padding 8, gap 4, radius 24, 1 px border, bg elevated, shadow 0 2 8 -1 #0000000D. Children: add 36, field (15/24, flex 1, align center, height = lines x 24, max 144 then scroll), model chip, send 36 (mic when empty). Align items flex-end. Note under composer 12/16 text3 centered.
- Composer phone: padding 10 8 8, gap 4. Row 1 field (padding 0 8, height = lines x 24, max 144 then scroll). Row 2 controls, 36 high: add 36, spacer, model chip compact, send 36. Min height 84.
- Model and effort picker: desktop popover 340 wide, padding 6, radius 16, border, shadow, above the chip. Groups "Your plans" and "API billing", rows min 44 (logo 18, name 14/20 600 + badge, note 12/16), selected row fill active + check. Effort segmented control (Low, Medium, High) at the bottom, 32 high cells. Phone: bottom sheet, radius 20 top, grabber 36 x 4, title "Model and effort" + close, same rows at 48 min.
- Run log: collapsed line 28 high (check 14 success, "Worked for 42s, 4 steps" 13/18 500, chevron). Expanded: steps list with 2 px left rule bsoft, icon 14 + 13/18 text2.
- Approval card: padding 16, radius 16, border, bg elevated. Title row (icon 18, 15/22 600, "Needs approval" warn chip), explainer 13/18 text2, detail box (bg subtle, radius 12, label column 64 wide), buttons right aligned and wrapping: Don't allow (secondary), Always allow (quiet), Allow (primary). Declined state replaces buttons with a dangertext line.
- Voice bar: sits directly above the composer inside the chat (not a separate screen). Desktop: pill, bg active, status dot, "Voice on. Atlas is listening" + "Replies also appear in this chat", level bars, mute 36, End button (danger). Phone: "Listening" + "Replies show in this chat", mute 40, End 40, no level bars.
- Bot tabs: desktop underline tabs (Chat, Activity, Tasks, Files, Setup, Settings), 44 high, icon 16 + 14/20, 2 px primary underline. Phone: 5 equal cells with icon 18 + 11/14 label (Chat, Activity, Tasks, Files, Setup); Settings moves to the gear in the top bar.
- Wrapping pill tabs (phone Setup sub tabs and Bot settings tabs): 32 high pills, radius 16, flex-wrap, active = ink fill with pane text. Never a horizontal scroller that cuts a label.
- Segmented control: padding 4, radius 12, bg subtle, cells 36 high with optional logo; phone variant padding 0 6, gap 6, 13 px nowrap labels.
- Settings row: 14 px vertical padding, icon or logo 20 slot, title 15/22 600, subtitle 13/18 text2, trailing control. On phone, rows with buttons stack the button full width under the text.
- Toggle 40 x 24. Radio card: padding 14, radius 12, border, selected = primary border + active fill.
- Modal: 520 to 560 wide, padding 24, radius 20, scrim. Phone: bottom sheet.
- Skeletons: bg subtle bars 14 high radius 6.

## 3. Per-screen layout and differences from the live app

Slugs match screenshot names. "Live" means swarm-team.fly.dev at main d510420 as seen in round 17/18 QA and docs/design/redesign/after.

| Screen | Slug | Layout | Change from live |
|---|---|---|---|
| Signed out landing and sign in | landing | Desktop: split, 560 story panel (headline, 3 value points, "Works with" Claude, ChatGPT, OpenRouter logos) + centered 400 sign in card. Phone: single column card. | Live is one centered column with no product story; Google and Apple order changes; OpenRouter button gets its logo; "or" divider replaces "Other ways to sign in". |
| Sign in code with error | signin-code | 6 digit boxes 44 x 52, inline error with icon, Verify, resend timer, change number. | New explicit code step design with inline error state. |
| First run: connect a model | first-run | Step 2 of 3 progress, three radio cards with full logos (Claude plan, ChatGPT plan, OpenRouter key), "what happens next" card, Back / Continue with Claude. | Live has no guided first run; users land in chat and must find Models & access. |
| Chat | chat-rest | Sidebar + header + 752 thread + composer dock with safety note. Agent messages: avatar 28 + name + run log + text without a bubble; user messages right bubble radius 16 16 4 16. | Agent text no longer in a dark bubble box; run log line added under the name; header voice button; sidebar gains All Bots and Files; Account & settings becomes a plain Settings row. |
| Chat: typing one line | chat-typing | Same as rest, composer stays 52 (desktop) / 84 (phone). | Phone composer becomes two rows permanently (fixes the narrow field that clipped "Message the room"). |
| Chat: multi line at max | chat-multiline | Desktop 3 lines (88). Phone 6 lines with internal scrollbar. | Formalizes max 6 lines then scroll. |
| Model and effort picker | chat-picker | Desktop popover, phone sheet; every row has its logo and billing badge; effort segmented at bottom. | Effort becomes a visible segmented control instead of per row flyout; phone uses sheet. |
| Run log and approval card | chat-run | Expanded run log + approval card inline in thread. | Card gets title, warn chip, explainer and detail box; buttons wrap instead of clipping on phone. |
| Voice in main chat | chat-voice | Voice bar directly above the composer; transcript stays visible. | Voice is part of the main chat (criterion 3), not a separate surface. |
| Room | room | Header shows member avatars + Add Bot; messages per Bot with its color; typing indicator; placeholder "Message the room". | Live room header lacks members; phone placeholder was clipped. |
| Bot list | bots | 2 x 2 Bot cards (status chip Working, Ready, Needs you) + Rooms section; Create a Bot and New room buttons. Phone: stacked cards + tab bar. | Live "Bots" is only the sidebar list; new home overview with statuses. |
| Create a Bot | create-bot | Modal / phone sheet: Name, Role pills, Model row with logo and plan, Create Bot. "Start a room instead" link. | Model row with logo added; role pills. |
| Bot details: Activity | bot-activity | Bot tabs, 3 stat cards, Today feed. | Tabs move from a Details side panel into a full page with clear tabs. |
| Bot details: Tasks | bot-tasks | Open / Done / All segmented, task rows with status chip. | Same data, clearer filters. |
| Files and Saved reports | bot-files | Saved reports entry card on top, file list with type chips, Upload. | Saved reports promoted to a visible card. |
| Setup tabs | bot-setup | Segmented (desktop) or wrapping pills (phone): Responsibilities, Harness, Files, History; responsibilities list. | Phone tabs wrap instead of a cut off scroller. |
| Bot settings: General | bs-general | Desktop: 180 vertical tab list + 640 form + sticky footer (Cancel, Save changes). Phone: wrapping pill tabs, sticky 2 button footer. Model field shows Claude logo + "Claude Max plan" chip + effort. "Ask before every action" toggle. | Modal becomes a page; model field logo; approval level toggle visible per Bot. |
| Bot settings: Skills | bs-skills | Suggested skill card (Review skill / Not now) then list with toggles. | Skill request lands on a skill card (matches R18-3). |
| Bot settings: Memories | bs-memory | Search, memory rows with source + date, Add a memory. | Source line per memory. |
| Bot settings: Routines | bs-routines | Routine cards with toggle and last or next run line. | Clearer on and off state. |
| Settings: General | settings | Desktop: app sidebar stays, 220 settings nav (Workspace, Connections groups, search) + 640 content. Phone: account card + grouped list + tab bar. | Live replaces the Bot list with the settings nav; design keeps the app sidebar so users never lose their place. |
| Models and access | models | Segmented Claude / ChatGPT / OpenRouter with logos; status card for the active plan (Connected, In use, Refresh status, Disconnect); "Other ways" cards: ChatGPT plan with Connect plan, OpenRouter key with Manage key; approvals note. | Live shows Codex / Claude Code tabs and 6 rows of CLI terms (CLI connection, CLI authentication, Reset connection). Design hides CLI detail behind the status card and puts Connect plan (R18-2) and the OpenRouter key (t90u) at the same level. |
| API keys (OpenRouter) | keys | OpenRouter card with masked key field (desktop full mask, phone "•••• 4f2a"), Test key, Remove key; Default API model with logo; Other providers. | Users can connect their own OpenRouter key beside a ChatGPT plan; masked display never wraps. |
| Usage | usage | Weekly runs chart, per plan meters with logos, By Bot list with logo per Bot model. | Live shows "Provider usage unavailable"; design defines all states with logos. |
| Permissions | permissions | Approval level radio cards (External only recommended, Ask before every action, Never ask), Always allowed list. | Makes criterion 1 and 2 explicit in one place. |
| Connected apps | apps | Search, app rows with Connected chip, Sign in again (danger), Connect. | Same function, clearer states. |
| Tasks | tasks | Desktop 4 column board (To do, Doing, Blocked, Done) with Bot avatars. Phone grouped list + tab bar. | Board view replaces plain list on desktop. |
| Search | search | Desktop: command panel 600 wide over the chat with groups Bots, Messages, Files and tasks. Phone: full screen tab. | Search becomes a tab on phones. |
| Empty state | empty | Centered hero (mark 56, title, explainer) + 3 suggestion buttons + composer. | New empty state for a new Bot chat. |
| Loading | loading | Skeleton bubbles + "Loading your chat"; composer usable. | Replaces blank screen or spinner. |
| Error | error | Connection lost banner with Try again; failed message with "Not sent. Tap to retry"; plan sign in again card with Reconnect Claude. | New consistent error patterns. |
| Navigation | nav | Desktop collapsed rail + account menu (Settings, Usage, Models & access, Connect apps, Log out). Phone drawer 312 wide with the full sidebar. | Collapsed rail shows provider logo; account menu adds Models & access. |

## 4. Build PR chunks (one Conductor session each, in order)

Each PR: local tests with no new failures versus main, screenshots at 390 and 1280 light and dark compared with the matching Paper artboards, no [skip ci].

1. P1 Tokens: update tokens.css values to the table above (light and dark), add --color-bubble-agent dark change, solid subtle fill, tab label size. No layout changes. Tests: token snapshot.
2. P2 Provider logo slot everywhere: ProviderMark always reserves 16 px, Claude brand color, remove any max-width rule that hides marks; add the label width checks (320 to 1280) for chip, picker, sidebar usage, Models & access, Bot settings model field, Usage, Search, run log.
3. P3 Composer: desktop one row and phone two row fixed layouts, 24 px line growth to 6 lines then scroll, compact chip labels (short model names map). Extend composer-stable-layout-ui.mjs with the phone two row case at 320, 390, 480.
4. P4 Model and effort picker: popover and phone sheet per spec, effort segmented control, plan and API groups with badges.
5. P5 Sidebar and collapsed rail: All Bots, Tasks, Files nav, Bot rows, Usage card with logo, Settings row, account menu with Models & access.
6. P6 Phone shell: tab bar on Bots, Tasks, Search, Settings (max-width 760), Back inside a Bot, drawer from the chat menu. Hash routes unchanged.
7. P7 Chat thread: agent message style (avatar, name, run log line, no bubble), user bubble radius, run log expand, header voice button.
8. P8 Approval card and declined state; buttons wrap and stack on phones.
9. P9 Voice bar in main chat above the composer (desktop and phone variants).
10. P10 Rooms: header members and Add Bot, per Bot colors, typing line, placeholder.
11. P11 Bot list home (#bots) with status cards and Rooms section; Create a Bot modal and phone sheet with model row.
12. P12 Bot details as a page with Bot tabs (Activity, Tasks, Files with Saved reports card, Setup with wrapping pills on phones).
13. P13 Bot settings as a page: vertical tabs desktop, wrapping pills phone, sticky footer, model field with logo, per Bot "Ask before every action", Skills card, Memories, Routines.
14. P14 Settings frame: keep app sidebar, 220 settings nav with groups and search, phone grouped list; General page.
15. P15 Models and access v2 per section 0b (Bots use toggle, Plans card, one OpenRouter row with Connect and Paste key, Manage menus, Connect sheet holding the CLI steps) plus the API keys provider list and Default API model.
16. P16 Usage, Permissions, Connected apps pages per spec.
17. P17 Tasks board (desktop) and grouped list (phone); Search command panel and phone Search tab.
18. P18 Entry: split landing, sign in code step with error, first run "Connect a model" step.
19. P19 States: empty chat, loading skeleton, connection lost banner, failed message retry, plan sign in again card.
20. P20 Sweep: copy diet audit of every live screen against the word count table (including screens with no artboard: Account, Computer, Messaging, MCP servers, Learning, Bot analytics, Bot learning, Team, Goals), back navigation test for every route, no ellipsis or line-clamp left in product CSS on labels, dash and owner name copy scan, full screenshot matrix 320, 390, 500, 768, 1280 light and dark against the Paper artboards.

## 5. Notes

- The Swarm mark in the artboards is a stand-in drawing; build with the existing /assets/swarms/flock.svg and wordmark.svg.
- Paper exports also landed in ~/Downloads on the Mac and were moved to ~/paperqa/exports there.
- Bot names in the design (Atlas, Research, Studio, Ledger, Launch room) are placeholders, not real Bots.
