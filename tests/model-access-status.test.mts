import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelAccessStatus } from '../web/src/lib/modelAccessStatus.ts';
import type { CliProvider, CliStatus } from '../web/src/lib/cliApi.ts';

const ready = { installed: true, authenticated: true, subscription: true };
const signedOut = { installed: true, authenticated: false, subscription: false };
const fixture = (selected: CliProvider | null, claude: boolean, codex: boolean): CliStatus => ({
  runtime: 'server', serverLoginAvailable: true, selected, connected: true, device: null,
  providers: { claude: { ...(claude ? ready : signedOut) }, codex: { ...(codex ? ready : signedOut) } },
});

test('Models access: Codex connected and Claude not connected', () => {
  const status = fixture('codex', false, true);
  const claude = modelAccessStatus(status, 'claude');
  assert.equal(claude.connection, 'Not connected');
  assert.equal(claude.currentlyInUse, false);
  assert.equal(claude.action, 'Connect Claude plan');
  assert.equal(claude.details, 'Claude Code installed · Not signed in · Eligible plan not confirmed');
  assert.equal(claude.currentRoute, 'Your Bots currently use your ChatGPT plan through Codex; connect your Claude plan to switch.');
  assert.equal(modelAccessStatus(status, 'codex').connection, 'Connected');
  assert.equal(modelAccessStatus(status, 'codex').currentlyInUse, true);
});

test('Models access: Claude connected and Codex not connected', () => {
  const status = fixture('claude', true, false);
  const codex = modelAccessStatus(status, 'codex');
  assert.equal(codex.connection, 'Not connected');
  assert.equal(codex.currentlyInUse, false);
  assert.equal(codex.action, 'Connect ChatGPT plan');
  assert.equal(codex.details, 'Codex installed · Not signed in · Eligible plan not confirmed');
  assert.equal(codex.currentRoute, 'Your Bots currently use your Claude plan through Claude Code; connect your ChatGPT plan to switch.');
  assert.equal(modelAccessStatus(status, 'claude', false, 'max_5x').details, 'Claude Code installed · Signed in · Plan: max 5x');
});

test('Models access: both connected, only the selected plan is currently in use', () => {
  for (const selected of ['claude', 'codex'] as const) {
    const status = fixture(selected, true, true);
    for (const provider of ['claude', 'codex'] as const) {
      const tab = modelAccessStatus(status, provider);
      assert.equal(tab.connection, 'Connected');
      assert.equal(tab.currentlyInUse, provider === selected);
      assert.equal(tab.action, `Use ${provider === 'claude' ? 'Claude' : 'ChatGPT'} plan`);
      if (provider !== selected) assert.match(tab.currentRoute, /; choose Use (Claude|ChatGPT) plan to switch\.$/);
    }
  }
});

test('Models access: neither CLI connected never inherits the runtime connection', () => {
  for (const provider of ['claude', 'codex'] as const) {
    const tab = modelAccessStatus(fixture(null, false, false), provider);
    assert.equal(tab.connection, 'Not connected');
    assert.equal(tab.currentlyInUse, false);
    assert.match(tab.currentRoute, /^Your Bots currently use API providers;/);
  }
});

test('Models access: API providers selected retain each CLI sign-in without claiming plan use', () => {
  const status = fixture(null, true, true);
  for (const provider of ['claude', 'codex'] as const) {
    const tab = modelAccessStatus(status, provider);
    assert.equal(tab.connection, 'Connected');
    assert.equal(tab.currentlyInUse, false);
    assert.match(tab.currentRoute, /^Your Bots currently use API providers; choose Use/);
  }
});

