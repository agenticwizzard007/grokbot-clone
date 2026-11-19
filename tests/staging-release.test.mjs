import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRelease } from '../scripts/staging-preflight.mjs';
import { runtimeImage } from '../scripts/resolve-staging-image.mjs';
const candidate = 'a'.repeat(40), main = 'b'.repeat(40), live = 'c'.repeat(40);
function fixture(overrides = {}) {
  const calls = [];
  return { calls, input: { revision: candidate, branch: 'main',
    github: async endpoint => {
      calls.push(endpoint);
      // Candidates are main pushes: the branch head is the candidate unless a newer push superseded it.
      if (endpoint === 'git/ref/heads/main') return { object: { sha: overrides.head ?? candidate } };
      if (endpoint.startsWith(`compare/${main}`)) return { status: overrides.mainStatus ?? 'ahead' };
      if (endpoint.startsWith(`compare/${live}`)) return { status: overrides.liveStatus ?? 'ahead' };
      throw Error('Unexpected request: ' + endpoint);
    }, liveVersion: async () => overrides.version ?? { revision: live },
  } };
}
test('release retains both the latest main and previously deployed feature work', async () => {
  const { calls, input } = fixture();
  assert.deepEqual(await checkRelease(input), { deploy: true, revision: candidate, main: candidate, previousRevision: live });
  assert.ok(calls.includes(`compare/${live}...${candidate}`));
});
test('superseded queued pushes never deploy', async () => {
  const { calls, input } = fixture({ head: 'd'.repeat(40) });
  assert.equal((await checkRelease(input)).deploy, false);
  assert.equal(calls.length, 1);
});
test('a candidate that is no longer the main head never releases', async () => {
  const { calls, input } = fixture({ head: main });
  assert.deepEqual(await checkRelease(input), { deploy: false, revision: candidate, reason: 'Superseded by a newer branch push' });
  assert.equal(calls.length, 1);
});
test('an older main or divergent branch cannot remove live features', async () => {
  for (const liveStatus of ['behind', 'diverged']) await assert.rejects(checkRelease(fixture({ liveStatus }).input), /omits live changes/);
});
test('only main may release: feature and personal branches are refused before any comparison', async () => {
  for (const branch of ['agenticwizzard007/hermes-integration-strategy', 'feature/x']) {
    const { calls, input } = fixture(); input.branch = branch;
    await assert.rejects(checkRelease(input), /Only main may deploy/);
    assert.equal(calls.length, 0);
  }
});
test('an off-main live revision is replaced only with the explicit dispatch override, and main changes are still required', async () => {
  await assert.rejects(checkRelease(fixture({ liveStatus: 'diverged' }).input), /allow_live_replacement/);
  const { input } = fixture({ liveStatus: 'diverged' }); input.allowLiveReplacement = true;
  assert.equal((await checkRelease(input)).deploy, true);
});
test('merged main may release when it retains the live revision', async () => {
  const { input } = fixture();input.branch = 'main';input.revision = main;
  input.github = async endpoint => endpoint === 'git/ref/heads/main' ? { object: { sha: main } } : { status: 'ahead' };
  assert.equal((await checkRelease(input)).deploy, true);
});
test('missing release identity and failed live reads stop deployment', async () => {
  await assert.rejects(checkRelease(fixture({ version: {} }).input), /Live release identity/);
  const { input } = fixture();input.liveVersion = async () => { throw Error('Live endpoint offline'); };
  await assert.rejects(checkRelease(input), /offline/);
});
test('manual dispatch from unrelated branches or a symbolic revision is rejected', async () => {
  const { input } = fixture();
  await assert.rejects(checkRelease({ ...input, branch: 'experimental' }), /Only main may deploy/);
  await assert.rejects(checkRelease({ ...input, revision: 'HEAD' }), /exact source revision/);
});

const indexRef = 'registry.fly.io/swarm-team@sha256:' + '1'.repeat(64);
const amd64 = { digest: 'sha256:' + '2'.repeat(64), platform: { os: 'linux', architecture: 'amd64' } };
test('OCI provenance indexes resolve to the exact image Fly actually runs', () => {
  const manifest = { schemaVersion: 2, manifests: [
    { digest: 'sha256:' + '3'.repeat(64), platform: { os: 'unknown', architecture: 'unknown' } },
    { digest: 'sha256:' + '4'.repeat(64), platform: { os: 'linux', architecture: 'arm64' } },
    amd64,
  ] };
  assert.equal(runtimeImage(indexRef, manifest), 'registry.fly.io/swarm-team@' + amd64.digest);
});
test('single-platform manifests preserve their immutable reference', () => {
  assert.equal(runtimeImage(indexRef, { schemaVersion: 2, config: { digest: 'sha256:' + '5'.repeat(64) }, layers: [] }), indexRef);
});
test('missing or ambiguous platform images and foreign registries are rejected', () => {
  assert.throws(() => runtimeImage(indexRef, { schemaVersion: 2, manifests: [] }), /exactly one/);
  assert.throws(() => runtimeImage(indexRef, { schemaVersion: 2, manifests: [amd64, amd64] }), /exactly one/);
  assert.throws(() => runtimeImage(indexRef.replace('swarm-team', 'other-app'), { schemaVersion: 2 }));
  assert.throws(() => runtimeImage(indexRef, { schemaVersion: 2 }), /not an image/);
});
