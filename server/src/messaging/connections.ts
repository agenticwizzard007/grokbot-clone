import { db, now } from '../db.js';
import { env } from '../env.js';
import { accountByPhone, mayCreateAccount } from '../accounts.js';
import { inkboxConfigured, textNewlyConnected } from './inkbox/adapter.js';
import { activeClaim, isAdminPhone, signupConfig, signupsToday, startAccount, usableInvite, welcomeText } from './signup.js';
import { digits, hostLinkByPhone } from './store.js';

/**
 * One text to join. People reach the line by texting "connect @<handle>" to Inkbox's shared number, but Inkbox keeps
 * that text to itself and sends no event, so on its own the person hears nothing until they text again.
 *
 * This watches Inkbox's list of connected numbers and greets each new one right away:
 * - an invite claimed on the join page, an open server, or the owner's number: create the account and welcome them;
 * - otherwise: tell them how to get in (invite code, or the waitlist).
 * If Inkbox won't let the line text first, nothing is lost: their next message goes through the front desk as before.
 */

db.exec(`CREATE TABLE IF NOT EXISTS messaging_greeted (
  phone TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  at INTEGER NOT NULL
)`);

/** Only connections this recent are greeted (so a restart or first deploy doesn't message everyone again). */
const FRESH_MS = 20 * 60_000;
const INTERVAL_MS = 8_000;

export interface Connection { phone: string; status: string; createdAt: number }

/** Numbers connected to the line (admin key). */
export async function listConnections(): Promise<Connection[]> {
  const r = await fetch(`${env.inkboxBaseUrl}/api/v1/imessage/assignments?agent_identity_id=${encodeURIComponent(env.inkboxIdentityId)}`, {
    headers: { 'X-API-Key': env.inkboxAdminKey, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Inkbox connections: ${r.status}`);
  const j: any = await r.json();
  const items: any[] = Array.isArray(j) ? j : j?.items ?? j?.assignments ?? [];
  return items.map((a) => ({ phone: digits(a?.remote_number), status: String(a?.status ?? ''), createdAt: Date.parse(a?.created_at ?? '') || 0 }));
}

const greeted = (phone: string) => !!db.prepare('SELECT 1 FROM messaging_greeted WHERE phone=?').get(phone);
const markGreeted = (phone: string, outcome: string) => db.prepare('INSERT OR REPLACE INTO messaging_greeted(phone,outcome,at) VALUES (?,?,?)').run(phone, outcome, now());
const pendingPhoneLogin = (phone: string) => !!db.prepare('SELECT 1 FROM phone_logins WHERE phone=? AND used_at IS NULL AND expires_at>?').get(phone, now());

/** What a newly connected number should get. Exported for tests. */
export async function greetConnection(phone: string): Promise<string> {
  const p = digits(phone);
  if (!p || greeted(p)) return 'already';
  if (hostLinkByPhone('inkbox', 'imessage', p)) { markGreeted(p, 'member'); return 'member'; }
  // Signing in on the website: phone-auth texts the code as soon as it sees the connection.
  if (pendingPhoneLogin(p)) return 'phone-login';
  // A number that already has an account (e.g. made on the web) just gets connected when it first writes.
  if (accountByPhone(p)) { markGreeted(p, 'member'); return 'member'; }
  if (!mayCreateAccount(p)) { markGreeted(p, 'no-owner'); return 'no-owner'; }

  const cfg = signupConfig();
  const claim = activeClaim(p);
  const invite = claim ? usableInvite(claim.invite_code) : null;
  const admitted = isAdminPhone(p) || !!invite || cfg.mode === 'open';

  if (admitted && signupsToday() < cfg.signupsPerDay) {
    // Say hello first: if Inkbox won't let the line text first, create nothing and let their next text do it.
    if (!(await textNewlyConnected(p, welcomeText()))) { markGreeted(p, 'deferred'); return 'deferred'; }
    markGreeted(p, 'joined');
    if (invite) {
      db.prepare('UPDATE messaging_invites SET uses=uses+1 WHERE code=?').run(invite.code);
      db.prepare('DELETE FROM messaging_claims WHERE phone=?').run(p);
    }
    await startAccount({ phone: p, channel: 'imessage', transport: 'inkbox', chatRef: null, text: '' }, invite?.createdBy ?? null, { welcomeSent: true });
    return 'joined';
  }

  const text = cfg.mode === 'closed'
    ? "Thanks for connecting to Swarm! We aren't taking new members right now."
    : admitted
      ? "Thanks for connecting to Swarm! 👋 We're at capacity for today, so you're on the waitlist. I'll text you here when you're in."
      : "Welcome to Swarm! 👋 It's invite-only for now. Reply with your invite code to join, or send anything else to join the waitlist.";
  const ok = await textNewlyConnected(p, text);
  markGreeted(p, ok ? `told-${cfg.mode}` : 'deferred');
  return ok ? `told-${cfg.mode}` : 'deferred';
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** One pass: greet every fresh connection we haven't seen. Exported for tests. */
export async function checkConnections(): Promise<void> {
  if (running || !inkboxConfigured() || !env.inkboxAdminKey) return;
  running = true;
  try {
    const fresh = (await listConnections()).filter((c) => c.status === 'active' && c.phone && now() - c.createdAt < FRESH_MS);
    for (const c of fresh) {
      try { await greetConnection(c.phone); }
      catch (e) { console.warn('[connections] greeting failed:', (e as Error).message); }
    }
  } catch (e) {
    console.warn('[connections] check failed:', (e as Error).message);
  } finally {
    running = false;
  }
}

export function startConnectionWatcher() {
  if (timer) return;
  timer = setInterval(() => void checkConnections(), INTERVAL_MS);
  timer.unref();
}
