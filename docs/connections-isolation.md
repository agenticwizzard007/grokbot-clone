# How users' connected apps stay their own

This answers one question for everyone on the team: when a person connects Gmail, Notion or any other app to their
Bots, is that connection ever visible to, or usable by, another user, including when they come back later or move
from the shared server to their own isolated environment? Verified against the code on main and its tests on
2026-11-11; where the proof is simulated rather than live, it says so.

## The rule Composio enforces
Composio partitions connected accounts by the `user_id` the application passes, inside one Composio project.
Composio's own guidance: use the immutable primary key from the application database as `user_id`, never an email
and never a shared value such as `default`, because "different customers could inherit the same connection scope".
A user may hold several accounts for one toolkit (personal and work Gmail) and must select one. Shared or pinned
connections exist in Composio only if a project explicitly allows and pins them; our projects must never do so.

## What our code passes to Composio
- The `user_id` is always the Swarm account's immutable id (`usr_…`). It is never an email, phone or display name,
  and never a shared constant.
- **Shared server today (`server/src/composio.ts`):** listing, use and disconnect of connections call Composio with
  `userIds: [userId]` and `accountType: 'PRIVATE'`; a user can only see or remove accounts filed under their own id.
  Sessions and prompt caches are per user and are invalidated when that user's connections change.
- **Isolated platform (`server/src/platform/composio-*.ts`):** each tenant row stores its `composio_user_id`, which is
  the same immutable id. The gateway holds the platform project credential; tenants never see it. Before any tool
  runs, the gateway checks the connection row belongs to that tenant, is active, has the expected revision and
  toolkit, and then re-verifies upstream that Composio lists that account under that identity. Multiple accounts for
  a toolkit require an explicit selection or a saved default; guessed account ids fail. Revocation blocks dispatch
  even mid-flight, and uncertain outcomes are never replayed automatically.

## Coming back, and moving from the old environment to the new one
- A returning user signs in to the same immutable id, so Composio returns the same private accounts. Nothing is
  keyed to a session, device or environment.
- Migration from the shared server to an isolated tenant keeps the same Composio `user_id`, so connections carry
  over by identity. The import stages the legacy private-account inventory and admits an account only when Composio
  attests it is private under that same immutable identity; anything ambiguous must be reconnected by the user.
  Email matching can never adopt another account.
- Deleting an account revokes its connections before cleanup; a deleted or revoked tenant cannot resolve any
  connection.

## What is proven, and how
| Claim | Evidence |
|---|---|
| Every connection page, use and disconnect is scoped to the requesting user | `tests/composio.test.mts`: "all connection pages stay scoped to the requesting user, including disconnect", "one project gives each user a separate session", "agents receive only the ownership-enforcing app adapter" |
| Two hundred simulated accounts across users never cross | `tests/gateway-isolation.test.mts`: "50 Notion and 150 Gmail simulated authorizations stay private across all operations" |
| Guessing another user's account id or substituting identity fails | "multiple accounts require selection; guessed IDs and tool/identity substitution fail" |
| Disconnect and revocation stop use, even during a check or after reservation | "disconnect and uncertain outcomes prevent subsequent dispatch", "revocation while upstream ownership is being checked blocks refresh and tool dispatch", "runtime revocation after dispatch reservation blocks the provider side effect" |
| OAuth and native callbacks cannot be hijacked across browsers | "OAuth callbacks only report success for a confirmed connection", "native app connection callbacks retain the initiating account across browser cookie jars and reject tampering" |

These run on every change in the Tenant isolation CI job against a simulated Composio. **They are not live
proof.** Live verification against Composio's real API, with two users and three private accounts per toolkit,
is what the provider qualification harness (`docs/provider-qualification.md`) performs once the owner supplies the
test identities; its result is recorded as the `provider-hosted-login` and `provider-quotas` release gates.

## Limits to state plainly
- On today's shared server, separation between users is enforced by application code and these tests, with one
  shared database and one process. The isolated platform adds the real boundary: one VM, volume and network per
  user, and a gateway that holds the only Composio credential.
- Use one Composio **project** per environment (staging and production), with a project key, so staging tests
  can never touch production users' connections; never enable shared or pinned connections in those projects.
- The Composio project credential is platform-owned and shared across users by design; isolation rests on the
  per-user `user_id` partition plus our ownership checks, which is the model Composio documents for consumer apps.
