# Platform phone signup administration

These controls govern **new phone/messaging accounts**. They do not replace Google/Apple/OpenRouter identity verification, change subscription concurrency or turn an existing user's email/phone setting into a login identity. The standalone application keeps its existing owner UI; the isolated platform uses the explicit directory role below.

## Administrator role

There is no browser, model, runtime or public API for granting platform administrator roles. A trusted directory operator must first verify the intended account's immutable `tenants.id` and its provider subject in `identities`. An email match is insufficient. Use an audited parameterized operation against the platform directory:

```sql
INSERT INTO account_roles(tenant_id,role) VALUES($1,'admin');
```

`$1` is the reviewed immutable account ID, never an email or a request-supplied tenant override. Record the operator, reason and exact account ID in the operational change record. To remove authority, delete that exact role record; subsequent authorized checks fail. Deletion/revocation while a mutation already holds the role/session locks follows transaction ordering. A completed mutation cannot be retrospectively cancelled.

The user signs in normally. In messaging settings, administrators see signup policy, invitations and waitlist metadata. The API validates role and session on each request; hiding controls is not the authorization boundary. Reading requires a live session; changing policy, creating/revoking invitations or deciding a waitlist entry requires sign-in within ten minutes through an existing login method. No new passkey requirement is introduced.

The platform mounts `/api/platform/signup`, `/api/messaging/invites` and `/api/messaging/waitlist` before tenant forwarding. Runtime JWTs and delegated tenant cookies cannot authenticate these routes. Requests have origin/CSRF checks, bounded JSON bodies and no-store responses. Do not proxy these administration routes to tenant applications.

## Policy and invitations

The initial policy comes from `MESSAGING_SIGNUP_MODE` (invite/open/closed), `MESSAGING_SIGNUPS_PER_DAY` (default 50) and `MESSAGING_MEMBER_INVITES` (default 5). The first administrator save creates a durable PostgreSQL override. Afterwards environment changes do not override that record. Updates require the current revision; reload after a 409 instead of overwriting a concurrent change.

- `invite`: a valid invitation or approved waitlist entry permits a fresh verified signup.
- `open`: a fresh verified signup may proceed without an invitation.
- `closed`: no new phone accounts are admitted, including approved waitlist entries and invitation holders. Existing accounts retain their sign-in/linking flows.

The daily signup ceiling applies in both admitting modes; zero means unlimited signups. Member invitation allowance is 0–1,000. Changing it applies to existing member links, so zero disables their future claims. This limit governs invitations, not active Bots, helpers or subscription jobs.

Each member has one private member invitation. Administrators can create separate bounded invitations, with a default of one use and seven-day expiry. Admin invitations have distinct allowance/expiry records. Revoking a link invalidates its pending claims. Ownership, expiration, revoked state and allowances are checked again at actual account admission. Listing is paginated at 100 entries per page.

## Waitlist privacy and admission

Only a valid signed provider message or a correct session-bound phone verification code can add a denied signup to the waitlist. The directory records phone, channel, verification time, decision metadata and revision. It does not retain sender names, message contents, prompts or credentials. The administrator UI shows contact metadata only.

Approval creates **no account and no session**. The person must later prove control again with a verified phone flow or fresh signed provider message. Closed registration and the daily ceiling still apply. Successful admission consumes the waitlist entry in the account-creation transaction. A stale decision revision returns 409.

The waitlist is capped at 10,000 contacts and expires after 30 days without a verified arrival. The provisioner runs metadata retention every minute alongside backup/retired-volume housekeeping. Expired challenges/claims are removed; locked phone attempts are skipped until a later sweep so verification and signup locks cannot deadlock. Ensure the provisioner is running even when there are no pending VM lifecycle jobs.

## Qualification

Deterministic PostgreSQL tests cover role and account substitution, session/role expiry during lock waits, body-read revocation, invitation limits, stale revisions, signed-only enrollment, fresh proof after approval, closed registration, pagination and retention. Browser fixtures exercise desktop and 390px layouts and account changes. These are not evidence of real Inkbox/native transport compatibility.

Before public phone registration, use a separate staging line and controlled identities to verify real signatures, phone challenges, callback/session handling and invitation/waitlist transitions. Do not import production phone credentials or send test messages to nonparticipants. Whole-platform deployment also requires the isolation, migration, recovery and capacity gates in [tenant qualification](tenant-qualification.md).
