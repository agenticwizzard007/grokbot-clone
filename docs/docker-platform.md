# Docker platform stack

Run the local platform from the repository root:

```sh
./scripts/platform-local-up.sh
```

Prerequisites: Git, Bash, OpenSSL, Node 22.6 or later, Docker Engine with its default seccomp policy, Docker Compose v2.20 or later, and Buildx 0.17 or later. Docker Desktop includes the Docker components. Allow roughly 10 GB for the first build. Build-time downloads require Internet access. Application services and emulators use an internal Docker network without Internet egress. Only the TLS proxy also joins an ingress bridge to publish the loopback ports. No cloud account or production credential is needed.

The script builds the repository Dockerfile, generates offline keys, starts PostgreSQL 16, local KMS and MinIO, initializes private versioned storage, runs the directory migration, waits for service health, and prints `https://localhost:8443`. Gateway health is at `https://localhost:8444/health`. All host ports bind only to loopback. Use an SSH tunnel for a remote single Docker host.

This is a local platform infrastructure stack. **Tenant provisioning is held**, OAuth sign-in is not configured, and connected-app operations are unavailable. It does not demonstrate a working customer tenant or qualify tenant isolation. The gateway constructs with a generated offline placeholder and cannot reach external providers. No real Fly, AWS, Composio, Inkbox, Google or OpenRouter calls are needed or enabled by this setup.

## Configuration and keys

The first run creates `$HOME/.local/share/swarm-platform/local.env` with random local credentials and `$HOME/.local/share/swarm-platform/keys` with the Ed25519 PKCS8 private key, SPKI public key and a random seeded symmetric KMS key. The public key is mounted into platform and gateway; the private key is mounted only into platform. MinIO has a separate random server-side encryption key. The script never prints secret values or places them into the image build context.

Files have mode 0600. Directories have mode 0700 because directory traversal requires execute permission; a 0600 directory cannot be used. `scripts/platform-keys.sh /absolute/path/outside/git` can generate keys independently, preserves a matching existing pair, and refuses a partial pair or keys inside this checkout. Back up local key material together with local volumes if keeping this environment. Do not rotate a seed underneath existing encrypted data.

Every Compose input is documented in [the env template](../deploy/docker/.env.example). To customize, copy it into a protected file outside git, fill all blank credentials with local random values, set an absolute `PLATFORM_KEYS_DIR`, and run:

```sh
PLATFORM_ENV_FILE=/secure/swarm-local/local.env ./scripts/platform-local-up.sh
```

The env file is authoritative over matching shell variables. Owner/runtime database passwords must be URL-safe, such as 64 hexadecimal characters from `openssl rand -hex 32`. The script does not rewrite existing files. It supplies the actual checkout commit as `SWARM_BUILD_REVISION` to the Docker build manifest. Local builds from modified files are development builds, not release qualification artifacts.

MinIO and its client build from pinned upstream commits in `deploy/docker/Dockerfile.minio` because public upstream image pulls may require credentials. They are local emulators, licensed by their upstream projects. The application roles all use the same repository image; the emulator images are not tenant host images.

## Local HTTPS

Caddy issues a local certificate without contacting a public certificate authority. Its local image removes the upstream binary's low-port file capability because ports 8443/8444 do not need it; the container keeps an empty capability bounding set. Export this stack's CA and explicitly trust it in your development browser or pass it to curl:

```sh
export SWARM_BUILD_REVISION="$(git rev-parse HEAD)"
docker compose --env-file "$HOME/.local/share/swarm-platform/local.env" \
  -f deploy/docker/compose.platform.yml exec -T https \
  cat /data/caddy/pki/authorities/local/root.crt > /tmp/swarm-local-ca.crt
curl --cacert /tmp/swarm-local-ca.crt https://localhost:8443/api/health
```

Use your operating system's certificate trust manager for the exported CA. Do not disable certificate verification or alter the platform's HTTPS/session-cookie requirements. Caddy forwards to platform/gateway over the private local bridge. `COMPOSIO_GATEWAY_URL` inside platform is the internal callback destination, not a public browser origin. No Google OAuth client or live authentication path is configured.

## Migration, storage and health

PostgreSQL initializes three logins: the bootstrap administrator, `directory_owner` and `app_runtime`. Only the one-shot migrate job receives `MIGRATION_DATABASE_URL` as the schema owner. Runtime services receive `DATABASE_URL` as a non-superuser with DML and LISTEN privileges, no schema CREATE permission and no owner-role membership. Default grants cover future migrations. Initialization scripts run only on a new PostgreSQL volume; editing the env file does not rotate existing database passwords.

The migration command is exactly `node server/dist/platform/migrate.js`. Dependencies require its successful completion before starting application roles. Runtime services never migrate at boot. Re-run the local-up script to build a new image, apply migrations and reconcile services. Initialization and migration jobs have healthchecks and successful exit status; long-running services must report healthy.

MinIO initialization creates a private, versioned `swarm-backups` bucket and an application user restricted to `swarm-backups/`. Root credentials stay in MinIO and its init job. Application S3 credentials are separate from the AWS credential chain used for local KMS. Encrypted backup parts retain their existing SSE requirement. Local retention expires current objects after eight days and noncurrent versions after seven days; application cleanup removes versions, delete markers and pending multipart uploads. Production requires the provider lifecycle and incomplete-upload policy described in the isolation runbook.

The provisioner wrapper has a loopback `/health` endpoint on port 8788 that checks database/schema availability and reports `provisioning: "held"`. This is service liveness, not tenant readiness. `SWARM_LOCAL_PROVISIONER_HOLD=1` requires `SWARM_ALLOW_LOCAL_CLOUD=1`, never starts lifecycle workers and never inserts release-gate evidence. Its default outside Compose is off. With hold off, it calls the existing provisioner and fails startup if credentials, the driver, pinned image or release gates are missing. No exception to qualification is introduced.

