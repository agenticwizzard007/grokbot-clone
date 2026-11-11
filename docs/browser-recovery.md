# Browser interruptions and recovery

Bots are instructed to inspect unfamiliar screens and continue with the smallest reversible action: dismiss optional overlays, use fresh page elements, wait for a loading page, or switch to an already connected app. Login recovery first uses an authorized saved session or existing SSO session for the intended account. Recovery does not expand the Bot's permission to send, purchase, delete, grant access, or change security settings.

## Runtime behavior

- Playwright browser results are checked for visible sign-in forms, verification prompts, dialogs, CAPTCHA metadata, and errors. A detected interruption cancels the rest of the preplanned tool batch and returns the observation to the model to choose its next action.
- Identical browser actions that return the same observed page twice are bounded within the turn. Before a third attempt, the runtime reads the page again. It skips the action if nothing changed, and permits it if the page progressed. Failed actions are also counted. Read-only snapshots remain available. The system prompt asks the Bot to try different approaches and escalate after three unsuccessful approaches; that broader limit is model-directed.
- `wait_for_browser_access` asks for the one human action needed, includes the Bot's live-screen link and a checkpoint of completed work and the next step, and polls with read-only browser snapshots. It uses no model calls while waiting. A cleared access screen must be observed twice before the model continues and verifies access. Optional `resume_when` text adds a required visible completion condition; it is required when the initial screen is not recognized as an access gate.
- A missing snapshot, blank page, browser error, or ongoing dialog cannot complete the wait. Stop cancels it, including an in-flight observation. The default wait is ten minutes; `BROWSER_ACCESS_WAIT_MIN` accepts a positive duration up to thirty minutes. After timeout the Bot ends the turn and asks the user to reply once ready.
- CAPTCHA retains its existing dedicated human handoff. An unresolved CAPTCHA now ends the turn and discards queued actions. `ask_user` and other tools that end a turn also cancel all remaining calls in that batch.
- The older screenshot-only local browser dismisses informational JavaScript alerts and cancels native confirm/prompt/beforeunload dialogs. Structured browser tools let the model inspect and handle dialogs explicitly.

## Coverage and limits

Detection uses the current visible accessibility snapshot and conservative English form labels. It is guidance rather than proof of authentication. The model must verify the intended account and actual access before resuming. Unrecognized/localized pages, unlabeled controls, and screenshot-only desktops rely on the shared visual recovery instructions; use `ask_user` with a checkpoint and live-screen link when necessary. Existing approvals and agent-activation requirements still apply.

The checkpoint is saved in the conversation. Automatic polling runs only while the current turn/server remains active and occupies that turn's queue; this is not a persistent background login monitor. After a restart or timeout the user must reply to resume. The retry budget is per turn and resets for a new turn, including approval resumption. Browser sessions persist according to the selected computer provider. Credentials, MFA codes, and CAPTCHA solutions are supplied on the site, not collected in chat or extracted from another browser.

## Validation

Run `node --import tsx --test tests/browser-recovery.test.mts` and `npm run typecheck`. Tests cover detection, repeat suppression, progress resetting the budget, read failures, completion markers, cancellation, checkpoint handoffs, and real agent-loop handling of interrupted batches. They use isolated storage and a mock model/browser; they do not establish success rates for real websites or a particular model.