test('Models access: missing CLI, ineligible login and offline bridge cannot show connected', () => {
  const status = fixture('claude', false, true);
  status.providers.claude.installed = false;
  assert.match(modelAccessStatus(status, 'claude').details, /Claude Code not installed/);
  assert.match(modelAccessStatus(status, 'codex').currentRoute, /connection is not ready/);
  status.providers.claude = { ...ready, subscription: false, error: 'Eligible plan required' };
  assert.equal(modelAccessStatus(status, 'claude').connection, 'Not connected');
  assert.match(modelAccessStatus(status, 'claude').details, /Signed in · Eligible plan not confirmed/);
  status.runtime = 'bridge'; status.connected = false;
  for (const provider of ['claude', 'codex'] as const) {
    assert.equal(modelAccessStatus(status, provider).connection, 'Not connected');
    assert.match(modelAccessStatus(status, provider).details, /computer bridge is offline/);
    assert.doesNotMatch(modelAccessStatus(status, provider).details, /not installed/);
  }
});

test('Models access: unavailable and pending probes never invent a connection or active route', () => {
  assert.equal(modelAccessStatus(null, 'claude').connection, 'Checking status…');
  const status = fixture('codex', false, true);
  for (const provider of ['claude', 'codex'] as const) {
    for (const tab of [modelAccessStatus(status, provider, true), modelAccessStatus({ ...status, statusUnavailable: true }, provider)]) {
      assert.equal(tab.connection, 'Status unavailable');
      assert.equal(tab.currentlyInUse, false);
      assert.doesNotMatch(tab.currentRoute, /currently use/);
    }
  }
  status.providers.codex.error = 'Probe failed';
  assert.equal(modelAccessStatus(status, 'codex').connection, 'Status unavailable');
  assert.doesNotMatch(modelAccessStatus(status, 'claude').currentRoute, /currently use/);
  status.providers.codex = { ...signedOut };
  status.statusChecking = true;
  assert.equal(modelAccessStatus(status, 'codex').connection, 'Checking status…');
  assert.match(modelAccessStatus(status, 'claude').currentRoute, /connection is being checked/);
});

test('Claude never set up or missing has a neutral connection and no saved controls', () => {
  for (const health of [
    { ...signedOut, hasSavedState: false },
    { ...signedOut, hasSavedState: false, error: 'Status unavailable. Retry.' },
    { installed: false, authenticated: false, subscription: false, error: 'CLI executable is not installed.' },
  ]) {
    const status = fixture('codex', false, true);
    status.providers.claude = health;
    const tab = modelAccessStatus(status, 'claude');
    assert.equal(tab.connection, 'Not connected');
    assert.equal(tab.action, 'Connect Claude plan');
    assert.equal(tab.hasSavedState, false);
    assert.equal(tab.probeFailed, false);
    assert.doesNotMatch(tab.details, /could not be verified/);
    assert.equal(modelAccessStatus(status, 'codex').currentlyInUse, true);
  }
});

test('Claude signed out, real probe error and connected retain their own saved state', () => {
  const status = fixture('codex', false, true);
  status.providers.claude = { ...signedOut, hasSavedState: true };
  assert.equal(modelAccessStatus(status, 'claude').connection, 'Not connected');
  assert.equal(modelAccessStatus(status, 'claude').hasSavedState, true);
  status.providers.claude.error = 'Status unavailable. Retry.';
  assert.equal(modelAccessStatus(status, 'claude').connection, 'Status unavailable');
  assert.equal(modelAccessStatus(status, 'claude').probeFailed, true);
  status.providers.claude = { ...ready, hasSavedState: true };
  assert.equal(modelAccessStatus(status, 'claude').connection, 'Connected');
  assert.equal(modelAccessStatus(status, 'claude').currentlyInUse, false);
});


test('a selected route without saved CLI state does not offer reset on either tab', () => {
  for (const provider of ['claude', 'codex'] as const) {
    const status = fixture(provider, false, false);
    status.providers[provider].hasSavedState = false;
    assert.equal(modelAccessStatus(status, provider).hasSavedState, false);
    status.providers[provider].hasSavedState = true;
    assert.equal(modelAccessStatus(status, provider).hasSavedState, true);
    assert.equal(modelAccessStatus(status, provider === 'claude' ? 'codex' : 'claude').hasSavedState, false);
  }
});
