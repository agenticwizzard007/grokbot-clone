# Decision: cloud VM provider (Phase 0 spike, 2026-11-10)

**Decision: Fly.io Machines** for per-user cloud VMs (`COMPUTER_PROVIDER=cloudvm`, `VM_DRIVER=fly`). Self-hosted Firecracker comes later as another driver.

## What was tested

- **Image:** the Swarms VM image in `infra/vm-image`, built and pushed to the Fly registry for staging tests.
- **Server:** a temporary Swarms staging server on Fly in cloud-VM mode, plus an app holding the user VMs in region `iad`.
- **Flow:** real sign-ups through the API, with each VM created by the server's Fly driver. Everything was torn down afterwards.
- **Production (2026-11-10):** `swarm-team` runs with `COMPUTER_PROVIDER=cloudvm` (commit 92801fd). User VMs live in `swarm-team-vms` (image `registry.fly.io/swarm-team-vms:v1`). A test account created in production got its VM and first Bot screen in ~24 s, and deleting the account destroyed the VM and its disk. The temporary Swarms staging app has been deleted.

## Results

| Measure | Result |
|---|---|
| Sign-up → VM created, booted, companion online, first Bot screen ready | **26–31 s** (three clean runs) |
| Another Bot's screen on the running VM | **< 1 s** |
| Suspend (machine fully `suspended` on Fly) | **0.2–3.8 s** |
| Resume → companion back online, all screens listed | **~2 s** (1.7–4.9 s) |
| Open programs across suspend → resume (60 s asleep) | **Survive**: same Chrome processes, uptime advanced 0.7 s (memory restored, no reboot) |
| Machines kept running past 5 minutes (payment method added) | **Yes** (staging ran 12+ min with no forced stop) |
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
- **Keep the Swarms VM image and server configuration aligned.** The server and image must agree on the token path (`/run/swarm/token`) and the server URL variable.
- **Keep the server's database on a volume** (the production `fly.toml` does). The spike's staging server used `/tmp`, so each Fly stop wiped it.

## Resizing behaviour (by design)

Adding a Bot queues a resize, which waits until the VM is asleep (rechecked every 60 s) and applies at its next boot. **That one wake is a fresh boot**, so the Bots' open tabs are lost (profiles and logins on the volume are kept). Later wakes restore everything.

Measured use was about **325 MB per Bot** (screen plus Chrome on a light page; 2 Bots ≈ 650 MB). So the defaults (2 GB base + 768 MB per Bot) are generous. `VM_BASE_MEMORY_MB=2048 VM_SCREEN_MEMORY_MB=384` would let users with up to about 4 Bots never need a resize, at lower cost. Revisit with heavier sites.

## Not yet verified

- **Behaviour under many concurrent sign-ups on Fly.** The worker runs 5 at a time; 50 concurrent sign-ups were only tested with the fake driver.
