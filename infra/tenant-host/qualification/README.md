# Real Fly nested-container qualification

This is an operator-run job, not a CI qualification or a deployment. It creates no resources by itself. The operator creates one disposable **performance-2x CPU class (2 performance CPUs, 8192 MiB), iad** Machine and runs a copied bundle inside it. The job starts root `dockerd` inside Fly's Firecracker VM, as remote builders do. It never mounts another host's Docker socket. The 8 GiB allocation accommodates desktop/Chrome and live synthetic target containers; 4 GiB leaves little room for production workloads plus Docker.

Use the **exact published, signed tenant-host image digest** that will be proposed for release. `HOST_BASE` alone is insufficient: a base-image experiment cannot approve a subsequently built tenant-host image. The job bypasses the host's normal entrypoint, does not register a tenant, and requires no platform, database, KMS, provider or tenant credentials. Use a new app containing no secrets or other Machines. Never use `swarm-team`, a tenant app, or a production app.

## What is tested

* The unchanged `tests/container-containment.test.mts` runs with `RUN_CONTAINER_TESTS=1`, Node's test runner and a copied, locked `tsx` dependency graph. All five subtests and their parent must pass; exit zero with skips/empty results is rejected. It calls the production `containerArguments` and real `McpFolderLease`, including read-only selected-folder mounts and symlink checks.
* Alpine is pulled by **linux/amd64 registry manifest**, then its local config ID must equal the original `.context/isolation-implementation/containment-image.txt`: `sha256:e50d940e9d2c4d81e5b3506b2ed87bfc7e91267b36ff016eb4b4cb21c39a3331`. The saved original pull log's index was `sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab`; its amd64 manifest is `sha256:2d8a11041a92082ba21e364dec73559ce44f1de69b60fa68315f6d3774e59117`. No mutable-tag or platform fallback exists.
* The app/desktop `basic` flags are parsed from `server/src/runtime/host.ts`, never evaluated or maintained as a second policy. A detached Alpine canary checks effective nonroot UID, zero capabilities, no-new-privileges, seccomp, read-only root and actual pids/memory/**zero swap**/CPU limits. It retains `--log-driver=none` and copies output from tmpfs while running.
* `dockerd` arguments are parsed from the production `infra/tenant-host/entrypoint.sh`; a changed syntax requires review. No `--privileged` workloads, unconfined seccomp, disabled controllers, storage-driver fallback or relaxed runtime flags are allowed to obtain a pass.
* The installed host runtime JS and entrypoint must match a fresh build of the reviewed sources byte for byte. The job loads only the embedded `MCP_IMAGE.tar`, verifies its config ID against `/opt/swarm/release.json`, then runs the **actual installed** `verifyHostContainment` startup preflight with that Node-containing image.
* The expanded desktop phase loads the signed release's actual desktop image. It uses the desktop-only scoped seccomp profile and `/dev/shm` flags extracted from the real launch, with synthetic desktop home/token mounts. It requires user-namespace containment and **Chrome's namespace and Seccomp-BPF sandboxes** without `--no-sandbox`. Chrome 157 is invoked with `--allow-chrome-scheme-url` to dump `chrome://sandbox`; the actual status table must report `Layer 1 Sandbox=Namespace`, `PID namespaces=Yes`, `Network namespaces=Yes`, and `Seccomp-BPF sandbox=Yes`. NewTab, missing/duplicate rows, and disabled controls are rejected. The four observed values are retained in evidence. It attempts forbidden host/socket/tenant-credential reads, symlinks, `/proc/1/root`, unnamespaced mount/chroot, and repeats forbidden reads from an allowed user namespace.
* It creates the production bridges from the entrypoint's exact arguments, starts live synthetic listeners, verifies their positive controls, installs the installed production firewall, then rejects desktop connections to another app port/container, an MCP-policy sentinel, a synthetic metadata endpoint (`169.254.169.254`), a synthetic RFC1918 endpoint, the host bridge and the real Fly host's private IPv6 listener. No actual cloud metadata service or other tenant is queried. Docker default seccomp plus cap-drop=ALL remain mandatory on app/MCP fixtures; runner/MCP source guards reject custom profiles or capability additions.
* **The authenticated desktop-to-app TCP 8787 path is an intentional exception**, not an isolation failure. The job requires that route to work against a synthetic token-checking HTTP listener and reject an invalid fixture token. This proves routing and the fixture's behavior, not the real application's authorization. A blanket network outage cannot produce a pass. Chrome/profile/network observations and the scoped profile hash are recorded separately.
* Containers, custom networks and MCP folder mounts must be gone; daemon shutdown must complete. A failed or partial job leaves diagnostic results, never passing gate evidence.

This gate covers the bounded probes above on one Fly VM. It does not qualify two-tenant private networking, a compromised VM root, full application/companion authorization, every possible escape, provider logins, migrations, durability or the 1,000-tenant fleet. Those release gates remain separate. Inner workload command tails are replaced by controlled probes, as in the existing containment suite; runtime isolation flags are preserved.

## Prepare offline (Linux x64, Node 22+)

