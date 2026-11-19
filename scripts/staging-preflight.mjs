import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const releaseBranches = ['main', 'agenticwizzard007/hermes-integration-strategy'];
export const repository = 'agenticwizzard007/grokbot-clone';
export const stagingOrigin = 'https://swarm-team.fly.dev';

/** A newer timestamp is insufficient: releases must retain main and the live revision. */
export async function checkRelease({ revision, branch, github, liveVersion }) {
  assert.match(revision ?? '', /^[a-f0-9]{40}$/, 'An exact source revision is required');
  assert.ok(releaseBranches.includes(branch), 'Only integration/main may deploy staging');
  const head = await github(`git/ref/heads/${branch}`);
  if (head.object.sha !== revision) return { deploy: false, revision, reason: 'Superseded by a newer branch push' };
  const main = await github('git/ref/heads/main');
  const live = await liveVersion();
  assert.match(live.revision ?? '', /^[a-f0-9]{40}$/, 'Live release identity is unavailable; refusing an unverified replacement');
  for (const [label, base] of [['main', main.object.sha], ['live', live.revision]]) {
    assert.match(base, /^[a-f0-9]{40}$/);
    if (base === revision) continue;
    const comparison = await github(`compare/${base}...${revision}`);
    assert.ok(['ahead', 'identical'].includes(comparison.status), `Candidate omits ${label} changes (${base}); merge them before deployment`);
  }
  return { deploy: true, revision, main: main.object.sha, previousRevision: live.revision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_REPOSITORY ?? repository, repository, 'Wrong deployment repository');
  const revision = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const branch = process.env.GITHUB_REF_NAME || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), revision, 'Checkout is not the requested revision');
  execFileSync('git', ['diff', '--exit-code', 'HEAD'], { stdio: 'inherit' });
  const result = await checkRelease({ revision, branch,
    github: async endpoint => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${endpoint}`], { encoding: 'utf8', timeout: 30000 })),
    liveVersion: async () => {
      const response = await fetch(`${stagingOrigin}/api/version`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200, 'Live version endpoint is unavailable');
      return response.json();
    },
  });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${result.deploy}\nrevision=${result.revision}\n`);
  console.log(JSON.stringify(result, null, 2));
}
