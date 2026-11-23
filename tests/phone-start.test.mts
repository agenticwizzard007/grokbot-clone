import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePhoneStart, PHONE_START_UNAVAILABLE } from '../server/src/messaging/phone-start.js';
import { configApi } from '../web/src/lib/configApi.ts';
import { ApiError } from '../web/src/lib/api.ts';

const line = { number: '+15550000100', connectCommand: 'connect @swarm', smsLink: 'sms:+15550000100?&body=connect%20%40swarm' };
const sent = { id: 'test-attempt', delivery: 'sent', textNumber: null, line: null };
const first = { ...sent, delivery: 'text-first', line };

test('P-04: both browser start methods reject incomplete delivery contracts and preserve recoverable errors', async t => {
  for (const start of [configApi.phoneStart, configApi.phoneAttachStart]) {
    for (const body of [null, {}, { id: 'legacy', line }, { ...first, line: null }, { ...first, line: { number: line.number } },
      { ...first, line: { ...line, connectCommand: 'connect @' } }, { ...first, line: { ...line, smsLink: `sms:${line.number}` } },
      { ...first, id: '' }, { ...first, textNumber: 'unknown', line: null }]) {
      const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(body));
      await assert.rejects(start('+15550000200'), e => e instanceof ApiError && e.status === 503 && e.message === PHONE_START_UNAVAILABLE);
      fetch.mock.restore();
    }
    for (const body of [sent, first, { ...first, textNumber: '+15550000300', line: null }]) {
      const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(body));
      assert.deepEqual(await start('+15550000200'), parsePhoneStart(body));
      fetch.mock.restore();
    }
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: PHONE_START_UNAVAILABLE }, { status: 503 }));
    await assert.rejects(start('+15550000200'), e => e instanceof ApiError && e.status === 503);
    fetch.mock.restore();
  }
});

test('P-04: platform sign-in and attach require delivery or complete first-contact instructions', async t => {
  process.env.SESSION_SECRET = 'phone-start-local-fixture-secret-0000';
  const { platformMessaging } = await import('../server/src/platform/messaging.js');
  const { InkboxError } = await import('../server/src/messaging/inkbox/client.js');
  for (const route of ['/api/auth/phone/start', '/api/messaging/phone/start']) {
    for (const scenario of ['unconfigured', 'no-line', 'partial-line', 'line-error', 'first-contact', 'sent', 'send-failed', 'no-receipt', 'awaiting', 'awaiting-router', 'awaiting-no-line']) {
      await t.test(`${route}: ${scenario}`, async () => {
        const attempts = new Set<string>();
        let sends = 0, lookups = 0;
        const known = ['sent', 'send-failed', 'no-receipt', 'awaiting', 'awaiting-router', 'awaiting-no-line'].includes(scenario);
        const directory = {
          session: async () => ({ hash: 'local-session', authenticated_at: new Date() }),
          pool: { query: async (sql: string, params: unknown[] = []) => {
            if (sql.startsWith('INSERT INTO platform_rate_windows')) return { rows: [{ hits: 1 }] };
            if (sql.startsWith('INSERT INTO phone_attempts')) attempts.add(String(params[0]));
            else if (sql.startsWith('DELETE FROM phone_attempts WHERE hash=')) attempts.delete(String(params[0]));
            else if (sql.startsWith('SELECT * FROM messaging_routes')) return { rows: known ? [{ channel: 'imessage', conversation_id: 'local-thread' }] : [] };
            else if (!sql.startsWith('DELETE FROM phone_attempts') && !sql.startsWith('DELETE FROM platform_rate_windows')) throw new Error('Unexpected fixture query');
            return { rows: [] };
          } },
        };
        const provider = {
          ready: () => scenario !== 'unconfigured', verify: () => false,
          line: async () => {
            lookups++;
            if (['line-error', 'sent', 'awaiting'].includes(scenario)) throw new Error('Local line lookup unavailable');
            return ['no-line', 'awaiting-no-line'].includes(scenario) ? null : scenario === 'partial-line' ? { number: line.number } : line;
          },
          send: async () => {
            sends++;
            if (scenario === 'send-failed') throw new Error('Local provider unavailable');
            if (scenario.startsWith('awaiting')) throw new InkboxError(409, 'imessage_awaiting_inbound', scenario === 'awaiting' ? 'They must text +15550000300 before the agent can reply.' : 'First contact required.');
            return scenario === 'no-receipt' ? null : 'local-receipt';
          },
        };
        const app = platformMessaging(directory as any, {} as any, {} as any, () => {}, provider);
        const response = await app.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '+15550000200' }) });
        const body = await response.json() as any;
        const success = ['first-contact', 'sent', 'awaiting', 'awaiting-router'].includes(scenario);
        assert.equal(response.status, success ? 200 : 503);
        assert.equal(attempts.size, success ? 1 : 0, 'unavailable starts leave no usable challenge');
        assert.equal(response.headers.has('set-cookie'), success);
        if (success) {
          assert.deepEqual(parsePhoneStart(body), body);
          assert.equal(body.delivery, scenario === 'sent' ? 'sent' : 'text-first');
          if (scenario === 'first-contact') { assert.equal(body.line.connectCommand, line.connectCommand); assert.equal(sends, 0); }
          else if (scenario !== 'awaiting-router') assert.equal(lookups, 0, 'confirmed sends and direct thread instructions do not need router lookup');
        } else {
          assert.deepEqual(body, { error: PHONE_START_UNAVAILABLE });
          assert.equal(body.id, undefined);
        }
      });
    }
  }
});

test('P-04: the platform provider preserves the first-contact response from a mocked backend', async t => {
  const { inkboxMessenger } = await import('../server/src/platform/messaging.js');
  const { awaitingInbound } = await import('../server/src/messaging/inkbox/client.js');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: { error: 'imessage_awaiting_inbound', message: 'They must text +15550000300 before the agent can reply.' } }, { status: 409 }));
  await assert.rejects(inkboxMessenger.send('imessage', { phone: '15550000200' }, { text: 'Local fixture' }, 'local-dispatch'), e => {
    assert.deepEqual(awaitingInbound(e), { awaiting: true, textNumber: '+15550000300' });
    return true;
  });
});
