# Staging bootstrap runbook (one isolated environment)

This is a procedure, not an execution receipt. Reconciled against source `8da5c8f` on 2026-11-19; live infrastructure
was not re-verified. Coordinator reports record some staging apps and Managed Postgres creation after the original
2026-11-11 inventory. Verify the current approved inventory before creating anything; existing resources are not
automatically qualified. The historical prices below are estimates, not current quotes or budget approval.

Decisions in [tenant infrastructure decisions](../../docs/tenant-infrastructure-decisions.md) must be made first:
key service, storage, Fly limits, budget and credentials. Use a dedicated staging organization; if only an organization
shared with production is available, stop until the owner explicitly approves the staging boundary and inventory.
Never use production apps, volumes, accounts or secrets for these tests. The initial tenant qualification bootstrap
is also **unresolved**: step 9 explains why this guide cannot yet be executed end to end. No gate bypass is authorized.

## 0. Inputs you must already hold

- Fly organization slug for staging (`FLY_ORG_SLUG`) with a limit increase covering at least 10 apps for staging.
- Owner-controlled platform and gateway HTTPS origins (the manifests use the staging apps' TLS-enabled `.fly.dev` names).
- AWS account with a KMS symmetric key and an IAM principal limited to
  `GenerateDataKey`/`Decrypt` with `EncryptionContext purpose=swarm-tenant-master-v1`.
- Backup bucket: AWS S3 (versioning on, public access blocked). Alternative key services and separate Tigris credentials
  are not implemented in the current deployment path; see step 2.
- Ed25519 platform key pair; a `SESSION_SECRET` of at least 32 random bytes; Composio **project** credential and
  webhook secret; staging Google/Apple OAuth clients; Inkbox staging line. The image workflow installs pinned scan/signing
  tools; operators separately need `cosign` to verify the published candidate before live qualification.
- A reviewed source commit and disposable build capacity outside the shared development workspace volume. Do not reuse
  the shared sandbox disk for nested Docker image caches.

## 0b. AWS: key service and backup bucket (about 10 minutes of the owner's time, then one command)

Only create missing resources from the approved inventory; an existing setup must be inspected instead of recreated.

1. Create the AWS account at https://portal.aws.amazon.com/billing/signup (payment card and phone verification are
   yours; never share them in chat). Turn on MFA for the root user, then create an IAM user with AdministratorAccess
   and an access key for the CLI (`aws configure --profile swarm-admin`). Delete that key when setup is done.