First integrate the image owner's reviewed host/desktop profile changes and publication workflow, then prepare from a clean checkout containing those exact runtime sources and this job, with `npm ci` completed. Preparation fails closed while the scoped profile is absent. The image pipeline's published `reports/images.json` must bind the candidate host to signed host/desktop base digests, a source commit, and `desktopSeccompSha256`; dry-run provenance is refused. The profile hash must agree with reviewed source bytes, the prepared manifest, installed profile bytes, and the verified host's `release.json`.

```sh
host_image='registry.fly.io/REPLACE-TENANT-HOST@sha256:REPLACE-WITH-64-HEX'
run_dir="$PWD/.context/containment-fly-run-01"
image_report='/absolute/path/to/published/reports/images.json'
cosign verify --key "$IMAGE_VERIFICATION_KEY" "$host_image"
node infra/tenant-host/qualification/prepare.mjs "$host_image" "$image_report" "$run_dir"
```

`prepare.mjs` builds the server and writes `machine.json` (Machines API create body), `bundle.tgz`, its checksum and `manifest.json`. It copies only test/policy sources, loader dependencies and qualification code. It selects provenance fields from `images.json`, never its surrounding directory. It never copies `.env`, `.git`, data or other `.context` contents. Do not hand-edit the generated definition or bundle. The 30 GB temporary root filesystem leaves space for embedded images and unpacked MCP/desktop layers; an out-of-disk run fails. No persistent volume is created.

## Create and run (owner executes; incurs Fly charges)

Use current `flyctl`, `curl`, and a locally held token with permission for this disposable app. Do not put the token in `machine.json` or Fly app secrets. The published host image must be pullable by Fly; if registry access requires configuration, arrange that outside the VM rather than injecting a registry token into the job.

```sh
app='REPLACE-NEW-DISPOSABLE-APP'
org='REPLACE-APPROVED-ORG'
fly apps create "$app" --org "$org"
fly secrets list --app "$app"
# Verify the app has no secrets. Keep FLY_API_TOKEN only in this local shell.
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $FLY_API_TOKEN" -H 'Content-Type: application/json' \
  --data-binary "@$run_dir/machine.json" \
  "https://api.machines.dev/v1/apps/$app/machines" > "$run_dir/created-machine.json"
machine=$(node -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1])); if(!/^[a-f0-9]+$/.test(m.id))throw Error("Invalid Machine ID");process.stdout.write(m.id)' "$run_dir/created-machine.json")
fly machine status "$machine" --app "$app"
fly ssh sftp put --app "$app" --machine "$machine" "$run_dir/bundle.tgz" /tmp/bundle.tgz
fly ssh sftp put --app "$app" --machine "$machine" "$run_dir/bundle.tgz.sha256" /tmp/bundle.tgz.sha256
fly ssh console --app "$app" --machine "$machine" --user root \
  -C "sh -ec 'cd /tmp; sha256sum -c bundle.tgz.sha256; mkdir -m 700 containment; tar -xzf bundle.tgz -C containment; nohup setsid node /tmp/containment/job.mjs > /tmp/containment/console.log 2>&1 < /dev/null &'"
```

The job runs in its own session because production private-IPv6 egress rules can interrupt Fly SSH. It snapshots both firewall families, starts the controlled desktop probe behind a file barrier, installs the production firewall, then releases the probe. It restores the snapshots during cleanup (and on the watchdog exit) so diagnostics can reconnect. No broad allow rule is added during the tests. Root host firewall control is never available to inner workloads. `HOST_BASE` must include `nohup`, `setsid`, `iptables-save/restore`, and `ip6tables-save/restore`.

The job has a 12-minute watchdog, a 5-minute test-runner timeout and per-command timeouts. Machine PID 1 exits after 30 minutes even if SSH disconnects; restart policy is `no`. Start promptly, allow up to 12 minutes for completion, then inspect `/tmp/containment/results/job.json` with `fly ssh console`/SFTP. A temporarily unreachable SSH connection during the firewall phase is expected; it is not a test result. If the launch command fails, **still collect available raw results and tear down**. Do not retry a job in the same unpacked directory or with an existing daemon. Use a new Machine for a new qualification attempt.

The definition retains rootfs changes across a manual restart solely to permit recovery of results after the deadline. If necessary, `fly machine start "$machine" --app "$app"` gives another bounded retrieval window; it costs more running time. Retrieve existing results without rerunning `job.mjs`. Updating the Machine may reset its rootfs and invalidates this run.

## Collect and bind evidence to the actual Machine

```sh
fly ssh sftp get --recursive --app "$app" --machine "$machine" \
  /tmp/containment/results "$run_dir/results"
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  "https://api.machines.dev/v1/apps/$app/machines/$machine" > "$run_dir/machine-get.json"
node infra/tenant-host/qualification/finalize.mjs \
  "$run_dir/manifest.json" "$run_dir/results" "$run_dir/machine-get.json" "$run_dir/evidence"
```

