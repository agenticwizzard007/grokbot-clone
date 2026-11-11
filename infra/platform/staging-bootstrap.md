# Staging bootstrap runbook (one isolated environment)

Nothing here has been executed. Every step that creates a billable resource is marked **[$]** with the list price
(Fly, effective 2026-10-01). Decisions in `docs/tenant-infrastructure-decisions.md` must be made first: key service,
storage provider, Fly limits, budget, credentials. Use a staging organization, never the `personal` production org,
and never copy production secrets into staging.

## 0. Inputs you must already hold
- Fly organization slug for staging (`FLY_ORG_SLUG`) with a limit increase covering at least 10 apps for staging.
- Owned DNS names for the platform and gateway origins (TLS via Fly certificates).
- AWS account with a KMS symmetric key (or the approved alternative) and an IAM principal limited to
  `GenerateDataKey`/`Decrypt` with `EncryptionContext purpose=swarm-tenant-master-v1`.
- Backup bucket: AWS S3 (versioning on, public access blocked) or Tigris on Fly (`flyctl storage create`).
- Ed25519 platform key pair; a `SESSION_SECRET` of at least 32 random bytes; Composio **project** credential and
  webhook secret; staging Google/Apple OAuth clients; Inkbox staging line; `cosign` and `trivy` installed.

## 1. Postgres **[$ Basic $38/month + $0.28/GB storage]**
```sh
flyctl mpg create --org <staging-org> --name swarm-staging-pg --region iad --plan basic
flyctl mpg attach swarm-staging-pg --app swarm-platform-staging       # after step 3 creates the apps
```
Create two roles: a schema owner (for `MIGRATION_DATABASE_URL`) and an application role (for `DATABASE_URL`).
Use the direct or **session-pooled** endpoint for `DATABASE_URL`: the platform keeps one `LISTEN` connection per
replica and transaction pooling breaks it.

## 2. Object storage **[$ AWS S3: cents per GB at staging scale]**
With the current code the platform, provisioner and gateway build `KMSClient({})` and `S3Client({})` from the same
default credential chain, so the AWS principal must be authorized for both KMS and the bucket. Create a private,
versioned S3 bucket in the KMS account and set `BACKUP_BUCKET`. **Tigris is not usable yet:** replacing the AWS keys
with Tigris keys would send Tigris credentials to KMS; offering Tigris requires separately configured S3 credentials in
`platform/backup-storage.ts` first (decision 3 in `docs/tenant-infrastructure-decisions.md`).

## 3. Apps **[$ platform 1 × performance-2x = $66/month; provisioner shared-cpu-2x 1 GB ≈ $7.40; gateway ≈ $7.40]**
```sh
flyctl apps create swarm-platform-staging --org <staging-org>
flyctl apps create swarm-provisioner-staging --org <staging-org>
flyctl apps create swarm-gateway-staging --org <staging-org>
flyctl certs add -a swarm-platform-staging platform-staging.<your-domain>
flyctl certs add -a swarm-gateway-staging gateway-staging.<your-domain>
```
Edit the manifests to those origins: `PLATFORM_URL`, `APP_URL` and `SERVER_URL` in `fly.platform.toml` (all three the
platform origin), `COMPOSIO_GATEWAY_URL` in the platform and provisioner manifests, `PLATFORM_URL` in the gateway manifest.

## 4. Secrets (names as the manifests list them)
Write each app's secrets as `NAME=VALUE` lines into a protected file (mode 0600, outside the repository) and import
them from stdin; never pass secret values as command arguments. File-mounted secrets (`[[files]]`) must be the
base64 of the PEM.

```sh
umask 077
cat > /secure/platform.env <<EOT
SESSION_SECRET=<32+ random bytes>
DATABASE_URL=<application role, direct or session-pooled endpoint>
TENANT_KMS_KEY_ID=<KMS key ARN>
AWS_ACCESS_KEY_ID=<principal authorized for KMS and the bucket>
AWS_SECRET_ACCESS_KEY=<...>
BACKUP_BUCKET=<private versioned bucket>
COMPOSIO_API_KEY=<platform project credential>
GOOGLE_CLIENT_ID=<...>
GOOGLE_CLIENT_SECRET=<...>
INKBOX_API_KEY=<...>
INKBOX_ADMIN_API_KEY=<...>
INKBOX_IDENTITY_ID=<...>
INKBOX_SIGNING_KEY=<...>
INKBOX_HANDLE=<...>
PLATFORM_PRIVATE_KEY=$(base64 -w0 < /secure/platform-private.pem)
PLATFORM_PUBLIC_KEY=$(base64 -w0 < /secure/platform-public.pem)
EOT
flyctl secrets import --stage -a swarm-platform-staging < /secure/platform.env

cat > /secure/provisioner.env <<EOT
SESSION_SECRET=<same value as the platform>
DATABASE_URL=<application role>
FLY_API_TOKEN=<org-scoped token>
FLY_ORG_SLUG=<staging-org>
TENANT_KMS_KEY_ID=<KMS key ARN>
AWS_ACCESS_KEY_ID=<...>
AWS_SECRET_ACCESS_KEY=<...>
BACKUP_BUCKET=<same bucket>
TENANT_HOST_IMAGE=<set in step 7, digest-pinned>
EOT
flyctl secrets import --stage -a swarm-provisioner-staging < /secure/provisioner.env

cat > /secure/gateway.env <<EOT
DATABASE_URL=<application role>
TENANT_KMS_KEY_ID=<KMS key ARN>
AWS_ACCESS_KEY_ID=<...>
AWS_SECRET_ACCESS_KEY=<...>
COMPOSIO_API_KEY=<platform project credential>
COMPOSIO_WEBHOOK_SECRET=<...>
PLATFORM_PUBLIC_KEY=$(base64 -w0 < /secure/platform-public.pem)
EOT
flyctl secrets import --stage -a swarm-gateway-staging < /secure/gateway.env
shred -u /secure/*.env
```
`APP_URL` and `SERVER_URL` are not secrets: they are set in `fly.platform.toml` `[env]` in step 3. After the first
deploy, verify on each machine that the mounted key files decode to the exact PEM by comparing hashes, without
printing them.

