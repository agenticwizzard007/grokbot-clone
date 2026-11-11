# Build an isolated tenant host

This release contains the tenant app, subscription/MCP runner and desktop as preloaded, immutable component images.
The trusted host starts Docker and enforces the existing workload policy. Building or signing an image does not
qualify Fly containment, provider logins, private networking or capacity.

## Inputs and image definitions

`images.lock.json` pins Linux/amd64 Node 22 and Docker base manifest digests, the Debian Trixie snapshot, Chrome's
version/checksum, the patched npm tarball integrity, zlib's fixed package version, FFmpeg source/signing identity/configuration,
and checksums for Trivy and cosign. Updates are reviewed source changes; the pipeline never resolves a floating base tag.

- `HostBase.Dockerfile`: Node 22, Docker 29.9.3 daemon/CLI, matching standalone containerd/runc/docker-init,
  util-linux mount/umount with `--no-canonicalize`, iptables/ip6tables, shell, tar, gzip, sha256sum and CA certificates.
  Docker 25+ supports the existing `bind-recursive=disabled` folder mounts. The daemon listens only on its Unix socket.
- `DesktopBase.Dockerfile`: Chrome, Xvfb, xfwm4, xdotool, Python, Node 22, and the lockfile-installed
  `@playwright/mcp` **0.0.85**. UID/GID 10001, no sudo, no runtime package-manager bootstrap or executable download.
  `Desktop.Dockerfile` adds the exact checked-out companion. Browser sandboxing stays enabled.
- The app Dockerfile builds **one** artifact for APP/RUNNER/MCP, including lockfile-selected Claude/Codex packages.
  The tenant pipeline supplies the pinned Node/snapshot/npm/zlib inputs; default standalone build behavior is preserved.
- Desktop capture uses **FFmpeg 9.0.2 built from signed upstream source**, not Debian's codec stack or the older
  `ffmpeg-static` npm artifact. The source SHA-256 and release-key fingerprint are checked before compilation.
  Only XCB/X11 capture, rawvideo decoding, MJPEG encoding, scale/format conversion, image2/image2pipe and pipe/file
  protocols are enabled. Network protocols, other media decoders, external codecs, ffplay and ffprobe are disabled.
  The binary is at `/usr/local/bin/ffmpeg`, also named by `SWARM_FFMPEG`; its version, source hash, configure flags,
  signing-key fingerprint and binary hash are recorded in `release.json` and `reports/images.json`.

The stock application still includes its existing `ffmpeg-static` dependency for other app features. A package
scanner does not inventory all C libraries in that static binary; desktop slimming does not remediate or qualify
that separate artifact. Review it separately before claiming complete application media-parser coverage.

## Desktop sandbox and routing

