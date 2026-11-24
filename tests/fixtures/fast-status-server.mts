// Local QA only. Temporary DB and fake executable paths are supplied by the browser test.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { createAccount } from '../../server/src/accounts.js';
import { db } from '../../server/src/db.js';
import { cliApi } from '../../server/src/cli/routes.js';
const app = new Hono();
app.get('/api/health', c => c.json({ ok: true }));
app.post('/api/fixture/account', c => {
  const user = createAccount({ email: `${randomUUID()}@example.test`, name: 'Local QA' });
  const token = randomUUID(), now = Date.now();
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES(session_hash(?),?,?,?,?,?)')
    .run(token, user.id, now, now + 3600000, now, now);
  setCookie(c, 'swarm_session', token, { httpOnly: true, path: '/' });
  return c.json({ user });
});
app.route('/api/cli', cliApi);
serve({ fetch: app.fetch, port: Number(process.env.PORT), hostname: '127.0.0.1' });
