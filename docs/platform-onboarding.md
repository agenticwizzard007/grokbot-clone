# Platform onboarding and tenant operations

MT-C applies only to the isolated platform roles. The shared server with `SWARM_ROLE=standalone` keeps its existing authentication, sessions and sign-in view. This runbook describes operator actions, not evidence that an isolated environment is deployed or qualified.

## Before inviting anyone

Complete the owner inputs and qualification in [staging bootstrap](../infra/platform/staging-bootstrap.md). Use the dedicated platform PostgreSQL database, never the shared server database. Run the existing schema migration with its schema-owner credential before starting the new platform version. The migration is repeatable and adds `web_invites`, `web_waitlist` and the phone attempt invite field. The serving roles retain their existing grants. Operator policy writes use a null `updated_by` to denote trusted database administration; they do not invent a tenant or grant an application administrator role.

Run the CLI in a trusted operator environment using a protected `DATABASE_URL` supplied out of band. Do not put connection strings in shell history. Set `PLATFORM_URL` to the owned HTTPS origin, with no path, query, fragment or embedded credentials. The examples below assume the reviewed server build and an already configured environment:

```sh
node server/dist/platform/tenants-cli.js policy show
node server/dist/platform/tenants-cli.js tenants list
```

The CLI emits JSON and rejects unknown or repeated flags. It never loads provider credentials or calls cloud services. List and status commands select metadata fields explicitly and exclude encryption keys, session tokens, OAuth attempts and payloads. Invite creation and approval intentionally print an invitation code and URL; treat those as bearer invitations and share only with the intended customer. An invite is admission permission, not identity proof, and may be redeemed by any verified identity holding it.

## Invite the first 10 customers

1. Configure `PLATFORM_TENANT_LIMIT=10` on every platform process and the provisioner metrics process. The default is 100; invalid values refuse new admission. Existing accounts and staged migration claims still sign in. Restart the affected isolated roles after changing the environment. Do not change the standalone service.
2. Read `policy show`, then use its current revision to set invite mode and a daily allowance of 10. An empty directory reports revision `0`:

   ```sh
   node server/dist/platform/tenants-cli.js policy set --mode invite --signups-per-day 10 --revision 0
   ```

3. Issue ten separate single-use invitations, running this once per customer. No existing tenant is needed to issue the first invite:

   ```sh
   node server/dist/platform/tenants-cli.js invites create --uses 1 --days 7 --note 'First customer cohort'
   ```

   Each result includes an HTTPS URL shaped like `https://<owned-platform-origin>/?invite=<code>`. Share it through the approved operator process. The CLI sends nothing. The customer follows the link and signs in with Google, Apple, OpenRouter or phone. Hosted native Google/OpenRouter starts accept `invite`; native Apple starts accept JSON `inviteCode`. Phone starts store JSON `inviteCode`; verification can also provide a replacement `inviteCode`.
4. Check each resulting tenant and its lifecycle job:

   ```sh
   node server/dist/platform/tenants-cli.js tenants list
   node server/dist/platform/tenants-cli.js tenants status --id <tenant-id>
   ```

   Creation is queued for the qualified provisioner. A queued tenant is not a running or qualified tenant. Do not bypass image, containment, network, backup or provider gates to make it start.

## Admission rules

New tenants use the shared signup policy, including the existing `MESSAGING_SIGNUP_MODE`, `MESSAGING_SIGNUPS_PER_DAY` and `MESSAGING_MEMBER_INVITES` defaults when no policy row exists. The default mode is `invite`, the daily allowance is 50, and zero daily allowance means unlimited. The daily window is UTC and now counts new tenants across all identity providers. Linking another provider does not create a tenant or consume a place. Existing tenants, explicit identity links and staged legacy claims bypass new-account restrictions. Equal email addresses never join identities.

`open` allows new verified identities without an invite. `invite` requires a valid invitation (or the existing verified phone waitlist approval). `closed` pauses new tenants even with invitations. Web invites work with all hosted providers and phone; existing messaging invites remain for messaging/phone. Invalid supplied invitations are refused for new accounts, including in open mode. Existing accounts ignore stale invitations.

Admission serializes policy reads, UTC daily counts, capacity checks, invitation use, tenant insertion, identity insertion and the create job in one PostgreSQL transaction. A failed transaction spends no invitation. An invitation is checked again after waiting for the lock, using database wall time. The cap counts pending, provisioning, active and suspended tenants. Deleting, deleted and failed tenants do not count. Staged migrations are deliberately exempt from admission and may occupy more capacity than the limit; no new signup is then admitted.