`chromium-seccomp.json` derives from Playwright's profile at
[3b438229c6a2ccdbe2d3572755935892203d83c3](https://github.com/microsoft/playwright/blob/3b438229c6a2ccdbe2d3572755935892203d83c3/utils/docker/seccomp_profile.json)
(Apache-2.0). It permits Chrome's user-namespace setup, plus `chroot` inside that namespace with **all outer capabilities
still dropped**, and returns ENOSYS for clone3 so libc falls back to the profile's clone rules. Default action remains
ERRNO. The host applies it **only to the desktop**; app and runner/MCP containers retain Docker's default seccomp.
The profile SHA-256 is bound into the release manifest and checked before the host boots. No `--no-sandbox`, privileged
workload, Docker socket mount, or added workload capability is used.
Microsoft's Apache-2.0 license is retained in `PLAYWRIGHT-LICENSE` and the host image. The local changes to the
upstream profile are the `chroot` allowance and clone3 ENOSYS fallback described above.

The desktop-to-app TCP8787 firewall rule uses an exact source/destination ACCEPT. A RETURN would encounter Docker's
inter-bridge isolation and drop the intended companion connection. All other private/metadata denies remain.
The real-Fly harness must demonstrate both this positive connection and negative routes. A local image smoke cannot
prove the provider's network or kernel controls.

## GitHub Actions

The `Tenant host images` workflow runs contract tests on relevant PRs. Dispatch it with:

| Input | Meaning |
|---|---|
| `source_sha` | Exact reviewed 40-character commit; empty uses the workflow commit |
| `dry_run` | Defaults true: build/scan only, no credentials, sign, push or bootable host |
| `registry_app` | Existing Fly app used solely as the image registry target; required for publishing |

Publishing must be dispatched from main with a source commit on main. The trusted workflow checks ancestry **before
running repository code or exposing publication secrets**. Configure the `tenant-image-release` GitHub environment
for main only, with restricted approvers and these inputs:

| Setting | Type | Purpose |
|---|---|---|
| `FLY_IMAGE_PUSH_TOKEN` | Secret | Push to the existing registry app; no tenant Fly administration is needed |
| `COSIGN_PRIVATE_KEY` | Secret | Encrypted cosign image-signing key, separate from platform identity keys |
| `COSIGN_PASSWORD` | Secret | Signing-key password |
| `TENANT_PLATFORM_PUBLIC_KEY` | Variable | Ed25519 SPKI `BEGIN PUBLIC KEY` PEM used to verify platform/runtime identities |

No platform **private** key, model credentials, database URL, AWS key or user authorization belongs in the workflow.
Dry mode uses the `tenant-image-dry-run` environment and receives none of those secrets. Tools and Actions are pinned.
Temporary Docker auth and signing files are mode-private, excluded from build contexts/artifacts, and removed on exit.

The workflow builds and scans components locally, pushes/scans/signs immutable references, verifies signatures,
checks image functionality, and calls `build-release.sh` with `HOST_IMAGE_TAG`. Host assembly extracts the compiled
server and production dependencies from **that exact APP_IMAGE**, so host and application code cannot silently diverge.
APP/RUNNER/MCP share the same digest but have separate runtime storage and containers. The shared archive is exported
once as `MCP_IMAGE.tar`; desktop gets its own archive. The final host is scanned before push/sign/verification.

The publishing job outputs `host_image_digest` as `registry.fly.io/<app>@sha256:...`. Artifacts include:

- `reports/images.json`: source commit, locked inputs, component/base digests, host digest, profile hash and FFmpeg provenance.
- `release.json`: embedded component image-config bindings, public verification key and source/profile/FFmpeg identity.
- Per-image Trivy JSON and desktop smoke output. These are **not** infrastructure qualification receipts.

Dry hosts are labeled `dry-run`, their manifests say the same, and the entrypoint refuses to start workloads.
Dry mode may finish building/collecting all scan reports but still exits nonzero if any scan failed; it never emits a
publishable digest or signs/pushes anything. Runtime smoke with production cgroup limits is a publication prerequisite;
a threaded/delegation-limited sandbox cannot satisfy it. The actual Fly containment harness remains an additional gate.

## Local dry build

A Linux/amd64 Docker **BuildKit** builder and Node 22+ are required. The final host uses a Dockerfile-specific
ignore file to admit only the staged release artifacts; the legacy Docker builder cannot assemble it. No credentials are required:

```sh
bash infra/tenant-host/install-release-tools.sh
RELEASE_SOURCE_SHA="$(git rev-parse HEAD)" node infra/tenant-host/release-images.mjs --dry-run
```

All HIGH/CRITICAL scan findings currently block publication, including unfixed findings; there is no automatic
exception or `ignore-unfixed` switch. Package-inventory scans also do not prove source-built/static codec libraries
safe. Source provenance and deliberately restricted FFmpeg functionality accompany those scans. Any future exceptions
policy needs separate owner approval and review; no exceptions are granted by this release code.

## First staging tenant: 4 GiB boot, evidenced growth to 8 GiB

The existing ceilings are `1536 + 1536 + 768*n` MiB, where `n` counts simultaneous runner/MCP containers. For one
runner that is **3840 MiB**, leaving only **256 MiB** on a 4096 MiB guest before the supervisor, dockerd, kernel and
other host memory. Two worker containers reach **4608 MiB**, exceeding that guest size. Ceilings are not reservations
and tmpfs/browser/shared pages consume memory too; this arithmetic does not predict actual usage.

The coordinator approved **8 GiB as the first staging target**. One runner leaves 4352 MiB nominal headroom; a runner plus
one local MCP leaves 3584 MiB. Container limits and the global provisioning default remain unchanged. The agreed staging
sequence is to boot on the existing reviewed 4096 MiB path, collect fresh owned usage samples, then grow through the
evidenced capacity-maintenance path. Never silently alter an existing guest or bypass resize fencing.
The existing operator commands are in [tenant capacity operations](../../docs/tenant-capacity-operations.md): install an
approved policy, collect a fresh host usage window, plan, then queue the reviewed maintenance operation. They require
an existing environment and exact-image `tenant-capacity-resize` evidence; they do not configure the initial guest size
or provide a shortcut for a tenant that has not yet booted. No initial-size override is included in this release.
No account generation/helper caps or queues are introduced. Measure RSS, cgroup pressure/OOMs, browser viewing, cold
loads and backup temporary-disk use before choosing production limits or claiming 1,000-user capacity.

After a published candidate exists, use the exact digest and `reports/images.json` in the real-Fly containment harness
(including the Chrome157/provenance follow-up). Verify signatures and record release gates only from independently
reviewed evidence. No image build, dry scan or local browser check automatically approves a release gate.
