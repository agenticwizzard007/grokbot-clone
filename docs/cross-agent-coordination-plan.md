Proposed refinement: background agent communication with Quinn as coordinator

This is a design and implementation plan, based on the supplied screenshot and the current source. The behavior described below is proposed; runtime behavior has not been changed.

The broader [Quinn chief-of-staff plan](quinn-chief-of-staff-plan.md) builds on this communication foundation with objective ownership, centralized coworker management, proactive supervision and verified outcomes.

The intended experience is that agents exchange information and coordinate work automatically. The user sees a small activity entry such as “Quinn and Nia exchanged updates,” while Quinn maintains the team overview and delivers the daily synopsis. Users can still speak directly to individual agents.

**What the current implementation does**

| Existing behavior | Consequence | Source |
| --- | --- | --- |
| `enqueueBotMessage` appends the full message to the recipient’s chat and queues a bot turn. | Internal coordination becomes a visible conversation bubble. | [loop.ts](../server/src/agent/loop.ts) |
| Model text streams into ordinary assistant rows, including during bot-triggered turns. | Hiding only the incoming message would still expose the recipient’s narration or reply. | [loop.ts](../server/src/agent/loop.ts) |
| `send_to_bot` relies on a later explicit response and limits exchanges to three hops. | Reporting depends on agent behavior; the hop-limit fallback tells the agent to answer the user. | [tools.ts](../server/src/agent/tools.ts) |
| The normal text prompt includes a team roster; saved memories belong to individual bots. | Quinn does not automatically receive a complete, current operational picture. | [prompt.ts](../server/src/agent/prompt.ts), [tools.ts](../server/src/agent/tools.ts) |
| Voice has agent inspection and call-scoped team updates. | Useful coordination capabilities exist, but need a persistent service shared with text and background work. | [voice-controls.ts](../server/src/voice-controls.ts), [voice.ts](../server/src/voice.ts) |
| Check-ins inspect waiting tasks, approvals and recently triggered routines. | A routine having run is not evidence of its result; the check-in lacks a complete team result history. | [proactive.ts](../server/src/proactive.ts) |
| Durable jobs and tool dispatch records already exist. | Extend them for communication delivery and coordination instead of introducing a second execution system. | [jobs.ts](../server/src/agent/jobs.ts) |

Two specific interactions need attention. Setup agents cannot use `send_to_bot` and their prompt tells them to address the user even after another bot’s message. Also, `runTurn` cancels a pending approval for non-resume triggers; bot messages do not receive the waiting behavior implemented for independent voice assignments. A background status exchange must not restart setup or cancel an approval.

**1. Separate internal communication from user conversation**

Introduce a durable internal inbox and communication record. Each exchange carries tenant and agent IDs, message type, task/workflow references, parent and reply references, an idempotency key, timestamps, and delivery state. Resolve names to stable IDs before dispatch.

Distinguish information, requests, results and escalations. Information updates shared state without requiring an LLM turn or an acknowledgement conversation. Requests wake the responsible agent when it can safely act. Results return to the requester and update Quinn’s overview automatically. Only unfinished requests require follow-up.

Persist the audience on the job, outputs and continuations. Internal inputs, assistant text, tool arguments and results remain internal throughout streaming, approval resumes and connection callbacks. The runtime enforces this routing; `stay_silent` and prompt instructions are not sufficient enforcement.

User-facing messages are explicit outputs: a reply to a direct user request, Quinn’s report, or a decision that needs the user. Keep necessary approval and connection cards visible and tied to the original task. Quinn can summarize a pending decision and route the answer without creating a second approval.

**2. Make Quinn’s awareness automatic and persistent**

Maintain a durable team event history and a current-state view derived from it. Commit events with the underlying state change, then deliver them through an outbox so restarts cannot silently lose updates. Cover task acceptance, start, progress checkpoints, blocking, results, failure, cancellation, setup revisions, activation, routine changes, and newly saved work artifacts. Direct user instructions to specialists must enter this record too, with relevant context and source references.

Quinn observes every agent’s operational events, including peer-to-peer exchanges and temporary helpers. This observation updates its state without making Quinn an execution bottleneck. Specialists may communicate directly when their responsibilities require it.

For each agent, retain its role, setup/activation status, current assignments, dependencies, latest evidenced result, blockers, pending decisions, next scheduled work and last observation time. Preserve the difference between a model run ending and the requested outcome succeeding.

Load a compact team snapshot and unread changes when Quinn reasons, with tools for retrieving full task results and history. Reuse the existing voice inspection projections through a shared service. Store Quinn’s processing cursor outside conversation history so chat clearing and compaction do not erase operational awareness.

“Absolute knowledge” should mean complete access to recorded team activity and explicit knowledge of gaps. Track source, revision and freshness. Reconcile state periodically, detect stalled jobs, and label missing or stale observations as unknown. Quinn must not claim to know external actions that the system has not observed.

**3. Share relevant knowledge automatically**

Add shared team knowledge alongside individual memories: facts, user decisions, deliverables and artifact references, with an owner, source, timestamp, revision and verification status. Publish meaningful outputs when saved; do not rely on the agent remembering to message Quinn afterward.

