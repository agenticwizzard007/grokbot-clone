# Isolated platform deployment (roles, secrets, networks, migration)

The same application image (repo `Dockerfile`, entrypoint `server/dist/index.js`) runs five roles selected by
`SWARM_ROLE` (`server/src/deployment.ts`). The legacy shared server is `standalone` (`fly.toml`, app `swarm-team`).
The isolated platform is three long-running services plus one tenant host image:

| Role | Manifest | Process | Health | Data it may hold |
|---|---|---|---|---|
| `platform` | `fly.platform.toml` | HTTP on 8787, two or more replicas | `GET /api/health` (503 until the directory LISTEN connection is ready) | PostgreSQL metadata, platform signing key, OAuth and messaging credentials, KMS and backup access |
| `provisioner` | `fly.provisioner.toml` | worker, one machine | none (logs, Prometheus metrics from the operations exporter) | PostgreSQL, org-scoped Fly token, KMS, backup storage |
| `composio-gateway` | `fly.composio-gateway.toml` | HTTP on 8787 | `GET /health` | platform-owned Composio project credential, runtime verification key |
| tenant host | `infra/tenant-host/*` (built by `build-release.sh`) | one Fly machine per tenant, created by the provisioner | runtime readiness report | only that tenant's data key and volume |

The platform roles never open application SQLite databases (`server/src/db.ts` refuses); tenants never receive
platform credentials (`validateDeployment` denies the whole list, including `MIGRATION_DATABASE_URL`).

## Networks

- Platform, provisioner and gateway live in one Fly organization network so they reach Managed Postgres privately.
- Every tenant gets its own Fly app and custom private network named from the tenant id (`platform/fly-tenants.ts`);
  the provisioner refuses to continue unless Fly reports that network back. Tenants reach the platform and the gateway
  only over their owned HTTPS origins (`PLATFORM_URL`, `COMPOSIO_GATEWAY_URL`), never over 6PN.
- No public services are configured for tenant machines.

## Schema migration: a separate trusted job

Runtime roles perform no DDL at boot (`SessionNotifications` refuses readiness if required triggers are missing).
Run the directory migration as a one-off machine before deploying new platform code, with a dedicated
schema-owner connection that the runtime roles never hold:

```sh
flyctl machine run <image@sha256:...> -a swarm-platform-staging --rm \
  -e SWARM_ROLE=platform -e NODE_ENV=production \
  -e MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" \
  -- node server/dist/platform/migrate.js
```

`MIGRATION_DATABASE_URL` is accepted only by `platform`, `provisioner` and `composio-gateway` roles, never falls
back to `DATABASE_URL`, and is on the tenant credential denylist (contract published by the isolation owner with
PR #21; wire the exact command once that PR lands).

## Release gates

The provisioner refuses to start, and recovery refuses to activate, unless `release_gates` holds approved evidence
for the exact `TENANT_HOST_IMAGE` digest for all five infrastructure gates (`platform/release-policy.ts`):
`fly-network-isolation`, `nested-container-containment`, `signed-runtime-image`, `provider-hosted-login`,
`provider-quotas`. Record evidence only for archived results, naming the reviewer in the evidence artifact:

```sh
DATABASE_URL=... node server/dist/platform/release-gates-cli.js record <image@sha256:...> nested-container-containment s3://.../containment-2026-11-11.json --approve
DATABASE_URL=... node server/dist/platform/release-gates-cli.js verify <image@sha256:...>
```

The optional `tenant-capacity-resize` gate records staging qualification of Fly machine resize, volume extend and
guest filesystem growth for an image; it is never required for ordinary provisioning.

## Secrets as files

Fly mounts a secret as a file with `[[files]] guest_path/secret_name`; the manifests use that for the Ed25519
platform keys so the private key is never in an environment variable or an image. Generate the pair offline
(`openssl genpkey -algorithm ed25519`), keep the private key only on the platform role.

See `staging-bootstrap.md` for the ordered commands and costs, and `docs/tenant-infrastructure-decisions.md` for
the decisions that must precede them.
