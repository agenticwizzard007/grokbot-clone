import fs from 'node:fs';
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { env } from '../env.js';

const ISSUER = 'https://appleid.apple.com';
const keys = createRemoteJWKSet(new URL(`${ISSUER}/auth/keys`), { timeoutDuration: 10_000, cooldownDuration: 30_000 });
export type AppleClient = 'web' | 'ios' | 'macos';
export class AppleError extends Error {
  constructor(public code: string) { super(code); }
}

export function appleConfiguration() {
  let privateKey = (process.env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
  if (!privateKey && process.env.APPLE_PRIVATE_KEY_PATH) {
    try { privateKey = fs.readFileSync(process.env.APPLE_PRIVATE_KEY_PATH, 'utf8').trim(); } catch { /* Unavailable credentials keep sign-in disabled. */ }
  }
  return {
    teamId: process.env.APPLE_TEAM_ID ?? '', keyId: process.env.APPLE_KEY_ID ?? '', privateKey,
    clients: { web: process.env.APPLE_SERVICE_ID ?? '', ios: process.env.APPLE_IOS_CLIENT_ID ?? '', macos: process.env.APPLE_MACOS_CLIENT_ID ?? '' },
    redirectURI: `${env.serverUrl.replace(/\/$/, '')}/api/auth/apple/callback`,
  };
}
export function appleAvailability() {
  const config = appleConfiguration();
  const ready = !!(config.teamId && config.keyId && config.privateKey);
  return { web: ready && !!config.clients.web && config.redirectURI.startsWith('https://'), ios: ready && !!config.clients.ios, macos: ready && !!config.clients.macos };
}
export function appleAvailableForAgent(agent = '') {
  const availability = appleAvailability();
  return agent.includes('SwarmNative/') ? agent.includes('(macOS)') ? availability.macos : availability.ios : availability.web;
}

export async function appleClientSecret(clientId: string) {
  const config = appleConfiguration();
  if (!config.teamId || !config.keyId || !config.privateKey || !Object.values(config.clients).includes(clientId)) throw new AppleError('apple_unavailable');
  const key = await importPKCS8(config.privateKey, 'ES256');
  return new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: config.keyId }).setIssuer(config.teamId).setSubject(clientId).setAudience(ISSUER).setIssuedAt().setExpirationTime('5m').sign(key);
}

export async function verifyAppleIdentity(token: string, clientId: string, nonce: string, verificationKeys: JWTVerifyGetKey = keys) {
  const { payload } = await jwtVerify(token, verificationKeys, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], maxTokenAge: '10m', clockTolerance: 5, requiredClaims: ['sub', 'exp', 'iat', 'nonce'] });
  if (payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new AppleError('apple_invalid');
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
  const verifiedEmail = email && (payload.email_verified === true || payload.email_verified === 'true') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  return { subject: payload.sub, email: verifiedEmail };
}

export async function exchangeAppleCode(code: string, clientId: string, nonce: string, web: boolean) {
  const body = new URLSearchParams({ client_id: clientId, client_secret: await appleClientSecret(clientId), code, grant_type: 'authorization_code' });
  if (web) body.set('redirect_uri', appleConfiguration().redirectURI);
  const response = await fetch(`${ISSUER}/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new AppleError('apple_invalid');
  const result = await response.json() as { id_token?: unknown; refresh_token?: unknown };
  if (typeof result.id_token !== 'string' || typeof result.refresh_token !== 'string' || !result.refresh_token || result.refresh_token.length > 8192) throw new AppleError('apple_invalid');
  const identity = await verifyAppleIdentity(result.id_token, clientId, nonce);
  return { ...identity, refreshToken: result.refresh_token };
}

