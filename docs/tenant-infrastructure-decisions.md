# Infrastructure decisions required before the isolated platform can run

Status 2026-11-11: the connected Fly account (`personal` organization) has the legacy shared server only. None of the
services below exist. Each decision names the code that depends on it and the consequence of each option.

## 1. Key service for tenant data keys
- **As coded:** `server/src/platform/envelopes.ts` calls AWS KMS `GenerateDataKey` and `Decrypt` with
  `EncryptionContext` bound to the tenant, using `TENANT_KMS_KEY_ID` and the AWS SDK credential chain. Platform,
  provisioner and gateway all construct `TenantEnvelopes` at startup and refuse to start without the key id.
- **Option A (recommended): AWS account + KMS.** One symmetric key, an IAM principal restricted to the two actions
  and the encryption-context condition, short-lived credentials on the three roles. Cost: cents per month at this
  volume. Change required: none.
- **Option B: an alternative key service.** Requires an explicit wrapping-key contract (API, trust boundary,
  rotation) approved by the isolation owner, plus a new `TenantEnvelopes` implementation and tests. The owner has
  stated it will not substitute a shared plaintext key held by the platform.

## 2. PostgreSQL for the platform directory
- **Needs:** TLS, a dedicated `LISTEN` connection per platform replica (`platform/session-notifications.ts`), so the
  application endpoint must be direct or **session** pooled (transaction pooling breaks it); a separate schema-owner
  role for `MIGRATION_DATABASE_URL`; backups with point-in-time recovery for the migration and recovery drills.
- **Option: Fly Managed Postgres.** Basic $38/month (shared-2x, 1 GB) for staging; Launch $282/month
  (performance-2x, 8 GB) for the fleet; storage $0.28/GB/month; HA, backups and PgBouncer included; PITR is not
  stated in the docs read and must be confirmed with Fly. Alternative: any managed PostgreSQL reachable over TLS.

## 3. Object storage for encrypted backups
- **Needs:** S3 API with versioning, delete markers and multipart uploads (`platform/backup-storage.ts` lists
  versions, aborts multipart uploads, deletes within a prefix); private bucket; credentials scoped to the prefix.
- **Option A: AWS S3** (natural if option 1A is taken). **Option B: Tigris on Fly** via `AWS_ENDPOINT_URL_S3`;
  confirm versioning and multipart behaviour in staging before relying on retention cleanup. Either way an S3
  lifecycle rule for aborted uploads is required (`docs/tenant-isolation.md`).

## 4. Fly organization, limits and budget
- Create a dedicated staging organization and an org-scoped `FLY_API_TOKEN` (the production token is app-scoped).
- Ask Fly support to raise limits: the platform creates one app, one custom private network, one 10 GB encrypted
  volume and one machine per tenant; 1,000 tenants plus a 1,250 burst need about 1,250 of each. Personal
  organizations start with a soft cap of roughly 20–50 running machines.
- Approve budget: staging about $185/month before tenants (`infra/platform/staging-bootstrap.md`); fleet at 1,000
  simultaneously active tenants about $27,000/month for tenant machines and volumes (`tenant-capacity-model.md`).

## 5. Credentials and identities
Google OAuth client (staging and production; callback `${PLATFORM_URL}/api/auth/google/callback`), Apple staging
service/client identifiers, a platform-owned Composio **project** credential and webhook secret, an Inkbox staging
line, two hosted Claude and two ChatGPT test subscriptions plus test identities for the provider harness, an alert
destination (Slack, email or PagerDuty), a cosign key pair for image signing, and for the Mac app a Developer ID
Application identity for team A77YW376ZH with notarization credentials.

## 6. Policy decisions
- **Migration of existing accounts:** the shared server has no per-user filesystem fence, so an honest cutover needs a
  whole-source maintenance pause (read-only window) or an enforceable per-tenant writer boundary. Decide: maintenance
  window, or existing users re-link instead of migrating. Also: source retention and deletion policy.
- **Scaling (PR #21 operator path):** per-tenant minimum and maximum CPU/RAM/disk, spend ceilings, whether resizes may
  interrupt busy tenants, whether automatic downsizing is allowed, and the notification policy. Volume growth is
  irreversible.
- **Deploying current main to the shared server now:** signs most users out once and hides Google sign-in until the
  Google client exists.

## What happens once decisions 1–3 are taken
Staging can be stood up from `infra/platform/staging-bootstrap.md` in one working session; containment (gate 2 of
the owner's list) runs on a Fly performance machine; the first isolated tenant follows.
