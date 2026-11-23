// Local P-03 server fixture. Google verification uses signed test identities only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DEV_LOGIN, '1');
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'desktop-fixture', alg: 'RS256', use: 'sig' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
  if (url.href === 'https://oauth2.googleapis.com/token') {
    const body = new URLSearchParams(String(init?.body));
    assert.ok(body.get('code_verifier'));
    const { nonce, fixture, verified } = JSON.parse(Buffer.from(body.get('code')!, 'base64url').toString());
    return Response.json({ id_token: await new SignJWT({
      sub: `desktop-google-${fixture}`, email: `desktop-${fixture}@example.test`, email_verified: verified, nonce,
    }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://accounts.google.com')
      .setAudience(process.env.GOOGLE_CLIENT_ID!).setIssuedAt().setExpirationTime('5m').sign(privateKey) });
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  throw new Error('Desktop linking fixture forbids external requests');
};

const { db } = await import('../../server/src/db.js');
const { createAccount, createLoginLink } = await import('../../server/src/accounts.js');
const fixtures = [1440, 1024, 390].map(width => {
  const { id } = createAccount({ phone: `1555000${String(width).padStart(4, '0')}`, source: 'text', name: 'Fixture account' });
  // Existing pending addresses must never imply a linked identity.
  db.prepare('UPDATE users SET pending_email=? WHERE id=?').run(`desktop-${width}@example.test`, id);
  const bots = db.prepare('SELECT id FROM bots WHERE user_id=? ORDER BY id').all(id);
  return { width, id, bots, loginLink: createLoginLink(id) };
});
fs.writeFileSync(process.env.DESKTOP_GOOGLE_FIXTURE!, JSON.stringify(fixtures));
await import('../../server/src/index.js');
