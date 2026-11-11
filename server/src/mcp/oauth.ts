import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { db, now } from '../db.js';
import { token, sha256 } from '../lib/ids.js';
import { sealPrivate, openPrivate } from '../security/secrets.js';
import { publicFetch, publicHttpsUrl } from '../security/network.js';
import { env } from '../env.js';
import { getMcpServer, type McpServer } from './store.js';

db.exec(`CREATE TABLE IF NOT EXISTS mcp_oauth (
  connection_id TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,revision INTEGER NOT NULL,secret TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_oauth_attempts (
  state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,revision INTEGER NOT NULL,
  session_hash TEXT NOT NULL REFERENCES auth_sessions(token) ON DELETE CASCADE, secret TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
interface Credential { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; savedAt?: number }
const callback = () => `${env.serverUrl.replace(/\/$/, '')}/api/mcp/servers/oauth/callback`;
const purpose = (s: McpServer) => `mcp-oauth:${s.id}:${s.revision}`;
function current(s: McpServer) { if (getMcpServer(s.userId, s.id)?.revision !== s.revision) throw new Error('MCP authorization changed.'); }
function load(s: McpServer): Credential {
  const row = db.prepare('SELECT secret FROM mcp_oauth WHERE connection_id=? AND user_id=? AND revision=?').get(s.id, s.userId, s.revision) as { secret: string } | undefined;
  return row ? openPrivate(s.userId, purpose(s), row.secret) : {};
}
function provider(s: McpServer, credential: Credential, state?: string) {
  let redirect: string | undefined;
  const save = () => {
    current(s);
    db.prepare('INSERT OR REPLACE INTO mcp_oauth VALUES(?,?,?,?)').run(s.id, s.userId, s.revision, sealPrivate(s.userId, purpose(s), credential));
  };
  const p: OAuthClientProvider = {
    redirectUrl: callback(), clientMetadata: { client_name: 'Swarm', redirect_uris: [callback()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    state: () => { if (!state) throw new Error('Reconnect this MCP in Settings.'); return state; },
    clientInformation: () => credential.client,
    saveClientInformation: value => { if (!value.issuer) throw new Error('Missing OAuth issuer.'); publicHttpsUrl(value.issuer); credential.client = value; if (!state) save(); },
    tokens: () => credential.tokens,
    saveTokens: value => {
      if (!value.issuer || value.issuer !== credential.client?.issuer || !value.access_token || value.access_token.length > 16_000) throw new Error('Invalid OAuth issuer or token.');
      credential.tokens = value; credential.savedAt = now(); if (!state) save();
    },
    redirectToAuthorization: value => {
      if (!state) throw new Error('Reconnect this MCP in Settings.');
      publicHttpsUrl(value);
      if (value.searchParams.get('state') !== state || value.searchParams.get('code_challenge_method') !== 'S256' || !value.searchParams.get('code_challenge')) throw new Error('MCP OAuth must use state and PKCE.');
      redirect = value.href;
    },
    saveCodeVerifier: value => { credential.verifier = value; },
    codeVerifier: () => { if (!credential.verifier) throw new Error('OAuth attempt expired.'); return credential.verifier; },
    validateResourceURL: async (server, resource) => {
      const expected = publicHttpsUrl(server), actual = publicHttpsUrl(resource ?? server);
      if (expected.origin !== actual.origin || expected.pathname !== actual.pathname) throw new Error('OAuth resource must match the configured MCP endpoint.');
      return actual;
    },
    invalidateCredentials: scope => {
      if (scope === 'all' || scope === 'client') delete credential.client;
      if (scope === 'all' || scope === 'tokens') delete credential.tokens;
      if (scope === 'all' || scope === 'verifier') delete credential.verifier;
      if (!state) save();
    },
  };
  return { p, save, redirect: () => redirect };
}
export async function beginMcpOAuth(s: McpServer, sessionHash: string) {
  if (!s.config.oauth || s.config.transport === 'stdio') throw new Error('Enable OAuth for a remote MCP first.');
  const state = token(), credentials = load(s); delete credentials.tokens; delete credentials.verifier;
  const flow = provider(s, credentials, state);
  await auth(flow.p, { serverUrl: s.config.url, fetchFn: publicFetch });
  current(s);
  if (!flow.redirect()) throw new Error('MCP did not provide an authorization URL.');
  db.transaction(() => {
    db.prepare('DELETE FROM mcp_oauth_attempts WHERE expires_at<=? OR (user_id=? AND connection_id=?)').run(now(), s.userId, s.id);
    db.prepare('INSERT INTO mcp_oauth_attempts VALUES(?,?,?,?,?,?,?)').run(sha256(state), s.userId, s.id, s.revision, sessionHash, sealPrivate(s.userId, `${purpose(s)}:attempt:${sha256(state)}`, credentials), now() + 600_000);
  })();
  return { redirectUrl: flow.redirect() };
}
export async function finishMcpOAuth(userId: string, sessionHash: string, state: string, code: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 4096) throw new Error('Invalid MCP authorization.');
  const a = db.prepare('DELETE FROM mcp_oauth_attempts WHERE state_hash=? AND user_id=? AND session_hash=? AND expires_at>? RETURNING *').get(sha256(state), userId, sessionHash, now()) as any;
  const s = a && getMcpServer(userId, a.connection_id);
  if (!s || s.revision !== a.revision) throw new Error('MCP authorization expired.');
  const credentials = openPrivate<Credential>(userId, `${purpose(s)}:attempt:${sha256(state)}`, a.secret);
  const flow = provider(s, credentials, state);
  if (await auth(flow.p, { serverUrl: s.config.url, authorizationCode: code, fetchFn: publicFetch }) !== 'AUTHORIZED') throw new Error('MCP authorization failed.');
  delete credentials.verifier; flow.save();
  return s.id;
}
export async function mcpOAuthToken(s: McpServer) {
  const credential = load(s);
  if (!credential.tokens) throw new Error('Connect this MCP using OAuth in Settings.');
  const expires = credential.tokens.expires_in;
  if (expires && (credential.savedAt ?? 0) + expires * 1000 < now() + 30_000) {
    const flow = provider(s, credential);
    if (await auth(flow.p, { serverUrl: s.config.url, fetchFn: publicFetch }) !== 'AUTHORIZED') throw new Error('Reconnect this MCP in Settings.');
  }
  current(s); return credential.tokens!.access_token;
}
