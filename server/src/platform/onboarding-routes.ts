import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Directory, hashToken, opaqueToken } from './directory.js';
import { admissionCounts, inviteCode, signupLock, validWebInvite } from './onboarding.js';
import { signupPolicy } from './signup.js';
import { requestBoundary } from '../security/request.js';

export function onboardingRoutes(directory: Directory) {
  const app = new Hono();
  for (const route of ['/onboarding', '/waitlist']) app.use(route, requestBoundary, bodyLimit({ maxSize: 2048 }));
  app.onError((_error, c) => c.json({ error: 'Onboarding is unavailable. Please try again.' }, 503));
  app.get('/onboarding', async c => {
    const policy = await signupPolicy(directory.pool), counts = await admissionCounts(directory.pool);
    let code: string | undefined;
    try { code = inviteCode(c.req.query('invite')); }
    catch { return c.json({ platform: true, state: 'invite_invalid' }); }
    const state = counts.current >= counts.limit || policy.signupsPerDay > 0 && counts.today >= policy.signupsPerDay ? 'at_capacity'
      : policy.mode === 'closed' ? 'closed'
      : code ? await validWebInvite(directory.pool, code) ? 'invite_accepted' : 'invite_invalid'
      : policy.mode === 'invite' ? 'invite_needed' : 'open';
    return c.json({ platform: true, state });
  });
  app.post('/waitlist', async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Enter an email address or phone number.' }, 400); }
    const b = body as { contact?: unknown };
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => k !== 'contact') || typeof b.contact !== 'string' || b.contact.length > 254) return c.json({ error: 'Enter an email address or phone number.' }, 400);
    const contact = b.contact.trim().toLowerCase();
    const kind = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? 'email' : /^\+[1-9]\d{7,14}$/.test(contact) ? 'phone' : null;
    if (!kind) return c.json({ error: 'Enter an email address or a phone number with country code.' }, 400);
    // Contacts are voluntary, unverified waitlist entries, never identity proof.
    let address = 'unknown';
    try { address = getConnInfo(c).remote.address ?? address; } catch { /* In-process tests have no socket. */ }
    const joined = await directory.transaction(async client => {
      await client.query(signupLock);
      const window = Math.floor(Date.now() / 600000);
      const rate = (await client.query(`INSERT INTO platform_rate_windows(key,window_id,hits) VALUES($1,$2,1)
        ON CONFLICT(key,window_id) DO UPDATE SET hits=platform_rate_windows.hits+1 RETURNING hits`, [hashToken(`web-waitlist:${address}`), window])).rows[0];
      await client.query('DELETE FROM platform_rate_windows WHERE window_id<$1', [window - 2]);
      if (rate.hits > 20) return 'rate';
      await client.query("DELETE FROM web_waitlist WHERE created_at<clock_timestamp()-interval '30 days'");
      if (Number((await client.query('SELECT count(*) n FROM web_waitlist')).rows[0].n) < 10000 || (await client.query('SELECT 1 FROM web_waitlist WHERE contact=$1', [contact])).rowCount) {
        await client.query('INSERT INTO web_waitlist(id,contact,kind) VALUES($1,$2,$3) ON CONFLICT(contact) DO NOTHING', [opaqueToken(), contact, kind]);
        return 'joined';
      }
      return 'full';
    });
    return joined === 'joined' ? c.json({ platform: true, state: 'waitlist_joined' })
      : joined === 'rate' ? c.json({ error: 'Too many attempts. Please try again later.' }, 429)
      : c.json({ error: 'The waitlist is full right now. Please try again later.' }, 503);
  });
  return app;
}
