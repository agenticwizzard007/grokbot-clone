# Docker tenant driver (MT-B)

Use `TENANT_DRIVER=docker` for disposable local development and self-hosted staging experiments on a dedicated Linux Docker host. Fly remains the default. This driver is not a claim of production isolation or a replacement for the approved [master spec](tenant-isolation-master-spec.md).

## Configuration

The provisioner selects the driver. The standalone entrypoint, sessions and user behavior are unchanged. No Fly token or organization is needed for the Docker driver.

```sh
SWARM_ROLE=provisioner
TENANT_DRIVER=docker
DOCKER_HOST=unix:///var/run/docker.sock
TENANT_HOST_IMAGE=sha256:<64-character local image config digest>
TENANT_REGION=local
```

`TENANT_HOST_IMAGE` must be an exact, already loaded digest, either a local image config digest or `repository@sha256:...`. The driver never pulls an image. `DOCKER_HOST` only accepts an absolute Unix socket URL, never a remote TCP endpoint. Socket access belongs exclusively to the trusted provisioner and is equivalent to Docker host administration. Never mount it into a tenant, platform-facing workload or user container.

With `NODE_ENV=production`, Docker selection is refused unless the operator explicitly sets `SWARM_ALLOW_DOCKER_TENANTS=1`. That flag acknowledges the shared-kernel risk and permits the Docker path; it does not qualify an image, supply Fly evidence, change the Fly gate verifier or override host containment checks. `assertQualifiedImage` and the Fly gate names are unchanged. A local Docker acceptance never reads or writes passing Fly gate rows. Keep production on Fly unless the owner accepts these differences and completes a separate review.

The directory, envelope, backup and host-readiness requirements still apply. This driver alone does not replace the missing KMS, S3 or other platform inputs. Tests use a fake Unix-socket Engine and, for the existing platform suite, disposable local PostgreSQL.

## Boundary and lifecycle

Each tenant has the same hashed app, network and volume names as Fly. Labels contain the hashed tenant name. A container's environment includes only its tenant, volume, generation, optional platform/gateway URLs and usage-collection flag, plus a restricted set of image defaults. It never inherits provisioner credentials.

Each tenant gets an internal bridge with IPv6, inter-container communication and masquerading disabled, its own local named volume at `/data`, and one container. No ports are published. The root is read-only, capabilities are dropped, no-new-privileges is set, default seccomp stays enabled, and PID, memory, swap and CPU limits are required. CPU and memory come from `TenantGuest` in `TenantCapacity`; Docker CPU quotas do not reserve dedicated physical cores even when the requested CPU class is `performance`. Missing Engine enforcement stops creation. Writable `/run` and `/tmp` use bounded private tmpfs mounts.

The driver inspects the network after creation and again before lifecycle operations. A wrong owner, wrong network policy, extra network attachment, unexpected container, foreign volume or ambiguous writer stops the operation. Deletion inventories the complete tenant namespace before effects and verifies removals. Unknown responses are surfaced for lifecycle reconciliation, not silently replayed. The Docker administrator remains trusted and must not mutate tenant resources out of band; Docker provides no atomic compare-and-delete operation for local volume names.

Suspend stops the container, rather than pausing stale credentials and authorization timers. Wake writes a fresh bootstrap to the stopped tenant's own volume through the Engine archive API. A fixed image entrypoint wrapper moves it to `/run/swarm-host/bootstrap`, removes the staged copy and supplies the immutable container ID as `FLY_MACHINE_ID` for the existing host protocol. The wrapper then executes the pinned image's original entrypoint and command. Bootstrap values never appear in Docker configuration, labels or logs. The data volume persists across stop/start and explicit container replacement.

The environment worker explicitly accepts verified local Docker storage only under the Docker policy; Fly continues to require encrypted volumes. Restore/image replacement can create deterministic operation-owned volumes, remove stopped containers, install a replacement and retire detached volumes. Operation IDs must be in the admitted inventory. Local volumes report `encrypted:false` and `quota_enforced:false`. Their `size_gb` label is a requested size hint only. Capacity inspection returns the enforced CPU/memory settings and preserves the requested disk budget across replacements with `volumeQuotaEnforced:false`; it is not a disk measurement. The driver refuses volume growth because it cannot enforce a new disk size. Migration destination checks requiring encrypted volumes remain closed; no Docker run can falsely attest Fly encryption. Production migration and disk resizing need an actual encrypted, quota-capable storage adapter before they can use Docker.

## Security differences and current limits

Docker containers share the host kernel. They do not provide Fly microVM boundaries. A host kernel or Docker daemon compromise can expose every local tenant. The Docker host administrator can inspect volumes and containers. Local named volumes are not provider-encrypted volumes and do not enforce per-tenant disk quotas. Operators must budget for host-wide disk exhaustion separately.

Networks have **no external egress allowance**. No shared egress bridge is attached. An internal Docker bridge blocks routed cross-network traffic, but does not by itself isolate host-local services bound to the bridge address. Keep host-local services inaccessible through host firewall policy and qualify that boundary independently. This implementation does not install or relax host firewall rules. Adding controlled HTTPS egress requires a separately reviewed proxy/firewall adapter; manually attaching a shared bridge is rejected on inspection.

The current `infra/tenant-host/entrypoint.sh` is built for a Fly microVM: it starts a nested Docker daemon, configures firewall rules and runs kernel preflight checks. It has not been qualified under this restricted Docker profile. Do not use `--privileged`, mount the host socket, grant extra capabilities, disable seccomp, make the root writable or bypass readiness to make it boot. A compatible pinned host image and reviewed egress are prerequisites for full platform readiness. A BusyBox probe is evidence only for the boundaries it actually exercises, never for runtime feature parity, encrypted storage, backup recovery or Fly release gates.

## Tests

```sh
node --import tsx --test tests/docker-tenants.test.mts tests/docker-tenant-policy.test.mts
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/mt_b_test npm run test:isolation
```

For a real, disposable Docker host with default seccomp and memory, swap, CPU and PID controls:

```sh
docker build -f tests/fixtures/docker-tenant.Dockerfile -t mt-b-standin tests/fixtures
DOCKER_E2E_IMAGE=$(docker image inspect --format '{{.Id}}' mt-b-standin) \
  node tests/docker-tenants-e2e.mjs
```

The fixture uses a pinned BusyBox base and no provider APIs, accounts or credentials. The test creates two random tenant IDs through the real driver, confirms each local HTTP server is alive, checks denial in both network directions, verifies private volume mounts and markers, exercises read-only roots/seccomp/capabilities/bootstrap and stop/wake, and deletes its resources. It never emits release-gate evidence. A missing kernel control exits with code 2 and `NOT RUN`; failed assertions exit nonzero. Cleanup failures retain the resources for reconciliation.

In the MT-B development sandbox, Docker 25 starts with built-in seccomp but reports `SwapLimit:false`. It changes a requested memory/swap ceiling to `MemorySwap:-1`. Creation is therefore refused. The real two-tenant e2e is **NOT RUN** in that environment; fake-engine results do not substitute for it.
