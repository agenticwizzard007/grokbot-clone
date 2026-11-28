import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Hono } from 'hono';
import { db, cleanup } from './handoffs/server-fixture.test.mts';
import { resolveGoogleAccount } from '../server/src/auth/google.js';
import { createSession } from '../server/src/lib/auth.js';
import { selectCli } from '../server/src/cli/store.js';
import { usageApi } from '../server/src/routes-usage.js';

after(cleanup);
const userId = resolveGoogleAccount({ subject: 'd7-google-fixture', email: 'd7@example.test', name: 'Usage fixture' });
const app = new Hono().route('/api/usage', usageApi);
app.get('/test/session', c => { createSession(c, userId); return c.json({ ok: true }); });
const login = await app.request('/test/session');
const cookie = login.headers.getSetCookie().find(value => value.startsWith('swarm_session='))!.split(';')[0];
const read = () => app.request('/api/usage/summary', { headers: { cookie } });

for (const provider of [null, 'codex', 'claude'] as const) {
  test(`D7 Google session with zero ledger rows has an account summary with ${provider ?? 'API'} selected`, async () => {
    selectCli(userId, provider);
    delete process.env.SWARM_PLAN_LIMIT_USD;
    const response = await read();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const summary = await response.json();
    assert.equal(summary.plan.unit, 'usd');
    assert.equal(summary.plan.billing, 'api');
    assert.equal(summary.plan.usedCents, 0);
    assert.equal(summary.plan.limitCents, null);
    assert.equal(summary.plan.percentUsed, null);
    assert.ok(summary.plan.resetsAt > Date.now());
    assert.equal(summary.ownKeys.usedCents, 0);
    assert.equal(summary.week.planUsedCents, 0);
    assert.ok(summary.week.days.every((day: any) => day.planUsedCents === 0));
    process.env.SWARM_PLAN_LIMIT_USD = '25';
    const limited = await (await read()).json();
    assert.equal(limited.plan.limitCents, 2500);
    assert.equal(limited.plan.percentUsed, 0);
  });
}

test('D7 account allowance counts ledger spend even when a CLI subscription is selected', async () => {
  selectCli(userId, 'codex');
  process.env.SWARM_PLAN_LIMIT_USD = '25';
  db.prepare("INSERT INTO usage_events(user_id,kind,provider,model,cost_usd,key_kind,created_at) VALUES(?,'chat','fixture','fixture',?,'native',?)")
    .run(userId, 5, Date.now());
  const summary = await (await read()).json();
  assert.equal(summary.plan.usedCents, 500);
  assert.equal(summary.plan.limitCents, 2500);
  assert.equal(summary.plan.percentUsed, 20);
  assert.equal((await app.request('/api/usage/summary')).status, 401);
});