## 5. Build the application image once and pin its digest
```sh
flyctl deploy -c infra/platform/fly.platform.toml -a swarm-platform-staging --remote-only --build-only --push --image-label platform-<git-sha>
flyctl image show -a swarm-platform-staging        # note the @sha256 digest for APP_IMAGE / RUNNER_IMAGE / MCP_IMAGE
```

## 6. Schema migration (dedicated trusted job; see README.md)
Create `swarm-migrate-staging`, import the base64 schema-owner URL with `flyctl secrets import --stage` from a protected
file, run the job with `--file-secret` so the credential is read only by that process, verify the mounted file by hash
without printing it, then unset the secret. Never pass it with `-e` or on argv, and never store it on a serving role.

## 7. Tenant host image **[$ build machine while running]**
Build `HOST_BASE` and `DESKTOP_BASE` (definitions still to be authored; see `docs/tenant-capacity-model.md` and the
owner notes), sign and scan every component image, then run `infra/tenant-host/build-release.sh` with digest-pinned
`APP_IMAGE RUNNER_IMAGE MCP_IMAGE DESKTOP_IMAGE HOST_BASE`, `HOST_IMAGE_TAG`, `IMAGE_VERIFICATION_KEY` (cosign) and
`PLATFORM_PUBLIC_KEY_FILE`; push; set `TENANT_HOST_IMAGE` on the provisioner to the resulting `@sha256` digest. Until
those base definitions exist this step cannot be completed, so a first tenant is not a one-session outcome.

## 8. Deploy the roles
```sh
IMG=registry.fly.io/swarm-platform-staging@sha256:<digest from step 5>   # the one reviewed image for every role and the migration job
flyctl deploy -c infra/platform/fly.platform.toml -a swarm-platform-staging --image "$IMG" --ha=false
flyctl deploy -c infra/platform/fly.composio-gateway.toml -a swarm-gateway-staging --image "$IMG" --ha=false
flyctl deploy -c infra/platform/fly.provisioner.toml -a swarm-provisioner-staging --image "$IMG" --ha=false
flyctl machines list -a swarm-platform-staging      # exactly ONE machine before any traffic; destroy extras:
# flyctl machine destroy <id> -a swarm-platform-staging --force
flyctl machines list -a swarm-provisioner-staging   # exactly ONE worker
curl -s https://platform-staging.<your-domain>/api/health   # expect {"ok":true,"role":"platform"}
curl -s https://gateway-staging.<your-domain>/health
```
The provisioner exits until step 9 records release-gate evidence for `TENANT_HOST_IMAGE`.

## 9. Qualification and release gates **[$ one performance-2x host for containment ≈ $0.09/hour]**
1. Containment: run `tests/container-containment.test.mts` with `RUN_CONTAINER_TESTS=1` on a Fly performance machine
   running the host image (a Firecracker VM has its own kernel with cgroup v2 domain controllers; this sandbox did not).
2. Network isolation: two tenant apps on separate custom networks; prove no cross-reach and Fly's network attestation.
3. Signed image: cosign verify the host image digest.
4. Provider gates: hosted login and quota evidence from the CLI owner's harness (`agenticwizzard007/cli-provider-qualification`).
5. Record each: `node server/dist/platform/release-gates-cli.js record <image@sha256> <gate> <evidence-uri> <artifact sha256> <reviewer> --approve`, then `verify`.

## 10. First tenant **[$ ≈ $25.40/month running, $1.50 volume]**
Sign up through the platform origin; the provisioner creates the tenant app, network, volume and machine. Confirm the
tenant's `/api/health`, a Bot turn through the tenant, a Composio call through the gateway, and an encrypted backup
in the bucket. Then run the two-tenant isolation test from `docs/tenant-qualification.md`.

## Teardown
```sh
flyctl apps destroy swarm-<tenant-app> -y   # for each tenant app created by staging
flyctl apps destroy swarm-provisioner-staging -y; flyctl apps destroy swarm-gateway-staging -y; flyctl apps destroy swarm-platform-staging -y
flyctl mpg destroy swarm-staging-pg; flyctl storage destroy swarm-staging-backups
```
Staging steady state before tenants: about $119/month (Postgres Basic $38 + one platform performance-2x $66 +
provisioner and gateway about $15); each running staging tenant adds about $27/month. Prices from fly.io/pricing-update
(effective 2026-10-01) and docs.fly.io/mpg/overview as read on 2026-11-11; recheck before committing budget.
