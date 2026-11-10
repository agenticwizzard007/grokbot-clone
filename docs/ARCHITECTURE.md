# Architecture

Swarm is a web app (`web/`) plus a Node server (`server/`) that runs every Bot's agent loop. Models run through the Responses API on OpenRouter (any tool-capable model; `openai/gpt-4.1` by default) or a compatible direct provider (`server/src/lib/llm.ts`); each Bot can have its own model. Each user's Bots act on a computer from a pluggable provider (a browser on the user's own PC, or one Orgo cloud VM) and use apps connected through Composio.

## Components

| Piece | Where | What it does |
|---|---|---|
| API + realtime | `server/src/routes*.ts`, `lib/hub.ts` | JSON over HTTP, plus one Server-Sent Events stream per user (`GET /api/events`) carrying row updates, live state, roster changes and computer state |
| Agent loop | `server/src/agent/loop.ts` | Per-Bot serial queue. Each turn builds the system prompt and history, streams `openai/gpt-4.1` with function tools plus server-side `web_search`/`x_search`, runs tool calls, and repeats until the model answers |
| Tools | `server/src/agent/tools.ts` | Computer use (`computer_*`, `open_browser`, `shell`, `save_file`), memory (`remember`/`recall`), routines (cron and app events), tasks, `send_to_bot`, subagents, group chats, `ask_user`, `request_app_connection`, `stay_silent`, plus Composio's meta tools for 1,000+ apps |
| Memory | `server/src/agent/memory.ts`, `agent/prompt.ts` | Compacts long histories with direct provider `POST /v1/responses/compact` (falls back to a summary). Consolidates durable facts after a chat goes idle. Keeps a bounded memory section in the prompt |
| Computers | `server/src/computers/` | A provider interface (`types.ts`) that the tools, routes and viewer use; `COMPUTER_PROVIDER` picks one (`index.ts`). New kinds of computers plug in here |
| Local computers | `computers/local.ts`, `companion/swarm-companion.mjs` | A Chrome browser on the user's own PC. The companion connects out to `/api/companion` with a pairing token (stored hashed), launches one Chrome per Bot with its own profile, and drives it over the DevTools protocol through a pipe. Browser only: no shell. It blocks non-http(s) URLs, local-network addresses, downloads and file uploads on the PC side. Library files are stored on the server (`FILES_DIR`). With `COMPUTER_PROVIDER=desktop` the companion runs with `--desktop` instead: screenshots of the real main display (`screencapture`/`sips` on macOS, ImageMagick or ffmpeg on X11), input through CoreGraphics events from JXA (macOS) or `xdotool` (X11), URLs in the default browser, and a login shell. The server hands the single desktop to one Bot at a time (`takeDesktop` in `local.ts`) and refuses companions not started with `--desktop` |
| Orgo computers | `computers/orgo.ts`, `orgo-box.ts`, `orgo.ts`, `idle.ts` | One Orgo Linux VM per user, with one Orgo *screen* (a separate X display with its own desktop) per Bot, up to 4, leased least-recently-used among idle Bots. Auto-suspends after 20 idle minutes and wakes on the next computer action |
| Viewer | `computers/index.ts`, `rfb.ts`, `orgo-viewer.ts`, `local.ts` | The browser always runs noVNC against `/api/bots/:id/screen`. For local computers the server is itself a small RFB server: it streams the Bot's Chrome screencast as Tight/JPEG frames and turns pointer and key events into DevTools input (only in *control* mode). For Orgo it is a WebSocket relay to Orgo's websockify. The server completes VNC auth upstream, so the VM password, which is root-equivalent, never reaches the browser. It then offers the browser an unauthenticated RFB session. In *watch* mode, keyboard, pointer and clipboard messages are dropped on the server |
| Apps | `server/src/composio.ts`, `triggers.ts` | Catalog (`/api/v3.1/toolkits`), per-user sessions, connect links, tool execution, and triggers (realtime subscription) for event routines. Sign-in uses a Composio-managed Gmail connection and reads the profile email |
| Scheduling | `server/src/routines.ts`, `proactive.ts` | Cron routines (croner), event routines, and proactive check-ins for the primary Bot |
| Voice | `server/src/voice.ts`, `web/src/voice/*` | Mints short-lived direct provider realtime client secrets. The browser connects to the configured realtime endpoint directly. A small voice agent relays real work to the Bot's text loop (`send_task`) and speaks the result. Also proxies TTS (preview) and STT (dictation) |
| Messaging | `server/src/messaging/` | One iMessage/SMS thread reaches every Bot, through a server-wide [Inkbox](https://inkbox.ai) line. A channel-agnostic bridge watches transcript rows (`onRowChange`) and the running turn's origin (`currentTrigger`) to forward replies, approvals (with tokens), questions and connect links, and routes inbound messages, commands and card answers into the normal loop. Webhooks are signature-checked and saved to a durable inbox before they're acknowledged. A front desk handles sign-up by text (invites, waitlist, onboarding). See [messaging.md](messaging.md) |
| UI | `web/src` | React + zustand. Sidebar, chat, details panel (activity, tasks, library), modals, settings, viewer, voice call bar |

## Transcript model

A conversation is an append-mostly list of **rows**: `seq` (position), `updatedSeq` (a per-Bot revision counter), `kind` and a JSON `body`.

- **Streaming:** a streaming reply is the same row rewritten with a higher `updatedSeq`, so clients just upsert by `seq`.
- **Resetting:** a per-Bot `generation` counter resets the conversation ("new conversation").
- **Model history:** the Responses API input items live separately in `llm_items` (`store:false`), and encrypted reasoning is passed back unchanged.
  - Only the last 3 screenshots stay inline.
  - Orphaned tool calls from an interrupted turn are repaired before the next call.

Row kinds:
- `message`: user or assistant, optionally *from* another Bot or a voice call
- `tool-call`: shown in the UI only as an activity line and a collapsible step list
- `card`: approval, question, connect, draft
- `event`: routine created or run, voice call, group changes
- `notice`

## Approvals

The loop checks policy before executing each tool call:
- A Bot's own computer and shell run freely.
- Composio tools whose slug reads as read-only (`*_GET`, `*_LIST`, `*_SEARCH`, …) run automatically.
- Anything else posts an **approval card** and pauses the turn, saving the pending calls in `pending_turns`. The turn resumes when the user answers.
  - **Allow** runs the call once.
  - **Always allow** stores a per-tool policy.
  - **Don't allow** sends the model a refusal telling it not to retry.
- A new user message closes any pending approval as expired.

## Bots working together

- **`send_to_bot`:** delivers a message to another Bot's queue. The reply comes back the same way.
- **Subagents:** hidden child Bots with their own context and screen. They report back with `send_to_bot` and are removed with `stop_subagent`.
- **Group chats:** a Bot row with `kind='room'` and a member list. A user message goes to the @mentioned members, or to all members (up to 3). Each member answers in the group with `post_to_group`.

## Data

SQLite (`data/swarm.db`, WAL) holds:
- users and sessions
- Bots, rows, model history
- approvals, policies
- routines, tasks, memories, skills
- computers and screen leases
- Composio session ids, compactions, check-in settings

Secrets live only in `.env` on the server.

## External services

| Service | Used for | Notes |
|---|---|---|
| direct provider | `openai/gpt-4.1` (Responses API), realtime voice, TTS, STT | `prompt_cache_key` per Bot and generation, `safety_identifier` from a hashed user id |
| Orgo | VMs, screens, actions (screenshot, click, type, key, scroll, drag, bash), VNC, files | Rate limit is about 600 control calls/min per computer. An in-VM executor is the planned next step |
| Composio | Sign-in, connectors, marketplace, triggers | Uses Composio-managed OAuth apps by default. Register your own OAuth clients for production branding |