`TENANT_DRIVER` is passed through unchanged for the separate Docker tenant driver package. **No service mounts the Docker socket.** Selecting `TENANT_DRIVER=docker` alone does not grant Docker access or qualify tenant execution. A reviewed deployment using that driver must implement its documented supervisor/socket boundary and preserve read-only roots, capability drops, seccomp, cgroups and firewall policy. MT-A does not depend on that driver or supply placeholder release evidence.

Services have separate named data volumes. The local platform services have read-only roots, no-new-privileges, default seccomp and dropped capabilities. Platform roles and KMS run with the host key owner's UID/GID so 0600 bind-mounted secrets remain readable without DAC override capabilities. A one-shot job with only CHOWN initializes the KMS volume directory and receives no secrets. Do not change LOCAL_UID/LOCAL_GID under an existing volume. PostgreSQL retains its image's initialization capabilities to set data-directory ownership. The standalone deployment retains its existing runtime behavior.

## Smoke test and cleanup

```sh
node tests/docker-platform-smoke.mjs
node --import tsx --test tests/cloud-endpoints.test.mts tests/docker-platform.test.mts
```

The smoke uses an independent Compose project, random credentials, temporary key files and temporary host ports. It builds and starts the stack, checks every service or job, verifies HTTPS using the generated CA, verifies the schema owner and runtime privilege boundary, confirms no release gates were created, exercises tenant-bound KMS encryption, and checks prefix-scoped versioned S3 put/get/delete. It tears down its own containers, network and volumes even on failure. Without a usable Docker daemon or Compose plugin it prints `NOT RUN` and exits 77. A skipped smoke is not a pass.

For the persistent development stack, stop containers without deleting data:

```sh
export SWARM_BUILD_REVISION="$(git rev-parse HEAD)"
docker compose --env-file "$HOME/.local/share/swarm-platform/local.env" \
  -f deploy/docker/compose.platform.yml down
```

Add `--volumes` only when intentionally deleting this disposable environment. That removes PostgreSQL, KMS, MinIO and the local CA; protect required local data first. Retain the env and keys if retaining volumes. Never point this stack at customer data.

## Standalone self-host and QA

`deploy/docker/compose.standalone.yml` starts the existing `SWARM_ROLE=standalone` image with `/data` on its own named volume and `/api/health` checks. It does not modify `fly.toml`, authentication, sessions or other shared-server behavior. Use a separate protected env file containing `SESSION_SECRET` and the normal self-host settings from the repository env example. Do not use the platform credential file. Production mode continues to refuse `DEV_LOGIN=1`.

```sh
export SWARM_BUILD_REVISION="$(git rev-parse HEAD)"
export STANDALONE_ENV_FILE=/secure/swarm-standalone.env
# Set a stable random SESSION_SECRET in the protected file first.
docker compose -f deploy/docker/compose.standalone.yml up -d --build --wait
```

The default URL is `http://localhost:8787`. Add your own HTTPS ingress for access beyond localhost. This shared-server mode is not evidence for per-tenant isolation.

## Same role images on Fly or another production host

| Docker role | Existing Fly manifest | Production changes |
| --- | --- | --- |
| platform | `infra/platform/fly.platform.toml` | Owned HTTPS origin, stable session secret, restricted direct/session-pooled PostgreSQL, file keys, real OAuth configuration |
| provisioner | `infra/platform/fly.provisioner.toml` | Real driver credentials, pinned qualified tenant host image and all release gates; local hold absent |
| composio-gateway | `infra/platform/fly.composio-gateway.toml` | Separate platform Composio project/webhook secret, public verification key and owned HTTPS origin |
| migrate | dedicated one-shot migration job | Schema-owner connection delivered only to the job; same role-image digest |

Build, review and pin one role image digest from the repository Dockerfile, then use it for all four roles. Existing Fly manifests already select the roles; they run the normal entrypoint without the local Compose wrapper. Production still runs exactly one serving platform and one provisioner until the separate scaling work is qualified. Tenant host images use their own signed and qualified pipeline.

Do not deploy the local Compose file as production configuration. Replace PostgreSQL/emulator connections, local Caddy trust, local credentials and the no-egress development network with the reviewed production services and network policy. Keep cloud credentials out of tenants and keep migration credentials out of serving roles. This package does not enable customer workload admission or change any release gate.

The endpoint configuration supported by the same application image is:

| Variables | Purpose |
| --- | --- |
| `TENANT_KMS_ENDPOINT`, `TENANT_KMS_REGION` | Explicit KMS emulator endpoint and region; otherwise SDK region and credential chain |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION` | Explicit S3-compatible service endpoint and region |
| `BACKUP_S3_FORCE_PATH_STYLE` | `true`/`1` or `false`/`0`; omitted preserves SDK behavior |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, optional `BACKUP_S3_SESSION_TOKEN` | Separate S3 credentials; a partial pair is refused; KMS never reads these values |
| `SWARM_ALLOW_LOCAL_CLOUD=1` | Explicit permission for endpoint/region/path-style overrides when `NODE_ENV=production`; default off in application code |

AWS production normally omits every override, uses `AWS_REGION` and the SDK credential chain, and leaves `SWARM_ALLOW_LOCAL_CLOUD` unset. SDK implicit `AWS_ENDPOINT_URL` and shared-config endpoints are ignored to prevent bypassing the override guard. A reviewed Tigris or other S3 endpoint needs the explicit allow flag in production, separate S3 credentials and provider qualification of versioning/multipart/deletion semantics. The flag does not permit any other security exception. See [owner steps](multitenant-owner-steps.md#mt-a-dockerized-platform-stack) for inputs that remain external.
