# Fly staging releases

Staging is https://swarm-team.fly.dev. The application serves the API and built web app from one image. A healthy `/api/health` response does not establish which features were released.

The November 19 reconciliation found release 35 deployed from `main` at `1fd91e1`, while native workflows, learning, coordination and Quinn updates were on `agenticwizzard007/hermes-integration-strategy` and in uncommitted workspace files. Rebuilding `main` alone omitted those changes. The staging branch now includes that `main` revision and the completed workspace implementation.

## Automatic deployment

`.github/workflows/staging.yml` runs on every push to `main`, including changes only to tests/docs. Work developed on other branches must first be merged into `main` through a reviewed pull request; these release branches; unrelated or unfinished branches are not combined automatically. Uncommitted local files cannot be deployed by GitHub Actions.

The workflow requires the repository Actions secret `FLY_STAGING_DEPLOY_TOKEN`, containing a Fly deploy token scoped only to `swarm-team`. An administrator can configure it without printing the token:

```sh
flyctl tokens create deploy -a swarm-team --name github-staging --expiry 8760h |
  gh secret set FLY_STAGING_DEPLOY_TOKEN --repo agenticwizzard007/grokbot-clone
```

Rotate this credential before its one-year expiry. Credentials are loaded only into publication/deployment steps, after source and image verification. The workflow does not run on pull-request or arbitrary feature-branch events.

Every candidate must contain both the latest `main` commit and the currently deployed commit. This prevents an older main build from removing live features. Only `main` is an eligible release source; if a reviewed manual release ever leaves production on a revision that is not an ancestor of `main`, an administrator dispatches the workflow with `allow_live_replacement` after review, and the decision is logged in the run. Before a superseded checkout is skipped, preflight checks for a queued or running staging deploy for the exact current main tip. If none exists, it dispatches main and fails explicitly if dispatch fails. Checks repeat before publishing and deployment, and a single concurrency group serializes rollouts without cancelling an in-progress deployment.

Do not put `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, or `[actions skip]` in main merge commit messages, or use a `skip-checks` trailer. These suppress GitHub's push-triggered deploy as well as CI. Test workflows are disabled separately; skip markers are unnecessary. A scheduled recovery check runs every ten minutes (subject to GitHub scheduling delays) even when a push was skipped. It checks the current main revision and live identity and exits before any build if main is already live. Otherwise it uses the same deployment path. Manual `workflow_dispatch` remains available:

```sh
gh workflow run staging.yml --ref main --repo agenticwizzard007/grokbot-clone
```

The workflow builds one complete frontend/backend image, verifies its manifest and file hashes, creates and waits for a volume snapshot, publishes the image, deploys by immutable digest, and verifies published frontend files and the running image identity. It runs no test suites or browser tests. A missing credential, missing ancestor, failed backup, failed recovery dispatch, or mismatched build causes an explicit failed run. Release/rollback evidence is retained as a GitHub Actions artifact. Failed verification is not reported as a successful release, and database migrations are not blindly reversed.

Account learning/supervision choices are persisted in the volume and are not reset by deployments. All current staging accounts were explicitly enabled by the owner; new accounts inherit enabled defaults.

## Manual release and recovery

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

For rollback, first establish that the recorded previous image supports the current database semantics. A pre-Hermes image (for example `1fd91e1`) must not open a volume upgraded by v39/v40: it exposes deleted/corrected knowledge and cannot delete skills with immutable revision history. Run the [offline knowledge compatibility check and recovery procedure](hermes-knowledge-recovery.md); prefer a compatible forward repair. Keep the database backup and migration journals; do not delete tables or replay jobs with uncertain external outcomes. A code rollback alone does not restore earlier database state, and an older backup requires reconciliation of subsequent deletions, corrections and external actions before serving users.