The sign-in page displays availability only when the server reports platform mode. It offers accepted, needed, expired/used, capacity, paused and waitlist states. Availability is a hint, not a reservation. Final admission happens after identity verification. Refusals do not create sessions, tenant keys or lifecycle jobs. Existing account sign-in options remain available in every state.

## Waitlist and invitation management

The sign-in page accepts an email address or an international phone number such as `+15550000000`. These voluntary contacts are unverified and never authorize identity creation. Entries are deduplicated, capped at 10,000 and retained for 30 days; no message body or provider token is stored. Submission is limited to 20 attempts per socket address per 10 minutes and rejects cross-origin browser mutations. Deploy behind the existing trusted network boundary; the endpoint does not trust caller-supplied forwarding headers. A full waitlist returns an unavailable result so the customer can retry.

```sh
node server/dist/platform/tenants-cli.js waitlist list
node server/dist/platform/tenants-cli.js waitlist approve --id <waitlist-id>
node server/dist/platform/tenants-cli.js invites list
node server/dist/platform/tenants-cli.js invites revoke --code <invite-code>
```

Approval issues a single-use invitation lasting seven days and returns its code and URL. Repeated approval returns the same invitation, including if it has expired, been revoked or used. To issue a replacement, explicitly create a new invite. Approval sends no email or message and does not bypass the policy or cap. The CLI waitlist covers voluntary web email/phone entries. Existing signed messaging arrivals and phone approval administration retain their separate phone waitlist.

Lists return at most 100 items and a `next` cursor. Pass `--after <next>` to continue. Notes are operator metadata and must not contain secrets.

## Tenant lifecycle controls

```sh
node server/dist/platform/tenants-cli.js tenants suspend --id <tenant-id>
node server/dist/platform/tenants-cli.js tenants wake --id <tenant-id>
node server/dist/platform/tenants-cli.js tenants delete --id <tenant-id> --confirm <tenant-id>
```

Suspend and wake queue the existing fenced lifecycle jobs for active or suspended tenants. They refuse conflicting lifecycle, migration or maintenance work and never reset an in-flight job. Suspend stops the machine through the provisioner; it does not delete or free a tenant place. This is the existing idle suspension behavior: authenticated traffic or messaging can subsequently request a wake. It is not an account ban. Inspect `status` until the job completes; a queued action is not a completed cloud operation.

Delete requires the exact tenant ID twice. It immediately revokes platform sessions and runtime access and queues the existing deletion workflow. The workflow still reconciles unknown external outcomes and waits for provider cleanup and migration-source retirement. Repeating deletion is idempotent. The CLI never asserts that cloud resources were removed simply because a job was queued.

## Scale from 10 to 100

Keep invite mode while qualification, resource quotas and spend approval are reviewed. Increase `PLATFORM_TENANT_LIMIT` consistently to 25, then 50, then 100 in the isolated roles. Set a suitable `signups-per-day` using the latest policy revision and invite the next cohort with single-use links. Lowering the limit below current usage blocks new tenants without signing anyone out.

The authenticated loopback operations exporter adds `swarm_operations_current_tenants` and `swarm_operations_tenant_limit`. It remains opt-in through `OPERATIONS_METRICS_TOKEN_FILE` and `OPERATIONS_METRICS_PORT`; it is never exposed through public sign-in APIs. Watch the two gauges along with lifecycle failures and readiness. Suspended tenants still count. Tenant cap admission is not a provider quota or budget guarantee. Keep the single serving platform machine requirement until owner-aware tunnel routing is qualified.

## Local validation

Use disposable PostgreSQL and fake providers only:

```sh
TEST_DATABASE_URL=postgres://<local-test-database> npm run test:isolation
npm run typecheck
MT_UI_BASELINE=1 MT_UI_ROOT=<main-checkout> node tests/platform-onboarding-ui.mjs
node tests/platform-onboarding-ui.mjs
npm run test:readiness-kk
node tests/ui-custom/unit/client-defaults-ui.mjs
```

The UI test stores baseline and branch screenshots under `.context/mt/onboarding-ui` and compares standalone sign-in at 390 and 1280 pixels in both themes. Local tests are not evidence of live OAuth compatibility, real isolation, resource cleanup or release qualification.