2. From a checkout of main on your Mac:
   ```sh
   AWS_PROFILE=swarm-admin ./infra/platform/aws/setup.sh staging us-east-1 swarm-backups-staging-<random>
   ```
   This deploys `infra/platform/aws/swarm-platform-kms.cfn.yaml`: a symmetric KMS key with rotation whose key policy
   allows the platform identity only `GenerateDataKey`/`Decrypt`/`DescribeKey` with
   `kms:EncryptionContext:purpose = swarm-tenant-master-v1`; a private, versioned, TLS-only bucket with lifecycle
   rules for aborted uploads and old versions; an IAM user limited to those KMS actions and to the
   `swarm-backups/` prefix. It writes `~/.swarm-staging-aws.env` (mode 0600) with `TENANT_KMS_KEY_ID`,
   `AWS_REGION`, `BACKUP_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
3. Verify the real key with the platform's exact envelope contract (same tenant decrypts, another tenant is refused):
   ```sh
   AWS_PROFILE=swarm-admin node infra/platform/aws/verify-kms.mjs "$(grep TENANT_KMS_KEY_ID ~/.swarm-staging-aws.env | cut -d= -f2)"
   ```
4. Import `~/.swarm-staging-aws.env` into the platform, provisioner and gateway apps in step 4 below, then shred it.
Cost: KMS $1/month per key plus $0.03 per 10,000 requests; S3 cents per GB.

## 1. Postgres **[$ Basic $38/month + $0.28/GB storage]**

```sh
flyctl mpg create --org <staging-org> --name swarm-staging-pg --region iad --plan basic
```
Create two roles: a schema owner (for `MIGRATION_DATABASE_URL`) and an application role (for `DATABASE_URL`).
Use the direct or **session-pooled** endpoint for `DATABASE_URL`: the platform keeps one `LISTEN` connection per
replica and transaction pooling breaks it.

## 2. Object storage **[$ AWS S3: cents per GB at staging scale]**
Created by step 0b together with the key: the same AWS principal is authorized for both KMS and the bucket, which is
what the code requires (`KMSClient({})` and `S3Client({})` share the default credential chain). **Tigris is not usable yet:** replacing the AWS keys
with Tigris keys would send Tigris credentials to KMS; offering Tigris requires separately configured S3 credentials in
`platform/backup-storage.ts` first (decision 3 in `docs/tenant-infrastructure-decisions.md`).

## 3. Apps **[$ platform 1 × performance-2x = $66/month; provisioner shared-cpu-2x 1 GB ≈ $7.40; gateway ≈ $7.40]**

```sh
flyctl apps create swarm-platform-staging --org <staging-org>
flyctl apps create swarm-provisioner-staging --org <staging-org>
flyctl apps create swarm-gateway-staging --org <staging-org>
flyctl mpg attach swarm-staging-pg --app swarm-platform-staging
```
Staging uses the apps' own `https://<app>.fly.dev` origins (TLS provided by Fly), already set in the manifests; production
replaces them with owned domains via `flyctl certs add`. `PLATFORM_URL`, `APP_URL` and `SERVER_URL` must agree on the
platform origin; `COMPOSIO_GATEWAY_URL` names the gateway origin. Database attachment is connectivity setup, not proof
that the injected URL has the restricted application role or session semantics required by step 1.

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
shred -u /secure/platform.env /secure/provisioner.env /secure/gateway.env
```
`APP_URL` and `SERVER_URL` are not secrets: they are set in `fly.platform.toml` `[env]` in step 3. After the first
deploy, verify on each machine that the mounted key files decode to the exact PEM by comparing hashes, without
printing them. `COMPOSIO_API_KEY` is needed by both platform and gateway; the webhook secret is gateway-only. Tenants
receive neither. Defer `TENANT_HOST_IMAGE` until step 7 supplies the actual published digest; a placeholder cannot boot.

## 5. Build the platform-role image once and pin its digest

```sh
flyctl deploy -c infra/platform/fly.platform.toml -a swarm-platform-staging --remote-only --build-only --push --image-label platform-<git-sha>
flyctl image show -a swarm-platform-staging        # record the pushed digest and verify it against this build's output
```
Use that one reviewed digest for platform, gateway, provisioner and the migration job. The tenant-image pipeline in
step 7 builds its own APP/RUNNER/MCP artifact with locked base inputs; do not substitute this role image for it.

## 6. Schema migration (dedicated trusted job; see README.md)
Create `swarm-migrate-staging`, import the base64 schema-owner URL with `flyctl secrets import --stage` from a protected
file, run the job with `--file-secret` so the credential is read only by that process, verify the mounted file by hash
without printing it, then unset the secret. Never pass it with `-e` or on argv, and never store it on a serving role.

## 7. Tenant host image **[$ build machine while running]**

The component definitions are implemented: [HostBase.Dockerfile](../tenant-host/HostBase.Dockerfile) and
[DesktopBase.Dockerfile](../tenant-host/DesktopBase.Dockerfile), plus Desktop.Dockerfile for the checked-out companion.
The [release guide](../tenant-host/README.md) documents locked Node/Docker/Trixie/Chrome inputs, the desktop-only
seccomp profile and the minimal FFmpeg build from signed, checksum-pinned source with recorded build provenance.
This code is not a published image or a scan/containment pass.

Use the [Tenant host images workflow](../../.github/workflows/tenant-images.yml):

1. Dispatch with the exact reviewed 40-character `source_sha` and `dry_run=true` on suitable disposable build capacity.
   Dry mode builds and scans without signing/registry credentials; failures keep the job failing. Its host cannot boot
   workloads and cannot be used for release gates. No image build should consume the shared development disk.
2. Resolve **every HIGH/CRITICAL finding**, including unfixed findings, and complete the required production-policy
   image smoke. The current workflow has no vulnerability exceptions or ignore-unfixed path. Historical scan reports
   are not current scan clearance; this revision neither refreshes those reports nor approves publication.
3. Only after publication authorization and required inputs exist, dispatch from main with `dry_run=false`, a reviewed
   `source_sha` on main, and an existing `registry_app`. Configure the protected `tenant-image-release` environment as
   the release guide specifies: registry push token, cosign signing key/password and the public platform verification
   key. Never supply the platform private key, user credentials or database/AWS credentials to the build.
4. The workflow builds, scans and signs component digests, calls `build-release.sh` with `HOST_IMAGE_TAG`, then scans,
   pushes, signs and verifies the assembled host. Capture its `host_image_digest` output and archive `reports/images.json`,
   `release.json`, scans and smoke results. The image report binds the host, component/base digests, source commit,
   desktop profile hash and FFmpeg provenance. APP/RUNNER/MCP may share a digest; the embedded `MCP_IMAGE.tar` remains required.
5. Verify the published signature and provenance before importing its exact `registry.fly.io/<app>@sha256:...` reference
   as `TENANT_HOST_IMAGE` into the provisioner (protected file and `secrets import --stage`, as in step 4). Keep the
   provisioner stopped until step 9 completes. A signed image alone is not permission to create tenants.

## 8. Deploy platform and gateway only

```sh
role_image='registry.fly.io/swarm-platform-staging@sha256:<digest from step 5>'
flyctl deploy -c infra/platform/fly.platform.toml -a swarm-platform-staging --image "$role_image" --ha=false
flyctl deploy -c infra/platform/fly.composio-gateway.toml -a swarm-gateway-staging --image "$role_image" --ha=false
flyctl machines list -a swarm-platform-staging      # exactly ONE machine before any traffic; destroy extras:
# flyctl machine destroy <id> -a swarm-platform-staging --force
curl --fail --silent --show-error https://swarm-platform-staging.fly.dev/api/health   # expect {"ok":true,"role":"platform"}
curl --fail --silent --show-error https://swarm-gateway-staging.fly.dev/health
```
The process-local TunnelBroker map requires exactly one serving platform machine; a second serving process is not
safe failover. Health responses attest service readiness only. Do not deploy the provisioner yet: it exits until
approved exact-image gate evidence exists, and no initial qualification bootstrap is implemented or approved.

## 9. Qualification and release gates **[$ one performance-2x host for containment ≈ $0.09/hour]**

**Stop before any step needing tenant inventory.** `startProvisioner` invokes `assertQualifiedImage` before starting
workers. It requires `fly-network-isolation`, `nested-container-containment`, `signed-runtime-image`,
`provider-hosted-login` and `provider-quotas` for the exact host image. Yet [provider qualification](../../docs/provider-qualification.md)
requires two already provisioned isolated tenants. The coordinator confirmed on 2026-11-19 that no approved
inventory-limited bootstrap exists. The owner must choose a bounded qualification contract or redesign; review and
implementation must follow before the initial tenants can be created. Never seed passing gate rows, disable checks
or insert tenant inventory directly to make this sequence proceed. Step 10 is conditional, not a bootstrap workaround.

The eventual evidence requirements are:

1. Containment: the [real-Fly qualification job](../tenant-host/qualification/README.md) uses the exact signed host digest
   and its published images.json in a disposable, credential-free, non-tenant app. It renders the bounded `iad`
   performance-2x/8 GiB Machine, verifies actual kernel/cgroup controls and installed runtime bytes, exercises desktop
   sandbox/firewall probes, and emits evidence only after validation. Add extra-memory/build/storage charges to the
   quoted compute baseline. Its independent preparation/execution does not create the tenant inventory needed by
   the provider harness, and its synthetic app route does not qualify real application auth.
2. Network isolation: two approved tenant apps on separate custom networks; prove no cross-reach and verify Fly's
   reported network/volume identities. A single-host containment job cannot provide this result.
3. Signed image: verify the candidate's cosign signature and archive the component/source provenance and scan evidence.
4. Provider gates: run the merged [provider harness](../../scripts/qualify-providers.mjs) with its documented real test
   identities, two isolated tenants, subscription support, upstream budgets/read-only scopes and independent witnesses.
   Harness simulations and its operator-supplied image label are not remote image attestation or blanket release approval.
5. For actual archived results only, an authorized operator records the image, gate, evidence URI, artifact SHA-256 and
   reviewer using `node server/dist/platform/release-gates-cli.js record ...`. Recording without `--approve` is unapproved
   (and withdraws any previous approval of that gate/image). After independent review, an authorized reviewer may
   record with `--approve`; `verify <image@sha256:...>` must then pass for all five gates with complete provenance.
   The CLI does not fetch or substantiate the artifact. Never approve placeholders to break the bootstrap dependency.

## 10. Ordinary provisioning after qualification **[$ ≈ $25.40/month running, $1.50 volume]**

Proceed only after the bootstrap contract is resolved and all five actual evidence gates for the candidate pass
`release-gates-cli verify`. Deploy the provisioner using the same reviewed role-image digest as step 8:

```sh
flyctl deploy -c infra/platform/fly.provisioner.toml -a swarm-provisioner-staging --image "$role_image" --ha=false
flyctl machines list -a swarm-provisioner-staging   # exactly ONE worker; review/destroy extras before use
```

Sign up through the approved platform origin; the provisioner creates the tenant app, network, volume and machine.
Confirm tenant health through the authenticated platform route, the real companion welcome/readiness, a Bot turn,
a Composio call through the gateway and an encrypted backup in the bucket. These checks supplement the already required
two-tenant evidence; they do not replace it. Follow [bounded qualification](../../docs/tenant-qualification.md) for the
remaining recovery, revocation, migration, deletion and capacity tests.

The initial guest remains 4096 MiB. One app + desktop + runner has 3840 MiB of container ceilings, leaving only 256 MiB
before host overhead; two runners total 4608 MiB. The agreed staging target is 8192 MiB through
[reviewed capacity maintenance](../../docs/tenant-capacity-operations.md) after boot and trusted fresh usage, with
exact-image `tenant-capacity-resize` evidence. That optional gate is not required for ordinary provisioning but is
required for resizing. There is no initial-size override or permission to bypass fencing; automatic scheduling is not
implemented. The trusted collector is a separate review-only handoff at this revision, not a merged/enabled prerequisite
to assume. Verify the approved collection path before planning growth or increasing concurrent workload.

## Teardown

Reconcile actual resources with this run's creation inventory and approved retention first. Destroy only reviewed
disposable IDs/apps created for this run; pre-existing apps, volumes and databases need their own teardown decision.
Use the containment job's ID-bound cleanup procedure for its Machine/app. Tenant cleanup must verify actual machine,
volume and network deletion, not merely an accepted stop request. Retain required evidence and backup versions under
the approved policy before removing dedicated platform/gateway/provisioner/migration apps or Managed Postgres.
This path uses AWS S3, not a Fly storage bucket: S3 versions/multipart data and the KMS key require their own reviewed
retention/deletion procedure. Do not replace that procedure with `flyctl storage destroy` or immediate key deletion.

Staging steady state before tenants: about $119/month (Postgres Basic $38 + one platform performance-2x $66 +
provisioner and gateway about $15); each running staging tenant adds about $27/month. Prices from fly.io/pricing-update
(effective 2026-10-01) and docs.fly.io/mpg/overview as read on 2026-11-11; recheck before committing budget.
