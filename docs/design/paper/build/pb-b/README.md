# PB-B: app shell and Settings frame

Implements P5, P6 and P14 against Paper v2. The verified design archive SHA256 is `61e10c0453ad0b657fbe95173d4de361f5fe45b34b6ec2aa622c7bca41b67ab5`. The pack itself belongs to PB-A and is not included here.

## Layout and behavior

- Desktop sidebar is 272 px with 12 px padding and gaps. Search is 40 px; navigation rows are 36 px. The rail is 76 px with a selected Bot ring. The real Swarm assets render both themes.
- All Bots, Tasks and Files lead to the existing routes. The account menu offers Settings, Usage, Models and access, Connect apps and Log out. Usage retains its cached state, meter and refresh behavior. Claude is orange in the sidebar; provider marks occupy fixed 16 px boxes.
- Phone top-level navigation is Bots, Tasks, Search and Settings, with safe-area padding. Non-root routes have a primary-color chevron and visible Back label in a 44 px target. Back uses in-app history before the structural parent. A 312 px drawer provides the rest of the app navigation.
- Desktop app navigation remains usable on every route. Search and Connect apps render inside the shell. Regular modal dialogs retain focus containment; embedded route surfaces allow navigation outside them.
- Settings has a 220 px inner navigation column and content up to 640 px. Phone Settings has an account card and grouped section list. General keeps Theme, details preference, time zone and keyboard shortcuts. Shortcuts and diagnostics open on demand. The duplicate compact-sidebar preference is replaced by the existing sidebar collapse control. Learning and Connected apps use distinct icons.

## Validation

All browser checks use local production bundles and synthetic fixtures. No live sign-in or user-data writes are used.

- `paper-shell-ui.mjs`: 320, 390, 500, 768 and 1280 px in light and dark. Checks label widths, whole-word wrapping, 16 px provider containment, Claude color, order, geometry, Back text/target and Settings/sidebar coexistence.
- `navigation-every-route-ui.mjs`: all 63 route forms below at 390 and 1280 px. Checks cold parent fallback, previous in-app screen, top-level phone tabs, collapse/expand on every desktop route, home in at most three taps, unsaved Bot settings guards and a failed roster request.
- `keyboard-chrome-ui.mjs`: 390 and 1280 in both themes. Preserves composer, model picker, approvals and details checks; uses the new phone tabs and drawer, with an untrapped Search route.
- `account-popover-ui.mjs`: ordinary and long account addresses at 390, 768, 1024 and 1280, plus short-window scrolling and resize. The compact menu intentionally omits the repeated email header; account details remain on Account.
- `settings-simplify.test.mts` and `settings-simplify-ui.mjs`: approved section order, distinct icons, all eleven sections, reloads, resizing with an unsaved draft, keyboard access, rail and immediate menu reopen. The provider model row keeps its existing reserved icon slot.
- `paper-shell-copy.mjs`: reproducible before/after word measurement; asserts the v2 General and Settings-home budgets.

Full suite comparison: pending completion before merge. Targeted tests: 168 pass, 0 fail. Server and web typecheck and web production build pass.

## Visible words

Measured with identical local fixtures at 1280 x 900 and 390 x 844. Counts use body innerText excluding the app sidebar, phone tabs and visually hidden accessibility text. The old Settings nav is added back when mounted in the sidebar. Whole-word whitespace tokens include labels and fixture content. Search previously counted its visible background page. Phone Bots previously used only the sidebar, so its main-region baseline is zero.

Only General content and the surrounding frame are redesigned in PB-B. Other Settings contents, chat, Bots and Tasks bodies belong to other streams and remain intact. Their full-page counts below document the effect of the new shell, including the required Back label. Sidebar and account-menu counts are separate component measurements.

| Screen | 1280 before | 1280 after | 390 before | 390 after |
|---|---:|---:|---:|---:|
| Chat | 29 | 28 | 25 | 22 |
| Sidebar | 28 | 30 | n/a | n/a |
| Account menu | 11 | 10 | n/a | n/a |
| Bots | 29 | 33 | 0 | 31 |
| Tasks | 55 | 59 | 56 | 57 |
| Search | 61 | 10 | 62 | 8 |
| Settings home | 127 | 38 | 24 | 22 |
| Settings general | 133 | 38 | 108 | 17 |
| Settings account | 123 | 119 | 98 | 99 |
| Settings messaging | 95 | 91 | 70 | 71 |
| Settings usage | 175 | 171 | 153 | 154 |
| Settings learning | 42 | 38 | 17 | 18 |
| Settings computer | 217 | 213 | 192 | 193 |
| Settings permissions | 139 | 135 | 114 | 115 |
| Settings subscriptions | 493 | 487 | 468 | 469 |
| Settings keys | 444 | 439 | 419 | 420 |
| Settings apps | 99 | 94 | 74 | 75 |
| Settings mcp | 50 | 45 | 25 | 26 |

General is 38 desktop words (budget 40) and 17 phone words (budget 22). Settings home on phone is 22 words (budget 22). Other section budgets are deferred with their content redesigns, per PB-B scope.

## Route results

