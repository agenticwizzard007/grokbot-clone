# Isolated platform deployment (roles, secrets, networks, migration)

The same application image (repo `Dockerfile`, entrypoint `server/dist/index.js`) runs five roles selected by
`SWARM_ROLE` (`server/src/deployment.ts`). The legacy shared server is `standalone` (`fly.toml`, app `swarm-team`).
The isolated platform is three long-running services plus one tenant host image:

| Role | Manifest | Process | Health | Data it may hold |
|---|---|---|---|---|
| `platform` | `fly.platform.toml` | HTTP on 8787, **one serving machine** (see below) | `GET /api/health` (503 until the directory LISTEN connection is ready) | PostgreSQL metadata, platform signing key, OAuth and messaging credentials, KMS and backup access |
| `provisioner` | `fly.provisioner.toml` | worker, one machine | none (logs, Prometheus metrics from the operations exporter) | PostgreSQL, org-scoped Fly token, KMS, backup storage |
| `composio-gateway` | `fly.composio-gateway.toml` | HTTP on 8787 | `GET /health` | platform-owned Composio project credential, runtime verification key |
| tenant host | `infra/tenant-host/*` (built by `build-release.sh`) | one Fly machine per tenant, created by the provisioner | runtime readiness report | only that tenant's data key and volume |

The platform roles never open application SQLite databases (`server/src/db.ts` refuses); tenants never receive
platform credentials (`validateDeployment` denies the whole list, including `MIGRATION_DATABASE_URL`).

## One platform machine for now

`TunnelBroker` keeps tenant tunnels in a process-local map (`platform/tunnel.ts`) and answers 503 for a tenant whose
tunnel is connected to another replica; LISTEN/NOTIFY broadcasts revocations, not tunnel ownership or traffic. Until
authenticated, owner-aware inter-replica routing exists and is tested, deploy exactly one serving platform machine and
treat Fly's standby behaviour as failover, not capacity. The multi-replica revocation tests remain valid for the
guarantee they cover.

## Networks

- Platform, provisioner and gateway live in one Fly organization network so they reach Managed Postgres privately.
- Every tenant gets its own Fly app and custom private network named from the tenant id (`platform/fly-tenants.ts`);
  the provisioner refuses to continue unless Fly reports that network back. Tenants reach the platform and the gateway
  only over their owned HTTPS origins (`PLATFORM_URL`, `COMPOSIO_GATEWAY_URL`), never over 6PN.
- No public services are configured for tenant machines.

## Schema migration: a separate trusted job

Runtime roles perform no DDL at boot (`SessionNotifications` refuses readiness if required triggers are missing).
Run the directory migration as a one-off job in a dedicated migration app, with a schema-owner connection that the
serving roles never hold. The credential is injected as an ephemeral secret file, read only by that process, and
removed afterwards; it is never passed on a command line or stored in a serving app's config:

```sh
flyctl apps create swarm-migrate-staging --org <staging-org>
printf '%s' "$MIGRATION_DATABASE_URL" | base64 -w0 | flyctl secrets set -a swarm-migrate-staging --stage MIGRATION_DATABASE_URL_B64=-   # value from stdin, not argv
flyctl machine run registry.fly.io/<app>@sha256:<reviewed digest> -a swarm-migrate-staging --rm \
  -e SWARM_ROLE=platform -e NODE_ENV=production \
  --file-secret /run/swarm/migration-url=MIGRATION_DATABASE_URL_B64 \
  -- sh -c 'MIGRATION_DATABASE_URL="$(cat /run/swarm/migration-url)" node server/dist/platform/migrate.js'
flyctl secrets unset -a swarm-migrate-staging MIGRATION_DATABASE_URL_B64
```

`MIGRATION_DATABASE_URL` is accepted only by `platform`, `provisioner` and `composio-gateway` roles, never falls back
to `DATABASE_URL`, and is on the tenant credential denylist (contract from PR #21; the exact flags above must be
re-checked against that PR's `migrate.js` once it lands). Secret file contents are base64 in Fly; verify the decoded
value before the first run.

## Release gates

The provisioner refuses to start, and recovery refuses to activate, unless `release_gates` holds approved evidence
for the exact `TENANT_HOST_IMAGE` digest for all five infrastructure gates (`platform/release-policy.ts`):
`fly-network-isolation`, `nested-container-containment`, `signed-runtime-image`, `provider-hosted-login`,
`provider-quotas`. Record evidence only for archived results, naming the reviewer in the evidence artifact:

```sh
DATABASE_URL=... node server/dist/platform/release-gates-cli.js record <image@sha256:...> nested-container-containment s3://.../containment-2026-11-11.json <sha256 of that artifact> <reviewer> --approve
DATABASE_URL=... node server/dist/platform/release-gates-cli.js verify <image@sha256:...>
```

Every record names the archived artifact by URI **and** its SHA-256, and the reviewer who approved it; the command
rejects credential-bearing URIs and never fetches or verifies the artifact itself. The optional
`tenant-capacity-resize` gate records staging qualification of Fly machine resize, volume extend and guest filesystem
growth for an image; it is never required for ordinary provisioning.

## Secrets as files

Fly mounts a secret as a file with `[[files]] guest_path/secret_name`; the manifests use that for the Ed25519
platform keys so the private key is never in an environment variable or an image. **The secret value must be the
base64 encoding of the PEM** (Fly decodes file secrets); set it from a file or stdin, never on a command line, and
verify the mounted file decodes to the exact PKCS8/SPKI PEM before trusting a boot. Generate the pair offline
(`openssl genpkey -algorithm ed25519`); the private key exists only on the platform role. The file paths the code
reads (`PLATFORM_PRIVATE_KEY_FILE`, `PLATFORM_PUBLIC_KEY_FILE`) are ordinary `[env]` entries.

See `staging-bootstrap.md` for the ordered commands and costs, and `docs/tenant-infrastructure-decisions.md` for
the decisions that must precede them.
