# Decision: cloud VM provider (Phase 0 spike, 2026-11-10)

**Decision: Fly.io Machines** for per-user cloud VMs (`COMPUTER_PROVIDER=cloudvm`, `VM_DRIVER=fly`). Self-hosted Firecracker comes later as another driver.

## What was tested

- **Image:** `infra/vm-image`, built and pushed to `registry.fly.io/swarm-team-vms:v1`.
- **Server:** a temporary staging server on Fly in cloud-VM mode, plus an app holding the user VMs (`swarm-team-vms`, region `iad`).
- **Flow:** real sign-ups through the API, with each VM created by the server's Fly driver. Everything was torn down afterwards.

## Results

| Measure | Result |
|---|---|
| Sign-up → VM created, booted, companion online, first Bot screen ready | **26 s** (clean run) |
| Another Bot's screen on the running VM | **< 1 s** |
| Suspend (machine fully `suspended` on Fly) | **0.2–3.8 s** |
| Resume → companion back online, all screens listed | **~2 s** |
| Memory: base + 2 Bot screens (Xvfb, XFCE, companion) | **~470 MB** of 4 GB |
| Memory: 2 screens + a Wikipedia page in each Bot's Chrome | **~940–960 MB** of 4 GB |
| Orphan cleanup (VM whose account is gone) | Destroyed automatically by the reconcile loop |
| Provider errors (e.g. volume quota) | Retried with backoff; recovered on its own once capacity freed |

**Sizing:** about 110 MB per empty screen and 250 MB per Chrome on a light page. The defaults (2 GB base + 768 MB per Bot) leave headroom for heavier sites.

## Issues found and fixed

- **Resize interrupted active VMs.** Adding a Bot resized the VM immediately, and on Fly that restarts it, losing every screen. Resizing now waits until the VM sleeps and applies at its next boot (`skip_launch`).
- **The VM firewall blocked `fly ssh`.** Replies over Fly's private network were rejected. Replies to established connections are now allowed; new outbound connections to the private network stay blocked.
- **Suspend is asynchronous on Fly.** The server marks the VM suspended while Fly is still `suspending`. Resume handles both states.

## Blockers before real users

- **Add a payment method to the Fly account.** Without one, Fly stops every machine after **5 minutes**, including the app server and user VMs, and caps volumes at **20 GB** total (two users' 10 GB disks).
- **Rebuild and push the VM image after the in-progress rename.** The server and image must agree on the token path (`/run/<name>/token`) and the server URL variable.
- **Keep the server's database on a volume** (the production `fly.toml` does). The spike's staging server used `/tmp`, so each Fly stop wiped it.

## Not yet verified

- **Open Chrome windows surviving a real suspend/resume.** The 5-minute trial stop kept interrupting the test. Fly suspend keeps memory, so they should survive; verify once billing is on.
- **Behaviour under many concurrent sign-ups on Fly.** The worker runs 5 at a time; 50 concurrent sign-ups were only tested with the fake driver.
