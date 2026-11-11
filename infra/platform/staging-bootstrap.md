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

## 2. Object storage **[$ Tigris: pay per GB stored and egress; cents at staging scale]**
```sh
flyctl storage create --org <staging-org> --name swarm-staging-backups      # Tigris, S3-compatible
```
Export the returned endpoint as `AWS_ENDPOINT_URL_S3` and the keys as AWS credentials on the platform and
provisioner apps; enable versioning; set `BACKUP_BUCKET`.

## 3. Apps **[$ platform 2 × performance-2x = $132/month; provisioner shared-cpu-2x 1 GB ≈ $7.40; gateway ≈ $7.40]**
```sh
flyctl apps create swarm-platform-staging --org <staging-org>
flyctl apps create swarm-provisioner-staging --org <staging-org>
flyctl apps create swarm-gateway-staging --org <staging-org>
flyctl certs add -a swarm-platform-staging platform-staging.<your-domain>
flyctl certs add -a swarm-gateway-staging gateway-staging.<your-domain>
```
Edit `PLATFORM_URL` and `COMPOSIO_GATEWAY_URL` in the three manifests to those origins.

## 4. Secrets (names as the manifests list them)
```sh
flyctl secrets set -a swarm-platform-staging SESSION_SECRET=... DATABASE_URL=... TENANT_KMS_KEY_ID=... \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... BACKUP_BUCKET=... COMPOSIO_API_KEY=... \
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... INKBOX_API_KEY=... INKBOX_ADMIN_API_KEY=... INKBOX_IDENTITY_ID=... INKBOX_SIGNING_KEY=... INKBOX_HANDLE=... \
  PLATFORM_PRIVATE_KEY="$(cat platform-private.pem)" PLATFORM_PUBLIC_KEY="$(cat platform-public.pem)"
flyctl secrets set -a swarm-provisioner-staging SESSION_SECRET=... DATABASE_URL=... FLY_API_TOKEN=<org-scoped> FLY_ORG_SLUG=<staging-org> \
  TENANT_KMS_KEY_ID=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... BACKUP_BUCKET=... TENANT_HOST_IMAGE=<set in step 7>
flyctl secrets set -a swarm-gateway-staging DATABASE_URL=... TENANT_KMS_KEY_ID=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  COMPOSIO_API_KEY=... COMPOSIO_WEBHOOK_SECRET=... PLATFORM_PUBLIC_KEY="$(cat platform-public.pem)"
```

## 5. Build the application image once and pin its digest
```sh
flyctl deploy -c infra/platform/fly.platform.toml -a swarm-platform-staging --remote-only --build-only --push --image-label platform-<git-sha>
flyctl image show -a swarm-platform-staging        # note the @sha256 digest for APP_IMAGE / RUNNER_IMAGE / MCP_IMAGE
```

## 6. Schema migration (separate trusted job; see README.md)
```sh
flyctl machine run registry.fly.io/swarm-platform-staging@sha256:<digest> -a swarm-platform-staging --rm \
  -e SWARM_ROLE=platform -e NODE_ENV=production -e MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" -- node server/dist/platform/migrate.js
```

## 7. Tenant host image **[$ build machine while running]**
Build `HOST_BASE` and `DESKTOP_BASE` (definitions still to be authored; see `docs/tenant-capacity-model.md` and the
owner notes), then run `infra/tenant-host/build-release.sh` with digest-pinned `APP_IMAGE RUNNER_IMAGE MCP_IMAGE
DESKTOP_IMAGE HOST_BASE`, `IMAGE_VERIFICATION_KEY` (cosign) and `PLATFORM_PUBLIC_KEY_FILE`; push; set
`TENANT_HOST_IMAGE` on the provisioner to the resulting `@sha256` digest.

## 8. Deploy the roles
```sh
flyctl deploy -c infra/platform/fly.platform.toml -a swarm-platform-staging --remote-only
flyctl deploy -c infra/platform/fly.composio-gateway.toml -a swarm-gateway-staging --remote-only
flyctl deploy -c infra/platform/fly.provisioner.toml -a swarm-provisioner-staging --remote-only
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
5. Record each: `node server/dist/platform/release-gates-cli.js record <image@sha256> <gate> <evidence-uri> --approve`, then `verify`.

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
Staging steady state before tenants: about $185/month (Postgres Basic $38 + platform $132 + provisioner and gateway
$15); each running staging tenant adds about $27/month.
