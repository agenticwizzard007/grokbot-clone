# Swarms UI implementation

The accepted [Paper design directory](https://app.paper.design/file/01M7XRD50KB121YXVPQPK0VG7S/p-1-0) is implemented through the existing application routes and APIs. Chat, bot setup, Tasks, Team, Goals, Reports and account settings share the Light/Night theme, responsive navigation, self-hosted fonts and Swarms artwork. Setup and bot configuration occupy the main pane, with the caller preserved when visiting related settings. Phone pages use the device's real safe areas.

## Consumer feature access

The source audit identified these navigation and control gaps. The implementation exposes the existing authorized APIs; server eligibility and permissions remain authoritative.

| Audit | Entry point | Behavior |
| --- | --- | --- |
| G01 | New Bot → Import saved setup | Imports a setup manifest, selects the returned bot and opens its Setup. Import does not activate the bot. |
| G02 | Settings → Account → Sessions | Lists the account's sessions and revokes a selected session, including explicit current-session sign-out. |
| G03 | Tasks → Team | Account coordination switch; existing work/history remain visible while coordination is off. |
| G04 | Bot settings → Learning | Protected skill maintenance is separate from refinement; deferred/outcome responses are shown without claiming improvement. |
| G05 | Tasks → Reports → Daily synopses | Edits times, timezone and quiet hours; pausing preserves the schedule. |
| G06 | Tasks → Goals → New goal | Optional turn/token/spend limits and immediate-start choice. A goal saved without an immediate run is active, not a durable draft. |
| G07 | Tasks → Goals → Saved workflow | Adds prerequisites before admission, assigns eligible workers, and blocks/resumes with a reason. Server cycle and completion guards remain. |
| G08 | Bot settings → Memory → Conversation evidence | Role/generation filters and older result paging. Search supports user/assistant roles; tool evidence remains accessible through verified source links. |
| G09 | Settings → Custom tools / Account | Recent-auth recovery returns to the same account and requires an explicit mutation retry. Secrets are not serialized in the return marker. |
| G10 | Sidebar usage / Plans / Usage | Shows reported provider windows and resets; expired estimates become stale or unavailable, never zero. The sidebar does not probe a provider. |

Existing consumer features remain reachable: live chat decisions and exchanges; model/effort selection, dictation and voice; coworker setup and activation; groups; Harness, skills, memory, learning/evaluation and History; routines, immutable reports and delivery verification; connected apps, custom MCP tools and permissions; CLI subscriptions and login/reset recovery; computer/device controls; messaging, account and sign-in flows.

Configuration **Files** are setup exports. Computer **Files** browse device storage. **Saved reports** are immutable deliverables with independent delivery receipts. These destinations are deliberately separate.

## Recovery and boundaries

- Composer drafts and pending-send identity remain scoped to account and bot across navigation. Late responses cannot clear another conversation's draft or cause a duplicate send.
- Setup import binds the displayed account before persistence or provisioning. A successful import that completes under Account settings preserves that screen and offers an explicit Open imported setup action on return, without repeating the import.
- Report confirmation binds the exact version and recipient. Uncertain sends require verification on that channel; an independent Library save remains available. Replaying an unresolved browser request uses its original body and idempotency key.
- CLI reset retains expected-account/recent-auth checks and honest partial-effect copy. Reauthentication refreshes status and never automatically retries a reset.
- Browser CLI requests carry the expected account in the request itself, including status and terminal operations; a changed cookie is rejected before a probe, credential command or mutation. This is an extra constraint on the authenticated account, not a replacement identity. Existing direct clients remain compatible.
- Account deletion requires the confirmed account ID on both standalone and hosted routes before side effects. Session revocation reports whether it ended the session authenticating that request, so a rotated session cannot reuse an obsolete “current session” badge for navigation.
- Consumer pages retain activation, account ownership, provider readiness, device consent, recent-auth and finite-budget restrictions. Operator/provisioning endpoints are not consumer UI features.
- Arbitrary chat uploads, share links, a program catalogue and full learned-agent import are not implemented APIs and are not presented as working features. Routine instruction creation/edit remains in chat.
- Current Harness context is a prompt preview, not a historical model-input receipt. Goal `start:false` does not promise a permanently inert draft. Old delivery-read responses omit the historical recipient; confirmation shows the exact destination provided by the preview API.

## Validation

Run `npm run build` then `npm run test:updated-ui` to check all four integration areas against one built frontend. The runner uses isolated API fixtures and desktop/phone Light/Night journeys; it does not contact providers. `npm run test:hermes-native` adds real isolated server/database tests and browser journeys for setup, history, knowledge, workflows and reports. Existing voice, mobile, CLI login/reset, provider selector and connection cleanup suites preserve their behavioral assertions while following the updated navigation.

The PR and Fly workflows run the integrated suite after native validation. The normal Fly release checks image contents against the tested build manifest and verifies the deployed revision and public assets. Provider execution, native device permissions and external messaging still require configured-account QA; browser fixtures and Paper captures do not certify those external gates.

## Design provenance

Accepted Paper V13 was pinned to source `46ffb7cc090ea70e179c9f6511a7e57f9f187311`; implementation starts from `ed1f0ad41e502adceed11c145f8f3afa416cbb66`, retaining the later documentation and voice visibility/memory fixes. Design counts describe static states, not product features or runtime tests: 3,618 selected native variants, 63 continuation files and 820 selected responsive variants; 538 source checks, 1,572 prepared states and 7,858 layout checks.

The preserved workspace handoff is `.context/master-coordinator/8db7c294-6209-4db8-971d-744dcf13e5ab.md` (SHA-256 `b838c5b5282f47adc01f41ff05b0ae09825b69432d6560c49b1389ab6727f656`). The implementation archive SHA-256 is `95139cf789a1b3a13390d33b7fd696422e8ab862b993c109f2092eeb469117ec`; the full design manifest is `3c323608652056e2ff9b250740b2890a7224f74afa2d929cc4c59028033c6de4`. The archive and native receipts remain preserved outside Git. Shipped font licenses are in `web/public/assets/fonts/`.
