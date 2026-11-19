# Offline learning / Quinn cohort preparation

Run from the repository root against the intended **offline** application database, after taking the documented database/files backup. All application workers, provisioner exposure and automatic restarts must remain stopped until this command succeeds. It opens no HTTP listener and imports no application entry point, loop, learning runtime or delivery runtime. Keep the existing deployment role, tenant identity, volume manifest and credentials restrictions; do not impersonate a tenant by changing its identity. `DB_PATH` must name an existing absolute database file. Use an explicit owner list even in a shared standalone database.

Save the following JavaScript block as an operational `.mjs` file outside product source, or extract it into `node --import tsx --input-type=module` on stdin. Its imports resolve from the repository working directory. Set `SWARM_NO_SCHEDULER=1` as defense in depth; the absence of runtime imports is what prevents dispatch.

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const mode = process.env.ROLLOUT_MODE;
assert.ok(['disable', 'verify-disabled', 'enable', 'verify-enabled'].includes(mode), 'Explicit ROLLOUT_MODE required');
assert.equal(process.env.SWARM_NO_SCHEDULER, '1', 'Offline operation requires SWARM_NO_SCHEDULER=1');
assert.ok(['tenant', 'standalone'].includes(process.env.SWARM_ROLE), 'Preserve the explicit application deployment role');
assert.ok(process.env.DB_PATH && path.isAbsolute(process.env.DB_PATH) && fs.existsSync(process.env.DB_PATH), 'Existing absolute DB_PATH required');
const owners = JSON.parse(process.env.ROLLOUT_OWNER_IDS ?? 'null');
assert.ok(Array.isArray(owners) && owners.length > 0 && owners.every(id => typeof id === 'string' && id.length > 0), 'Explicit nonempty ROLLOUT_OWNER_IDS JSON array required');
assert.equal(new Set(owners).size, owners.length, 'Duplicate owner IDs');
if (process.env.SWARM_ROLE === 'tenant') assert.deepEqual(owners, [process.env.SWARM_TENANT_ID], 'Owner list must equal the existing tenant identity');
const source = relative => pathToFileURL(path.resolve('server/src', relative)).href;
assert.ok(fs.existsSync(path.resolve('server/src/db.ts')), 'Run from the repository root');

// Inspect holds before importing modules that add schemas/backfill local data.
// No hold is released, bypassed or silently skipped. Any failure blocks startup.
const { legacyHeldOwners, assertLegacyDatabaseFences } = await import(source('platform/legacy-database-fence.ts'));
const preflight = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
try {
  assertLegacyDatabaseFences(preflight);
  const held = new Set(legacyHeldOwners(preflight));
  for (const owner of owners) {
    assert.ok(preflight.prepare('SELECT 1 FROM users WHERE id=?').get(owner), 'Owner does not exist: ' + owner);
    assert.ok(!held.has(owner), 'Owner is migration-held; keep it stopped: ' + owner);
  }
} finally { preflight.close(); }

let db;
try {
  ({ db } = await import(source('db.ts')));
  await import(source('knowledge/schema.ts'));
  const { learningSettings, patchLearningSettings } = await import(source('knowledge/settings.ts'));
  const { setCoordinationEnabled } = await import(source('coordination/supervision.ts'));
  const { coordinationRuntime } = await import(source('coordination/requests.ts'));
  const { assertLegacyWorkOpen } = await import(source('security/legacy-work.ts'));
  const { assertTenant } = await import(source('deployment.ts'));
  assert.equal(coordinationRuntime(), undefined, 'A dispatch runtime must not be configured');

  const overrides = owner => db.prepare("SELECT s.bot_id FROM knowledge_learning_settings s WHERE s.user_id=? AND s.bot_id!='' ORDER BY s.bot_id").all(owner);
  const bots = owner => db.prepare('SELECT id FROM bots WHERE user_id=? ORDER BY id').all(owner);
  function accountOpen(owner) {
    assertTenant(owner);
    assertLegacyWorkOpen(owner);
    assert.ok(db.prepare('SELECT 1 FROM users WHERE id=?').get(owner), 'Account disappeared');
    for (const { bot_id } of overrides(owner)) {
      assert.ok(db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(bot_id, owner), 'Orphan/foreign Bot override; reconcile while stopped');
    }
  }
  function patchEnabled(owner, enabled, botId) {
    const current = learningSettings(owner, botId);
    // null is supported by the domain service for a Bot override: delete only
    // this key. An empty settings object would reset ALL Bot overrides.
    patchLearningSettings(owner, {
      ...(botId ? { botId } : {}), expectedRevision: current.revision,
      settings: { enabled },
    });
  }
  function verify(owner, enabled) {
    accountOpen(owner);
    assert.equal(learningSettings(owner).settings.enabled, enabled, 'Wrong account enabled setting');
    for (const { id } of bots(owner)) assert.equal(learningSettings(owner, id).settings.enabled, enabled, 'Wrong effective enabled setting for ' + id);
    for (const { bot_id } of overrides(owner)) {
      const own = learningSettings(owner, bot_id).overrides;
      if (enabled) assert.ok(!Object.hasOwn(own, 'enabled'), 'Enabled cohort must inherit the account flag');
      else assert.equal(own.enabled, false, 'Existing Bot override must not bypass the disabled account');
    }
    assert.equal(db.prepare('SELECT enabled FROM coordination_supervision WHERE user_id=?').get(owner)?.enabled, Number(enabled), 'Wrong Quinn supervision setting');
  }
  // Nested domain transactions use savepoints. A revision/ownership/hold or
  // verification failure rolls back the ENTIRE requested batch. No async work
  // is performed between taking the write lock and completing verification.
  db.transaction(() => {
    for (const owner of owners) accountOpen(owner);
    if (mode === 'disable' || mode === 'enable') {
      const enabled = mode === 'enable';
      for (const owner of owners) {
        patchEnabled(owner, enabled);
        for (const { bot_id } of overrides(owner)) patchEnabled(owner, enabled ? null : false, bot_id);
        setCoordinationEnabled(owner, enabled);
      }
    }
    for (const owner of owners) verify(owner, mode === 'enable' || mode === 'verify-enabled');
  }).immediate();
  console.log(JSON.stringify({ mode, owners, verified: true, dispatchRuntime: false }));
} finally { if (db?.open) db.close(); }
```

Example invocation after saving the block as `.context/hermes-build/offline-rollout.mjs` (replace paths/IDs with reviewed values; keep the existing role/tenant environment):

```sh
SWARM_NO_SCHEDULER=1 DB_PATH=/reviewed/offline/account.db \
  ROLLOUT_MODE=disable ROLLOUT_OWNER_IDS='["usr_REVIEWED_ACCOUNT"]' \
  node --import tsx .context/hermes-build/offline-rollout.mjs