Subscribe agents by workflow and responsibility. A lead result can notify the agent responsible for content, while Quinn sees both the handoff and its outcome. If Nia owns both research and content, the workflow stays with Nia. Do not invent another agent just to create a handoff.

Share compact facts and links to full artifacts rather than copying all chat history into every prompt. Preserve the distinction between user instructions, saved configuration, observations and agent proposals. Conflicts remain visible until reconciled; an agent’s inference must not overwrite a user’s confirmed requirement. Access remains scoped to the user’s team and applicable resource permissions; sharing a reference does not grant new credentials or action authority.

**4. Make coordination reliable without creating message loops**

Use the existing durable queue with explicit request/result correlation, deadlines, acknowledgement state, retry limits and deduplication. Link cross-agent assignments to their parent workflow as well as approval continuations. A request being accepted, a message being delivered, and work succeeding are separate states.

Internal information updates must not enter the conversational path that cancels pending approvals. Independent assignments wait behind unresolved decisions; status queries read stored state. Inactive agents can report their saved setup state without starting operational work or invoking their setup interview.

Automatically record completion and blockers. Use workflow limits and cycle detection to stop repeated delegation, with unresolved exchanges surfaced to Quinn. Retain protection against infinite exchanges without converting an internal limit into unsolicited user-facing narration.

Replay committed internal events safely after restart. For external actions with uncertain outcomes, reconcile before retrying; message deduplication alone cannot make an external write happen exactly once. Batch ordinary updates and wake Quinn for blockers, important outcomes, deadlines or synopsis time rather than every token or tool call.

**5. Keep the interface quiet and truthful**

Render one compact entry per exchange, grouped when several belong to one workflow. For example:

- “Quinn requested an update from Nia” while pending.
- “Quinn and Nia exchanged updates” after the exchange finishes.
- “Nia shared research with the content agent” after delivery.

Offer details on demand in an activity view. Do not place internal payloads in ordinary chat, notification previews, unread counts, text messages or spoken updates. Apply the audience rule on the server and in every delivery adapter, not only in the React transcript.

Direct conversations with specialists continue normally. When the user asks Quinn a question, Quinn returns the consolidated answer after gathering what is needed. For older history, collapse only exchanges with reliable provenance; existing assistant replies lack sufficient attribution to hide them indiscriminately.

**6. Make Quinn own the daily synopsis**

Use a durable scheduled report with the user’s configured time, time zone and delivery channel. Read verified changes since the previous report, plus all still-open blockers. Include completed outcomes and links, work in progress, decisions needed, failures or delays, and next planned work.

Refresh stale agents through background status requests with a deadline. Report an unavailable agent explicitly instead of waiting indefinitely or presenting old information as current. Persist the report’s event boundary, content and delivery status; retry the same report after failure rather than generating duplicates. Recover missed scheduled slots after downtime according to a defined catch-up policy. An explicitly requested daily synopsis can say there were no changes; it should not silently disappear under the current optional check-in behavior.

Quinn also sends timely updates for material blockers or results according to the user’s notification preferences. Routine peer exchanges remain activity entries. An immediate alert already sent should not become a second identical alert in the daily report.

**The supplied Nia example**

When the user adds “Nia writes the content strategy from her leads and saves new content to Notion,” save that requirement with its source and configuration revision. Quinn immediately sees the revised responsibility and whether it is draft or active. Relevant workflow participants receive the update automatically.

If Nia is awaiting activation or a target audience, Quinn reads that from current state and consolidates the necessary user decision. It does not need to send Nia a visible questionnaire asking for facts the system already stores. Later, verified lead results and saved content references update shared knowledge and Quinn’s daily report. A “saved to Notion” claim requires a successful operation and an artifact reference. The screenshot is historical context, not verification of Nia’s current live status.

**Implementation order and completion criteria**

1. Add persisted audience, exchange identity and task provenance; route internal input and output separately across the runtime, transcript, voice and messaging bridge. Preserve direct user replies and decision cards.
2. Add the event history, outbox, current team state and automatic lifecycle hooks; expose shared inspection to text, voice and Quinn’s prompt. Backfill from recorded state without inventing historical outcomes.
3. Add knowledge publication, workflow subscriptions and reliable peer request/result delivery. Handle pending approvals, inactive agents, retries, cycles and stale observations.
4. Connect Quinn’s durable synopsis and notification policy, then validate the complete experience.

Acceptance scenarios should prove that a Quinn–Nia exchange produces one compact entry with no internal payload in chat or outbound channels; a direct instruction to Nia reaches Quinn without manual forwarding; two specialists can coordinate while Quinn observes both; inactive status can be inspected without activating work; an internal update preserves a pending approval; restart recovery neither loses events nor duplicates work; stale and failed outcomes remain explicit; and the scheduled synopsis includes every agent’s relevant outcomes once, with links and accurate unresolved decisions. Include isolation checks between different users and both API and subscription runtime paths.

Validation for this document: inspected the screenshot and the cited runtime, UI, memory, voice, messaging and scheduling paths. No implementation changes or runtime tests were performed.
