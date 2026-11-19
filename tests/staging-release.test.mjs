import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRelease } from '../scripts/staging-preflight.mjs';
const candidate = 'a'.repeat(40), main = 'b'.repeat(40), live = 'c'.repeat(40);
function fixture(overrides = {}) {
  const calls = [];
  return { calls, input: { revision: candidate, branch: 'agenticwizzard007/hermes-integration-strategy',
    github: async endpoint => {
      calls.push(endpoint);
      if (endpoint === 'git/ref/heads/main') return { object: { sha: main } };
      if (endpoint.startsWith('git/ref/heads/')) return { object: { sha: overrides.head ?? candidate } };
      if (endpoint.startsWith(`compare/${main}`)) return { status: overrides.mainStatus ?? 'ahead' };
      if (endpoint.startsWith(`compare/${live}`)) return { status: overrides.liveStatus ?? 'ahead' };
      throw Error('Unexpected request: ' + endpoint);
    }, liveVersion: async () => overrides.version ?? { revision: live },
  } };
}
test('release retains both the latest main and previously deployed feature work', async () => {
  const { calls, input } = fixture();
  assert.deepEqual(await checkRelease(input), { deploy: true, revision: candidate, main, previousRevision: live });
  assert.ok(calls.includes(`compare/${main}...${candidate}`));
  assert.ok(calls.includes(`compare/${live}...${candidate}`));
});
test('superseded queued pushes never deploy', async () => {
  const { calls, input } = fixture({ head: 'd'.repeat(40) });
  assert.equal((await checkRelease(input)).deploy, false);
  assert.equal(calls.length, 1);
});
test('a branch missing newer main changes cannot release', async () => {
  await assert.rejects(checkRelease(fixture({ mainStatus: 'diverged' }).input), /omits main changes/);
});
test('an older main or divergent branch cannot remove live features', async () => {
  for (const liveStatus of ['behind', 'diverged']) await assert.rejects(checkRelease(fixture({ liveStatus }).input), /omits live changes/);
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
  await assert.rejects(checkRelease({ ...input, branch: 'experimental' }), /Only integration\/main/);
  await assert.rejects(checkRelease({ ...input, revision: 'HEAD' }), /exact source revision/);
});
