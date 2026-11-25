import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProviders } from '../companion/cli-bridge.mjs';

for (const state of ['never set up', 'signed out', 'error', 'connected'] as const) {
  test(`hosted Claude status maps ${state} without borrowing Codex state`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-claude-status-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = join(root, '.claude'), cli = join(root, 'cli');
    if (state !== 'never set up') await mkdir(config);
    if (state === 'error' || state === 'connected') await writeFile(join(config, '.credentials.json'), '{}');
    // A hosted startup failure on a fresh profile previously became unavailable.
    const output = state === 'never set up' || state === 'error' ? 'Profile not initialized' : JSON.stringify({
      loggedIn: state === 'connected', authMethod: state === 'connected' ? 'claude.ai' : 'none', subscriptionType: state === 'connected' ? 'max' : null,
    });
    await writeFile(cli, `#!${process.execPath}\nif (process.argv[2] === 'login') { console.log('Logged in using ChatGPT'); } else { console.log(${JSON.stringify(output)}); process.exit(${state === 'connected' ? 0 : 1}); }`, { mode: 0o700 });
    const status = await checkProviders({ codexPath: cli, claudePath: cli, fileCredentials: true,
      env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: config } });
    assert.equal(status.codex.authenticated, true);
    assert.equal(status.claude.authenticated, state === 'connected');
    assert.equal(status.claude.subscription, state === 'connected');
    assert.equal(status.claude.hasSavedState, state === 'error' || state === 'connected');
    if (state === 'error') assert.match(status.claude.error, /Status unavailable/);
    else assert.equal(status.claude.error, undefined);
  });
}

test('bridge and generation probes do not assume hosted file credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-claude-bridge-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'cli');
  await writeFile(cli, `#!${process.execPath}\nconsole.log('Invalid status');process.exit(1);`, { mode: 0o700 });
  const status = await checkProviders({ codexPath: cli, claudePath: cli, env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'missing') } });
  assert.match(status.claude.error, /Status unavailable/);
  assert.equal(status.claude.hasSavedState, undefined);
});

test('a missing Claude install preserves evidence of saved hosted credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-claude-missing-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.credentials.json'), '{}');
  const status = await checkProviders({ codexPath: '/missing/codex', claudePath: '/missing/claude', fileCredentials: true,
    env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: root } });
  assert.equal(status.claude.installed, false);
  assert.equal(status.claude.hasSavedState, true);
  assert.equal(status.claude.authenticated, false);
});
