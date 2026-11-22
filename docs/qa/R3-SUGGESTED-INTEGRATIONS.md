# Suggested integrations with Composio logos

You are the implementer for this item only. Do not take on the loader animation, effort picker, plan connections, or the round 3 leftovers, except you must keep any CSP logo allowlist or proxy compatible with leftovers item R2F-038 (that PR tightens `img-src` and will land after you).

## Your job
1. Read this brief fully. Commit it unchanged as `docs/qa/R3-SUGGESTED-INTEGRATIONS.md` on your branch.
2. Implement logos and Bot-aware suggestions as specified.
3. If this environment lets you spawn more agent sessions, spawn a reviewer or tester at model `gpt-6-astra` and effort `ultra` (agent `codex`). Do not silently pick a different model or effort. If those values are not offered, stop and report the exact mismatch.
4. Checks before the PR: `npm ci && npm run typecheck`, existing app-catalog / Connect Apps tests, plus new tests for logo chips, fallback monograms, Bot-aware ranking, and "never suggest an unavailable toolkit". Keep every existing test green.
5. One branch and ONE PR to `main` titled `QA R3: suggested integrations with Composio logos`.
6. Merge only when CI is green. This item is second in the merge order, after the loader PR and before the effort picker. If leftovers later tighten CSP, your logo path must still work: prefer a same-origin proxy, or an explicit allowlist of the logo host, and describe it in the PR body so leftovers can keep it.
7. Guardrails: no secrets in logs; no force push; no em dashes or en dashes in PR text, docs or new UI copy; no person's name in code, docs or PR text. Do not connect or disconnect real apps in a live account as part of testing.

## Repo and live app

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Commit tested | `main` @ `9f2481a2c805e86d1af93a43cf6703e18f5bfd19` |
| Live app | https://swarm-team.fly.dev |
| Current CSP | `img-src 'self' data: blob: https:` in `server/src/security/request.ts` (contentSecurityPolicy). Leftovers item R2F-038 will tighten this and must not break logos. |

## Sequencing
Merge order: (1) loader, (2) this suggestions PR, (3) effort picker, (4) plan connections, (5) leftovers last. Coordinate CSP with leftovers: if you add `logos.composio.dev` to `img-src`, leftovers must keep it, or you should proxy logos through a same-origin route such as `/api/toolkits/icon/:slug` (same pattern as `/api/models/icon/:author` in `routes-models.ts:81-104`). A same-origin proxy is the safer fit with a tighter CSP.

## Root cause
Suggested integrations are a hardcoded Slack row with a plain-text title and no logo, and they are not derived from the Bot's description or from the live Composio catalog.

- Details > Activity > Suggested: `web/src/components/DetailsPanel.tsx:101-146, 176-178`. Always `DetailRow title="Slack"` and an "Add to Slack" button that calls `api.connect('slack')`. Hide is a single account-wide localStorage flag (`hideSuggestedKey` in `web/src/components/config/settingsLogic.ts:11-12`).
- Bot creation (`CreateBotModal.tsx`) has no integration suggestions. Bot settings About is a plain textarea (`BotSettingsModal.tsx`, field "About", `id="cfg-about"`, 300 character description) with no suggestions that update as the user types.
- Logos already exist for Connect Apps: `ToolkitLogo` (`web/src/components/ToolkitLogo.tsx:1-24`) uses `toolkitLogo` (`web/src/lib/toolkitLogos.ts`). Bundled SVGs live under `/assets/toolkits/` for a small set (gmail, github, slack, googlecalendar, notion, and others). If there is no bundle, it uses the provided `logo` URL or `https://logos.composio.dev/api/${slug}`. Failed images fall back to a monogram letter. Connect Apps already passes `app.logo` from the catalog (`ConnectAppsModal.tsx:60`).
- The live toolkit list is `catalog()` in `server/src/composio.ts` (cached an hour): each item has `slug`, `name`, `logo: t.meta?.logo`, `description`, categories. This is the list of connectors actually available in the integrated Composio library. Suggestions must be drawn only from this list (or a fresh fetch / the same cache), never from a hardcoded array like `['slack']`.

Round 3 leftover R3-041 is a different bug (review "Resources" text showing "toolkit slack, revision 1"). Do not try to fix R3-041 here; leftovers owns that. The "toolkit slack" wording is a reminder that raw toolkit slugs should not be shown as user-facing copy. Suggestion chips should use the toolkit's display name plus logo.

## Wanted behavior
(1) Each suggestion is a clean chip or card with the toolkit's real logo and name, not plain text. Prefer the Composio metadata logo URL, otherwise the bundled asset, otherwise a monogram if the image fails. Logos must work after CSP tightening (same-origin proxy or allowlisted host).

(2) Suggestions are Bot-aware. Analyze the Bot's description and purpose (description, and instructions or setup purpose when present) with an LLM call or an embedding match against the available Composio catalog, fetched live or from the cached toolkit list. Recommend the top relevant toolkits, each with a one-line reason. Never use a hardcoded or generic list. Never suggest a toolkit that is not in the available catalog. Refresh when the description changes, with a debounce. Hide already-connected toolkits, or mark them as connected without a second connect CTA.

Examples: description "track GitHub PRs and post to Slack" suggests GitHub and Slack, with logos and short reasons. "manage my calendar" suggests Google Calendar (or the catalog's exact calendar toolkit name), with logo and reason.

Show this in:

- Bot details Suggested section (replace the hardcoded Slack row)
- The Bot description / About UI and the creation flow if the user enters a purpose or description there. If create has no description field today, add suggestions next to About in Bot settings and in details, and next to any description field you already have or add in create.

Connecting a suggestion should reuse the existing connect popup path (`api.connect(slug)`), not a Slack-only function.

## Files to change (likely)
- `web/src/components/DetailsPanel.tsx`
- `web/src/components/config/BotSettingsModal.tsx` (About field)
- `web/src/components/modals/CreateBotModal.tsx` if a description or purpose is entered at create
- `web/src/components/ToolkitLogo.tsx`, `web/src/lib/toolkitLogos.ts`
- `server/src/composio.ts` `catalog()`, plus a new suggestion endpoint that filters to available slugs
- CSP / icon proxy in `server/src/security/request.ts` or a new icon route
- Tests for ranking, unavailable slugs excluded, debounce, logo fallback

## Acceptance criteria
- No hardcoded Slack-only (or any fixed) suggestion list in the shipped UI.
- Every visible suggestion is a chip or card with logo (or monogram fallback) and the toolkit display name, plus a one-line reason.
- Suggestions are a subset of the current Composio catalog. A slug that is not in the catalog never appears.
- A description about GitHub PRs and Slack yields GitHub and Slack when those toolkits are in the catalog. A calendar description yields the catalog's Google Calendar (or equivalent) toolkit.
- Editing the description refreshes suggestions after a debounce, without a request per keystroke.
- Logo images work with the current CSP and remain safe when `img-src` no longer allows all of `https:`.
- Image onError shows a monogram. New tests cover these cases. Existing Connect Apps tests still pass.