Every row passes at both widths. Home tap counts include Back when used, then the Bots tab or drawer/brand. Browser aliases are canonicalized; an unknown or missing Bot resolves safely. Exchanges and threads remain inline inside their owning chat; they do not add a hash route.

| Hash route | 390 | 1280 | Maximum taps to Bots |
|---|---|---|---:|
| `#bots` | Pass | Pass | 1 |
| `#bot/coordinator` | Pass | Pass | 2 |
| `#bot/project-room` | Pass | Pass | 2 |
| `#bot/coordinator/details` | Pass | Pass | 3 |
| `#bot/coordinator/details/activity` | Pass | Pass | 3 |
| `#bot/coordinator/details/tasks` | Pass | Pass | 3 |
| `#bot/coordinator/details/files` | Pass | Pass | 3 |
| `#bot/coordinator/details/files/reports` | Pass | Pass | 3 |
| `#bot/coordinator/details/setup` | Pass | Pass | 3 |
| `#bot/coordinator/details/setup/responsibilities` | Pass | Pass | 3 |
| `#bot/coordinator/details/setup/harness` | Pass | Pass | 3 |
| `#bot/coordinator/details/setup/files` | Pass | Pass | 3 |
| `#bot/coordinator/details/setup/history` | Pass | Pass | 3 |
| `#bot/coordinator/settings` | Pass | Pass | 3 |
| `#bot/coordinator/settings/general` | Pass | Pass | 3 |
| `#bot/coordinator/settings/skills` | Pass | Pass | 3 |
| `#bot/coordinator/settings/memories` | Pass | Pass | 3 |
| `#bot/coordinator/settings/routines` | Pass | Pass | 3 |
| `#bot/coordinator/settings/learning` | Pass | Pass | 3 |
| `#bot/coordinator/settings/analytics` | Pass | Pass | 3 |
| `#settings` | Pass | Pass | 2 |
| `#settings/` | Pass | Pass | 2 |
| `#settings/general` | Pass | Pass | 2 |
| `#settings/keys` | Pass | Pass | 2 |
| `#settings/usage` | Pass | Pass | 2 |
| `#settings/computer` | Pass | Pass | 2 |
| `#settings/messaging` | Pass | Pass | 2 |
| `#settings/permissions` | Pass | Pass | 2 |
| `#settings/apps` | Pass | Pass | 2 |
| `#settings/mcp` | Pass | Pass | 2 |
| `#settings/account` | Pass | Pass | 2 |
| `#settings/subscriptions` | Pass | Pass | 2 |
| `#settings/learning` | Pass | Pass | 2 |
| `#general` | Pass | Pass | 2 |
| `#keys` | Pass | Pass | 2 |
| `#usage` | Pass | Pass | 2 |
| `#computer` | Pass | Pass | 2 |
| `#messaging` | Pass | Pass | 2 |
| `#permissions` | Pass | Pass | 2 |
| `#apps` | Pass | Pass | 2 |
| `#mcp` | Pass | Pass | 2 |
| `#account` | Pass | Pass | 2 |
| `#subscriptions` | Pass | Pass | 2 |
| `#learning` | Pass | Pass | 2 |
| `#api-keys` | Pass | Pass | 2 |
| `#whatsapp` | Pass | Pass | 2 |
| `#settings/api-keys` | Pass | Pass | 2 |
| `#settings/whatsapp` | Pass | Pass | 2 |
| `#settings/unknown` | Pass | Pass | 2 |
| `#tasks` | Pass | Pass | 2 |
| `#bot/coordinator/tasks` | Pass | Pass | 2 |
| `#team` | Pass | Pass | 2 |
| `#bot/coordinator/team` | Pass | Pass | 2 |
| `#goals` | Pass | Pass | 2 |
| `#bot/coordinator/goals` | Pass | Pass | 2 |
| `#reports` | Pass | Pass | 2 |
| `#bot/coordinator/reports` | Pass | Pass | 2 |
| `#search` | Pass | Pass | 2 |
| `#new-bot` | Pass | Pass | 2 |
| `#new-bot/group` | Pass | Pass | 3 |
| `#apps/connect` | Pass | Pass | 2 |
| `#unknown` | Pass | Pass | 2 |
| `#bot/missing` | Pass | Pass | 1 |

## Screenshots and comparison

Compared with rendered v2 `chat-rest`, `nav`, `bots` and `settings` artboards in both themes. Screenshots omit the artboards' simulated phone status/home bars; real safe-area insets are supported. Bot names, avatars, counts and messages come from fixtures. General preserves current preference values. Shared token/composer changes belong to PB-A and other screen bodies belong to their respective streams.

- `chat-sidebar-{320,390,1280}-{light,dark}.png`
- `bots-tab-{320,390,1280}-{light,dark}.png`
- `settings-home-{320,390,1280}-{light,dark}.png`
- `settings-general-{320,390,1280}-{light,dark}.png`
- `phone-drawer-{320,390}-{light,dark}.png`
- `rail-account-menu-1280-{light,dark}.png`

There are 30 PNGs. The rail is desktop-only; the drawer is phone-only. At 320 and 390 chat uses its phone header; the drawer screenshots show the full sidebar. Additional 500 and 768 checks are automated, without committed screenshots.