```

Run `verify-disabled` as a separate process immediately before permitting startup. A nonzero exit, missing receipt, held owner, schema-fence mismatch or wrong effective value leaves the destination offline. Do not turn `SWARM_NO_SCHEDULER=1` into a production cohort flag: it also disables existing routines/jobs/messaging processing. Once settings are persisted and verified, normal startup can restore the deployment's usual scheduler configuration.

## New accounts and selected cohort

For a new isolated account, create its destination database and owner identity through the existing provisioning/bootstrap path **without starting or exposing the tenant**. Run `disable` and then `verify-disabled` after identity/Bot/override creation, before publishing readiness or admitting requests; zero-Bot accounts work. An account disabled this way also disables future Bots that inherit account settings. Provisioning must reject or re-seal any newly written Bot `enabled:true` override while that account remains outside the cohort. This note supplies an offline release procedure, not an already-wired provisioning hook. In a shared standalone deployment, do this under the same maintenance/quiescence boundary and reconcile the initial disable inventory against every existing owner; creating a live account and patching it later leaves the original race. Keep new-account exposure stopped until its pre-start gate is in place.

When authorized, run `enable` with **only selected account IDs** (and subsequently `verify-enabled`) while still offline. This deliberately enables all owned Bots in those selected accounts, clearing only their `enabled` override with `null`; all other override/account keys, including `automaticReview`, intervals, approval preferences, curator choices and limits, stay unchanged. Do not use `settings:{}`. If a Bot must remain excluded, leave its explicit `enabled:false` in place and adapt the selected verification inventory accordingly rather than claiming the all-Bots-enabled receipt. Retain the pre-rollout settings inventory if prior intentional per-Bot enabled values must be restored. Never pass the entire database owner list to `enable` merely because it was used for the initial disable operation.

Migration-held targets fail before domain schema imports and receive no settings writes. Do not release or overwrite their holds to complete rollout; leave them stopped and use the existing authorized migration/reconciliation process. A hold/schema change discovered later also fails the transaction/startup verification. Valid holds for other owners remain enforced by existing backfill/write fences.

## Import and disposable verification

Domain imports initialize local SQLite schemas and may perform existing guarded backfills; this is not a read-only database script. Direct supervision import transitively loads state/workflow definitions, jobs, goals, subagent definitions, CLI preference storage and the event module, but never configures/starts their runtimes. Settings changes append native events and schedule local microtask fanout; this offline process has no listener/server. No model/provider calls or external actions are needed.

The exact JavaScript block was extracted to `.context/hermes-build/offline-rollout.mjs` and tested by `.context/hermes-build/verify-rollout-snippet.mjs` against a disposable SQLite database. The fixture tested disable, separate-process verification, selected enable with `null` deletion of only the Bot `enabled` key, preservation of other preferences, a zero-Bot new account, a later inherited Bot, detection/re-sealing of a later explicit `enabled:true` override, and held/unknown mixed-owner batches failing before writes. It also checked unchanged authoritative state during verification and zero jobs/reviews/coordination requests after all commands.

Static value-import graph: **28 local modules**, with no `tenant-app.ts`, `agent/loop.ts`, `agent/learning.ts`, delivery dispatcher or runtime supervisor. Dynamic tests replaced fetch, interval creation and HTTP listen with throwing sentinels; no sentinel fired and the coordination dispatch runtime remained unconfigured. Imports do perform the documented local schemas/backfills. Log: `.context/hermes-build/rollout-snippet-verification.log`.

The verification helper and log are workspace evidence, not shipped application entry points. This fixture proves offline seeding/verification mechanics, not actual staging readiness or integration of the procedure into provisioning. See [integrated qualification](hermes-build-qualification.md) for the application test results.
