import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export interface GoogleIdentity { subject: string; email: string; name?: string }
export const googleAvailable = () => !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
export const randomProof = () => crypto.randomBytes(32).toString('base64url');
export const challengeFor = (v: string) => crypto.createHash('sha256').update(v).digest('base64url');
export function googleAuthorization(redirectUri: string, state: string, nonce: string, verifier: string) {
  if (!googleAvailable()) throw new Error('google_unavailable');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, nonce, code_challenge: challengeFor(verifier), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  return url.href;
}
export async function verifyGoogleIdentity(idToken: string, nonce: string, key: JWTVerifyGetKey = jwks): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, key, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: process.env.GOOGLE_CLIENT_ID, algorithms: ['RS256'], maxTokenAge: '10m' });
  if (payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 || payload.email_verified !== true || typeof payload.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) throw new Error('google_identity');
  return { subject: payload.sub, email: payload.email.toLowerCase(), name: typeof payload.name === 'string' ? payload.name.slice(0, 80) : undefined };
}
export async function exchangeGoogleCode(code: string, verifier: string, nonce: string, redirectUri: string): Promise<GoogleIdentity> {
  if (!googleAvailable() || !code || code.length > 4096) throw new Error('google_invalid');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  if (!response.ok) throw new Error('google_denied');
  const value = await response.json() as { id_token?: unknown };
  if (typeof value.id_token !== 'string' || value.id_token.length > 32_768) throw new Error('google_identity');
  return verifyGoogleIdentity(value.id_token, nonce);
}
