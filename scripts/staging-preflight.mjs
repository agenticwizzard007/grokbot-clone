import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const releaseBranches = ['main'];
export const repository = 'agenticwizzard007/grokbot-clone';
export const stagingOrigin = 'https://swarm-team.fly.dev';

/** A newer timestamp is insufficient: releases must retain main and the live revision. */
export async function checkRelease({ revision, branch, github, liveVersion, allowLiveReplacement = false, skipIfCurrent = false, queueLatest }) {
  assert.match(revision ?? '', /^[a-f0-9]{40}$/, 'An exact source revision is required');
  assert.ok(releaseBranches.includes(branch), 'Only main may deploy staging');
  const head = await github(`git/ref/heads/${branch}`);
  if (head.object.sha !== revision) {
    const tip = head.object.sha;
    assert.match(tip ?? '', /^[a-f0-9]{40}$/, 'Main release identity is unavailable');
    const { workflow_runs: runs } = await github(`actions/workflows/staging.yml/runs?branch=main&head_sha=${tip}&per_page=100`);
    assert.ok(Array.isArray(runs), 'Unable to inspect pending staging deployments');
    const pending = runs.find(run => run.head_sha === tip &&
      ['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(run.status));
    if (pending) return { deploy: false, revision, tip, replacementRun: pending.id, reason: 'Current main already has a pending staging deploy' };
    // A skip-CI marker can prevent the new push from creating any run. Never
    // abandon this checkout until dispatching a replacement has succeeded.
    assert.equal(typeof queueLatest, 'function', 'A replacement staging deploy must be queued');
    await queueLatest();
    return { deploy: false, revision, tip, reason: 'Dispatched current main before skipping superseded checkout' };
  }
  const main = await github('git/ref/heads/main');
  const live = await liveVersion();
  assert.match(live.revision ?? '', /^[a-f0-9]{40}$/, 'Live release identity is unavailable; refusing an unverified replacement');
  for (const [label, base] of [['main', main.object.sha], ['live', live.revision]]) {
    assert.match(base, /^[a-f0-9]{40}$/);
    if (base === revision) continue;
    const comparison = await github(`compare/${base}...${revision}`);
    if (label === 'live' && allowLiveReplacement && !['ahead', 'identical'].includes(comparison.status)) {
      // A reviewed manual release left production off main; the operator explicitly accepted replacing it.
      console.error(`Replacing live revision ${base} that is not an ancestor of ${revision} (allow_live_replacement)`);
      continue;
    }
    assert.ok(['ahead', 'identical'].includes(comparison.status), `Candidate omits ${label} changes (${base}); merge them before deployment${label === 'live' ? ', or dispatch with allow_live_replacement after review' : ''}`);
  }
  if (skipIfCurrent && live.revision === revision) return { deploy: false, revision, reason: 'Scheduled check: main is already live' };
  return { deploy: true, revision, main: main.object.sha, previousRevision: live.revision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_REPOSITORY ?? repository, repository, 'Wrong deployment repository');
  const revision = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const branch = process.env.GITHUB_REF_NAME || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), revision, 'Checkout is not the requested revision');
  execFileSync('git', ['diff', '--exit-code', 'HEAD'], { stdio: 'inherit' });
  const result = await checkRelease({ revision, branch, allowLiveReplacement: process.env.ALLOW_LIVE_REPLACEMENT === 'true',
    skipIfCurrent: process.env.GITHUB_EVENT_NAME === 'schedule',
    queueLatest: async () => {
      execFileSync('gh', ['api', '--method', 'POST', `repos/${repository}/actions/workflows/staging.yml/dispatches`, '-f', 'ref=main'], { encoding: 'utf8', timeout: 30000 });
    },
    // Compare responses include entire patches; select metadata inside gh so
    // large integrations cannot exhaust the child-process output buffer.
    github: async endpoint => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${endpoint}`, '--jq', '{object: {sha: .object.sha}, status: .status, workflow_runs: (if .workflow_runs then [.workflow_runs[] | {id, head_sha, status}] else null end)}'], { encoding: 'utf8', timeout: 30000 })),
    liveVersion: async () => {
      const response = await fetch(`${stagingOrigin}/api/version`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200, 'Live version endpoint is unavailable');
      return response.json();
    },
  });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${result.deploy}\nrevision=${result.revision}\n`);
  console.log(JSON.stringify(result, null, 2));
}
