# Messaging: run your Bots by text

People can sign up for Swarm by texting a number, and run their whole team from one iMessage, SMS, or WhatsApp thread. It's the same account as the web app. Day to day, people use it by text, and the web app is there when they want it (`/web` texts a one-time sign-in link).

The line is a server-wide [Inkbox](https://inkbox.ai) identity: Inkbox runs real iMessage, SMS, and dedicated WhatsApp channels behind an API. One line serves everyone; the server tells people apart by phone number.

## Setting up the line (server owner)

1. Set `SERVER_URL` to this server's public HTTPS address (or a tunnel). Inkbox posts incoming texts to `<SERVER_URL>/api/messaging/inkbox/webhook`.
2. In **Settings → Messaging**, paste your Inkbox admin key (org key from the Inkbox console). It's checked with Inkbox and stored encrypted.
3. Select **Set up line**. Swarm does the following, saving each step so a failure resumes where it stopped:
   - creates the identity (handle `swarm` unless you choose another; optionally with a local number for SMS),
   - mints a key scoped to that identity (the server sends with it; the admin key is only for setup),
   - creates the webhook signing key,
   - subscribes the webhook to `imessage.received`, `imessage.reaction_received`, `text.received`, `whatsapp.received`, and `whatsapp.reaction_received`.

   Dedicated WhatsApp must be approved and enabled on the Inkbox identity. WhatsApp can send text, quoted replies, media and reactions; it does not expose typing indicators. Once enabled, Settings → Messaging shows a WhatsApp test card with the Inkbox onboarding link and QR code.

   If the identity already has a signing key this server doesn't hold, setup stops rather than replacing it, because other receivers would break. Choose **Replace signing key** if that's intended.
4. Choose who can join under **Sign-up by text**:
   - **Invites + waitlist** (default): an invite creates an account. Anyone else who texts goes on a waitlist that you approve.
   - **Open**: anyone who texts gets an account.
   - **Closed**: no new accounts.

   Caps: new accounts per day (default 50), messages per day for each account created by text (default 200, counted across text and web), and invites per member (default 5).

The settings can also come from `.env` (see `.env.example`).

## Joining

**One text to join.** Inkbox handles `connect @<handle>` itself and sends no event, so the server checks Inkbox's list of connected numbers every few seconds (`server/src/messaging/connections.ts`). A newly connected number is greeted right away:
- an invite claimed on the join page, an open server, or the owner's number: the account is created, the welcome is texted, and onboarding starts;
- otherwise: a text explaining how to get in (invite code or waitlist).

If Inkbox doesn't let the line text first, nothing is created, and the person's next text goes through the steps below as before. Only connections from the last 20 minutes are greeted, so a restart doesn't message old connections again.

- **Invite link** (`/join/<code>`): the person enters their number and taps **Open WhatsApp** when Dedicated WhatsApp is ready, otherwise **Text Swarm**. WhatsApp opens with the Inkbox onboarding message; Messages opens with `connect @<handle>` addressed to Inkbox's router number. The account is created when that text arrives; texting from the number is the proof that they own it, so no code is needed. The page answers the same whether or not a number already has an account.
- **Invite code in the chat**: `JOIN ABCD2345` (or the bare code as shown).
- **Waitlist**: anyone else who texts gets one reply and waits for the owner's approval. Approval creates the account and texts them in the same thread.
- **Continue with phone number** (the sign-in screen): enter your number, then the 6-digit code that's texted to you. If the number already reaches Swarm, the code arrives right away. If it doesn't yet, tap **Open WhatsApp** or **Open Messages** to send the prefilled message. The server watches Inkbox's list of connected iMessage numbers and texts the code as soon as yours appears; failing that, texting anything over iMessage or WhatsApp gets the code back. The right code signs you in, or creates the account (under the sign-up mode above) and connects the number. Add an email later in Settings → Messaging. Codes last 10 minutes, work once, and lock after 5 wrong tries.
- **Connect your phone** (signed in, Settings → Messaging): the same code flow attaches the number to your account. A number that already has its own account is refused.
- **Web account → phone** (alternative): Settings → Messaging → **Connect your phone** shows a link code. Text the connect command, then `LINK <code>`.

New accounts get a short welcome. Then Quinn, their primary Bot, runs a brief onboarding in the chat, one question per message: name, city and time zone, messaging style, apps to connect (Composio links), a daily brief, and teammates if they help. It saves each answer as it goes (`update_profile`, `remember`).

## Using it

| Text | What happens |
|---|---|
| Anything | Goes to the active Bot (the primary Bot unless switched) |
| `@Name …` | Goes to that Bot or group |
| A reply to a Bot's message | Goes to the Bot that sent it |
| `yes K7P2` / `always K7P2` / `no K7P2`, or 👍 / 👎 on the approval | Answers that approval |
| A bare `yes` / `no` | Counts only when exactly one approval is open and it was the last thing sent (or with "approve"/"deny"). "Sure" to some other question never approves anything |
| A number or an option | Answers the latest question; free text answers it too when it's from the active Bot |
| `skip` | Skips a pending app connection |
| Voice note / photo | Transcribed with speech-to-text / shown to the Bot |
| `/bots` `/status` `/tasks` | Team, live activity, open approvals and tasks |
| `/use Name` · `/stop [Name]` · `/new [Name]` | Switch the active Bot · stop work · fresh conversation |
| `/apps` · `/connect gmail` | Connected apps · a connect link that works from the phone |
| `/approve` · `/deny` | Answer the open approval (add the code if several are open) |
| `/activate Name` | Activate a new Bot after its setup interview |
| `/invite` | Your invite link and how many invites are left |
| `/web` | A one-time sign-in link to the web app (10 minutes) |
| `/me` | Profile and today's usage |
| `/voice` · `/voice on` / `auto` / `off` · `/voice name eve` | Voice-note replies: show, always, when you send one, never; pick a voice |
| `/computer` | The command that connects your PC as your Bots' browser |
| `/delete`, then `/delete confirm` | Delete the account and everything in it |

## Voice

- **Voice notes in.** Voice notes are transcribed and handled like a typed message, and the Bot is told it was spoken. On a standalone server, transcription tries the user's enabled personal OpenRouter connection first, or the server's OpenRouter key when the account is not using a CLI subscription (`OPENROUTER_STT_MODEL`, default `openai/gpt-4o-mini-transcribe`). It then tries configured platform voice, followed by the legacy direct provider when the account is not using a CLI subscription. CLI accounts without a personal OpenRouter connection use platform voice; they do not silently charge the server's OpenRouter or legacy direct key. Tenant credential routing stays scoped to that tenant. Unsupported containers such as Apple's CAF are converted to MP3 with the bundled ffmpeg (`ffmpeg-static`) before transcription, including on platform voice. If xAI rejects a supported non-MP3 recording with HTTP 400/415, it is converted and retried once before provider fallback continues.
- **Voice replies out.** Each user picks **Reply by voice** in Settings → Messaging, or by text with `/voice`:
  - **When I send a voice note** (default): voice in, voice out; text in, text out.
  - **Always.**
  - **Off.**

  The reply text always arrives too; the voice note follows it as an audio attachment, on iMessage only. Speech uses OpenRouter's provider voices (`OPENROUTER_TTS_MODEL`, default `openai/gpt-4o-mini-tts`), so by default each Bot speaks in its own voice, the one it uses on live calls. A user can pick one voice for all Bots (`/voice name eve`, `/voice name bot` to go back). Links aren't read aloud ("I've sent the link in my text"), and long replies are cut at a sentence with "The details are in my text." If speech fails, the text still arrives.
- **Live calls** in the web app (realtime, interruptible, provider voices) use the configured realtime API and need a compatible direct provider key. OpenRouter has no realtime API.

## What reaches your phone

The bridge (`server/src/messaging/bridge.ts`) watches the transcript and sends:

- Replies to what you texted, from any Bot.
- Background work: routines, check-ins, Bots reporting back. With **Send me: Only Bots I message by text**, only from the primary Bot and Bots you've texted in the last day.
- Approvals, questions and app-connection links, from any Bot.
- Errors in turns you started by text.
- Replies to messages you typed in the web app stay there while it's open, and come by text when it isn't.

Messages go to the channel you last wrote from. Text is plain (Markdown is stripped) and split at 1,500 characters for iMessage, 1,200 for SMS and 4,000 for WhatsApp. Messages go out once and in order. If the line isn't ready, they wait in a queue.

## Reliability and security

- Webhooks are verified before anything is read: HMAC-SHA256 over `{request id}.{timestamp}.{raw body}` with the line's signing key, within 5 minutes.
- Each event is saved to a durable inbox before it's acknowledged, deduplicated by event id, handled in order, retried with backoff (3 attempts), and replayed at boot after a crash.
- The admin key, the identity key and the signing key are stored encrypted with `SESSION_SECRET`. Media downloads never receive the API key.
- Text sign-up waits until the server has an owner, so the first account is never a stranger.
- Accounts created by text have a placeholder email until they add a real one (Settings → Messaging → Account). An email that already has its own account is refused; accounts are never merged.

## Code map

| File | Role |
|---|---|
| `server/src/messaging/bridge.ts` | Routing, commands, cards, outbound rules, queue. Channel-agnostic; adapters plug in with `registerAdapter` |
| `server/src/messaging/inkbox/` | Inkbox adapter: REST client, webhook, event parsing, line setup |
| `server/src/messaging/signup.ts` | Front desk: claims, invites, waitlist, caps, welcome and onboarding |
| `server/src/messaging/approvals.ts` | Approval tokens and the bare-verdict rules |
| `server/src/messaging/inbox.ts` | Durable webhook inbox |
| `server/src/messaging/store.ts` | Links (one per channel), preferences, message log, codes, invites, waitlist, sign-in tokens |
| `server/src/accounts.ts` | Accounts with or without email, sign-in links, deletion |
| `web/src/components/config/MessagingSettings.tsx`, `web/src/components/JoinPage.tsx` | Settings → Messaging and the join page |

## Tests

`npm run test:messaging` runs real agent turns against the mock model and a fake Inkbox API. It covers signatures, the inbox, every sign-up path, onboarding, routing, plain-text replies, voice notes and photos, approval tokens and tapbacks, sign-in links, link codes, caps, account deletion, and line setup with resume. No phone, keys or network needed.
