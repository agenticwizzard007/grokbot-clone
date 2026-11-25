import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { retryCommand } from './retry-staging-command.mjs';

export async function snapshotStagingVolume({ run, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console.error, save = () => {}, timeoutMs = 15 * 60_000 }) {
  const deadline = now() + timeoutMs;
  const command = args => {
    assert.ok(now() < deadline, 'Volume snapshot deadline reached; deployment stopped');
    return run([...args, '-a', 'swarm-team'], Math.min(60_000, deadline - now()));
  };
  const read = args => retryCommand(() => command(args), { sleep: ms => sleep(Math.min(ms, Math.max(0, deadline - now()))), log });
  const volumes = JSON.parse(await read(['volumes', 'list', '--json'])).filter(v => v.name === 'swarm_data' && v.attached_machine_id);
  assert.equal(volumes.length, 1, 'Expected the existing single staging data volume');
  const volume = volumes[0].id;
  const list = async () => JSON.parse(await read(['volumes', 'snapshots', 'list', volume, '--json']));
  // Even a pending snapshot from a previous deploy is too old for this backup.
  const previous = new Set((await list()).map(s => s.id));
  let requested = false, createFailures = 0, lastError, lastSnapshots = [];
  while (now() < deadline) {
    try {
      lastSnapshots = await list();
      const fresh = lastSnapshots.filter(s => !previous.has(s.id));
      const snapshot = fresh.find(s => s.status === 'created');
      if (snapshot) {
        save({ volume, snapshot });
        log(`Backup completed: ${snapshot.id}`);
        return { volume, snapshot };
      }
      // A failed create response may still have queued the snapshot. Poll that
      // snapshot instead of creating duplicates. Never accept an older backup.
      if (fresh.some(s => !['failed', 'deleted'].includes(s.status))) requested = true;
      if (requested && fresh.length && fresh.every(s => s.status === 'failed')) {
        for (const s of fresh) previous.add(s.id);
        requested = false;
        createFailures++;
      }
      save({ volume, pending: true, snapshots: lastSnapshots, createFailures });
      if (!requested) {
        assert.ok(createFailures < 3, 'Snapshot creation failed after 3 attempts; deployment stopped');
        try {
          await command(['volumes', 'snapshots', 'create', volume]);
          requested = true;
        } catch (error) {
          lastError = error;
          const detail = `${error.message ?? ''} ${error.stderr ?? ''}`;
          // The previous run can still own the volume's one snapshot slot.
          // Wait for it, then request a new backup of this deployment's state.
          if (!/on-demand snapshot is pending/i.test(detail)) createFailures++;
          log(`Snapshot request not ready (${createFailures} failed attempts); polling before retry`);
        }
      }
    } catch (error) {
      lastError = error;
      if (createFailures >= 3) throw error;
      log('Snapshot status read failed after retries; checking again before the deadline');
    }
    await sleep(Math.min(10_000, Math.max(0, deadline - now())));
  }
  save({ volume, pending: true, snapshots: lastSnapshots, createFailures, timedOut: true });
  throw new Error(`Volume snapshot did not complete within ${timeoutMs / 60_000} minutes; deployment stopped`, { cause: lastError });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidence = '.context/staging-release/volume-snapshot.json';
  fs.mkdirSync('.context/staging-release', { recursive: true });
  await snapshotStagingVolume({
    run: (args, timeout) => execFileSync('flyctl', args, { encoding: 'utf8', timeout }),
    save: value => fs.writeFileSync(evidence, JSON.stringify(value, null, 2)),
  });
}