The finalizer rejects failed jobs, skips, altered downloaded logs, image/config/region/**actual guest size** mismatches, and a Machine ID different from the one in the VM's Fly metadata. It retains only selected Machine fields, not a raw API response or environment dump. `evidence/evidence.json` contains host/base/desktop image digests, source identities, **scoped seccomp profile SHA-256**, immutable Alpine identities, timestamps, kernel/Docker/cgroup facts, exact flags, outcomes and artifact hashes. Its `evidence.json.sha256` hashes the **exact JSON bytes**, not a tarball. Adjacent files preserve the test events, kernel and desktop probes, daemon log and source manifest. All credentials in suite fixtures are synthetic; review logs before sharing.

Upload the evidence directory to an owner-approved restricted artifact location. Supply the durable URI of **evidence.json**, its SHA-256 and the exact tested host digest to the platform operator:

```text
release-gates-cli record <tested-host-image@sha256:...> nested-container-containment <https-or-s3-evidence.json-uri> <evidence.json-sha256> <reviewer>
```

For the repository CLI, use `node server/dist/platform/release-gates-cli.js record ...` in the authorized platform environment. The job and finalizer never connect to PostgreSQL, record a gate or approve it. Default `record` is unapproved; `--approve` is a separate explicit reviewer action after verifying the artifact, source/image signatures and Fly account provenance. A local `file:` URI is accepted by the CLI for local review but is not durable shared release evidence. Never apply an artifact to a different image digest.

## Teardown, including on failure

Capture the Machine GET first. Confirm its ID, name, `config.image` and `config.metadata.purpose=nested-container-containment` match this run. Then destroy **only that ID**:

```sh
fly machine destroy "$machine" --app "$app" --force
fly machine list --app "$app"
fly volumes list --app "$app"
```

The job stops its nested daemon; destroying the outer Machine removes the disposable containers, images, root filesystem and failed-run mounts even after a job crash. Once both lists confirm the app is empty, delete the **new disposable app** with `fly apps destroy "$app" --yes`. Do not delete any preexisting app or volume. Keep downloaded artifacts outside the destroyed Machine. The 30-minute stop is a billing backstop, not teardown; destroy the Machine even if it is already stopped.

At the supplied **$0.09/hour baseline**, running compute is approximately **$0.015 for 10 minutes**, **$0.03 for 20 minutes**, or **$0.045 for the 30-minute window**. The expanded job explicitly allocates **8 GiB**, so add the account's charge for memory above the baseline performance-2x allocation: total hourly rate is `$0.09 + extra-memory-hourly-rate`; multiply by runtime minutes/60. These estimates exclude image build time, registry/network transfers, rootfs/storage and evidence retention; verify current account pricing before creating the Machine. Restarting or leaving resources behind adds cost.

## HOST_BASE acceptance checklist for its owner

The pinned, signed Linux **amd64** base must supply:

* Node **22+**, root `/bin/sh`, `nohup`, `setsid`, GNU-compatible `tar`/gzip, `sha256sum`, and CA certificates. The copied loader graph supplies `tsx`, esbuild's Linux x64 binary and zod, so no npm install or live package resolution runs in the VM.
* Rootful Docker Engine (`dockerd`), matching Docker CLI with **bind-recursive=disabled** support (Docker 25+), containerd/runc and Docker's init binary for `--init`. Docker 29.9.3 may embed containerd; a standalone tool is useful for version diagnostics, while the daemon must use its actual bundled runtime. No autostarted daemon, prepopulated `/var/lib/docker`, external Docker socket, or config that disables isolation. Working overlayfs/storage, iptables/ip6tables and both families' save/restore tools are required for production-like Docker bridges.
* util-linux `mount`/`umount` with **--no-canonicalize**, root mount privileges in the VM namespace, usable `/proc/<pid>/fd` binds, and the mount visibility needed by `McpFolderLease` and nested Docker. Do not enable privileged inner containers to compensate for a failed bind.
* On the actual Fly kernel: cgroup v2 **domain** CPU/memory/pids controllers and swap accounting; enforceable no-swap limits; seccomp filter support/default profile; namespaces, read-only mounts and capability/no-new-privileges enforcement. These are host/kernel facts, not packages that can be fixed by a passing unit test. Threaded-only cgroups or Docker warnings about ignored controls must fail.

The final tenant-host image must additionally contain the normal `/opt/swarm/entrypoint.sh`, `/opt/swarm/firewall.sh`, `/opt/swarm/chromium-seccomp.json`, `/app/server/dist` built from the reviewed sources, application dependencies, a **verified** `/opt/swarm/release.json` with source commit, and digest-verified embedded runtime archives. The job requires `MCP_IMAGE.tar` even when APP/RUNNER/MCP share one config ID; it also loads `DESKTOP_IMAGE.tar` (and `APP_IMAGE.tar` if app differs from MCP). Docker save/load loses RepoDigests, so the signed release's mapping to config IDs is used. The MCP image must contain Node; the desktop image needs Chrome with namespace/seccomp sandbox support and `mount`, `chroot`, `unshare` tools for adversarial probes. Preserve the release build's signature/scanning/provenance requirements. Pinned Debian Trixie versus Bookworm and locked Docker/Node digests belong to the image owner; neither a new base nor successful image smoke is a real Fly pass. **No real Fly pass is claimed by this PR**.
