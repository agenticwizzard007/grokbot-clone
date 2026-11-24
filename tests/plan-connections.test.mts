import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planConnectionStatus } from '../web/src/lib/planConnections.ts';
import type { CliStatus } from '../web/src/lib/cliApi.ts';

test('plan status distinguishes unprobed, offline, missing, authenticated and selected CLIs', () => {
  const status: CliStatus = { runtime: 'server', serverLoginAvailable: true, selected: null, connected: true, device: null,
    providers: { claude: { installed: false, authenticated: false, subscription: false }, codex: { installed: true, authenticated: false, subscription: false } } };
  assert.equal(planConnectionStatus(null, 'claude'), 'Checking status…');
  assert.equal(planConnectionStatus({ ...status, connected: false }, 'claude'), 'Not connected');
  assert.equal(planConnectionStatus(status, 'claude'), 'CLI missing');
  assert.equal(planConnectionStatus(status, 'codex'), 'Not connected');
  status.providers.claude = { installed: true, authenticated: true, subscription: true };
  assert.equal(planConnectionStatus(status, 'claude', 'max'), 'Not connected');
  status.selected = 'claude';
  assert.equal(planConnectionStatus(status, 'claude', 'max'), 'Connected as max');
  assert.equal(planConnectionStatus(status, 'claude'), 'Connected');
  status.providers.claude.error = 'CLI unavailable';
  assert.equal(planConnectionStatus(status, 'claude', 'max'), 'Status unavailable');
  status.providers.claude.subscription = false;
  assert.equal(planConnectionStatus(status, 'claude'), 'Not connected', 'an ineligible login needs connection guidance, not a failed-probe retry');
  status.providers.claude.subscription = true;
  delete status.providers.claude.error;
  status.selected = null;
  assert.equal(planConnectionStatus(status, 'claude', 'max'), 'Not connected');
  assert.equal(status.providers.claude.authenticated, true, 'disconnect is a backend selection, not credential deletion');
});


test('pending probes show Checking and signed-out probes show Not connected', () => {
  const status: CliStatus = { runtime: 'server', serverLoginAvailable: true, selected: null, connected: true, device: null,
    providers: { claude: { installed: true, authenticated: false, subscription: false }, codex: { installed: true, authenticated: false, subscription: false } } };
  for (const provider of ['claude', 'codex'] as const) {
    assert.equal(planConnectionStatus({ ...status, statusChecking: true }, provider), 'Checking status…');
    assert.equal(planConnectionStatus(status, provider), 'Not connected');
    assert.equal(planConnectionStatus({ ...status, statusUnavailable: true }, provider), 'Status unavailable');
  }
});
