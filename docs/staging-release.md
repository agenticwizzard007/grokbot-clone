# Fly staging releases

Staging is https://swarm-team.fly.dev. The application serves the API and built web app from one image. A healthy `/api/health` response does not establish which features were released.

The November 19 reconciliation found release 35 deployed from `main` at `1fd91e1`, while native workflows, learning, coordination and Quinn updates were on `agenticwizzard007/hermes-integration-strategy` and in uncommitted workspace files. Rebuilding `main` alone omitted those changes. The staging branch now includes that `main` revision and the completed workspace implementation. Keep using this integrated branch until PR #48 lands in `main`; do not overwrite staging with an older `main` build.

Before release:

1. Fetch and reconcile the latest upstream changes. Commit all intended application files, including previously untracked modules. Build from a clean `git archive` or checkout of that exact commit.
2. Run `npm run test:hermes-native`, `npm run test:deployment`, and `npm run test:voice-entry` after the production build. Run the migration and affected CLI/voice tests for changes in those areas.
3. Save the current Fly status and immutable image digest. Create a consistent SQLite backup and a Fly volume snapshot. Rehearse schema initialization on a private copy with `SWARM_NO_SCHEDULER=1`; compare account, conversation, task, routine and job counts.
4. For first-time learning/coordination upgrades, prepare the selected accounts before starting background workers, following [the offline rollout procedure](hermes-offline-rollout.md). Preserve all other preferences. Daily synopses keep their explicit schedule settings and default to Library delivery.

Build the image from the clean source directory, supplying the full Git revision:

```sh
flyctl deploy . --config fly.toml -a swarm-team --remote-only --build-only --push \
  --image-label staging-<short-sha> --build-arg SWARM_BUILD_REVISION=<full-sha>
```

`npm run build` writes `web/dist/build.json` and `server/dist/release-manifest.json`. The manifest records every frontend and server output hash. The Docker build uses the same command. Deploy the resulting immutable `registry.fly.io/swarm-team@sha256:...` image with `--ha=false`, keeping the existing volume and environment. A first-time offline preparation command, if required, must finish successfully before starting `server/dist/index.js` on the volume-owning machine.

After deployment, retrieve `/app/server/dist/release-manifest.json` from the deployed machine into a private evidence directory and check its revision against the intended source commit. Verify server files against its hashes on the machine, then verify all public frontend files and required feature markers:

```sh
npm run verify:deployment -- https://swarm-team.fly.dev path/to/release-manifest.json
```

The verifier rejects mismatched revisions/hashes, missing bundles, missing workflow/learning/report controls, and API paths that fall back to HTML. `/api/version` and `/build.json` must report the same release; HTML and build metadata revalidate while fingerprinted assets remain immutable. Complete authenticated browser checks of the workflow, learning, team board and synopsis pages before recording the release as verified.

For rollback, use the recorded previous image digest and original Fly configuration. Keep the database backup and migration journals; do not delete tables or replay jobs with uncertain external outcomes. A code rollback alone does not restore earlier database state.
