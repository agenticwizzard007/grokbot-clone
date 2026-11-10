import { env } from '../env.js';
import { appendRow, getBotRow, setLive } from '../store.js';
import type { BotScreen } from '../computers/types.js';

/**
 * CAPTCHA handoff. When a page asks a person to prove they're human, the Bot never tries to solve or
 * get around it. It stops, asks its user to solve it on the Bot's own screen (a link that opens the
 * live screen with Take control, delivered in the app and by text), waits, then continues on the
 * same page. Detection runs in the companion after every page-changing browser action.
 *
 *   CAPTCHA_AUTOPASS_SEC  8   first wait silently: many checks (e.g. Cloudflare) clear by themselves
 *   CAPTCHA_WAIT_MIN      10  how long to wait for the user before giving up on this page
 */

export interface Captcha { kind: string; url: string; title?: string }

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const AUTOPASS_MS = num(process.env.CAPTCHA_AUTOPASS_SEC, 8) * 1000;
const WAIT_MS = num(process.env.CAPTCHA_WAIT_MIN, 10) * 60_000;
const POLL_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A link that opens this Bot's live screen, ready for Take control. */
export const screenLink = (botId: string) => `${env.appUrl.replace(/\/$/, '')}/?screen=${encodeURIComponent(botId)}`;

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'this site'; } };

/** Wait for the challenge to clear (by itself, or by the user on the Bot's screen). */
export async function handOffCaptcha(botId: string, screen: BotScreen, found: Captcha, signal?: AbortSignal): Promise<{ solved: boolean; byUser: boolean; waitedMs: number }> {
  const t0 = Date.now();
  const stillThere = async () => {
    try { return !!(await screen.captcha!()); } catch { return true; }
  };
  // Many checks pass on their own within a few seconds: don't bother the user for those.
  while (Date.now() - t0 < AUTOPASS_MS) {
    if (signal?.aborted) return { solved: false, byUser: false, waitedMs: Date.now() - t0 };
    await sleep(Math.min(POLL_MS, 1000));
    if (!(await stillThere())) return { solved: true, byUser: false, waitedMs: Date.now() - t0 };
  }
  const bot = getBotRow(botId);
  const host = hostOf(found.url);
  appendRow(botId, 'message', {
    type: 'message',
    role: 'assistant',
    text: `🧩 I hit a ${found.kind} on ${host} and need a person for a moment. Please solve it on my screen: ${screenLink(botId)}\nI'll carry on as soon as it's done.`,
  });
  setLive(botId, { awaiting: { reason: `Solve the ${found.kind} on ${bot?.name ?? 'the Bot'}'s screen`, since: Date.now() } });
  try {
    while (Date.now() - t0 < WAIT_MS) {
      if (signal?.aborted) return { solved: false, byUser: false, waitedMs: Date.now() - t0 };
      await sleep(POLL_MS);
      if (!(await stillThere())) return { solved: true, byUser: true, waitedMs: Date.now() - t0 };
    }
    return { solved: false, byUser: false, waitedMs: Date.now() - t0 };
  } finally {
    setLive(botId, { awaiting: null });
  }
}

/** What the Bot is told after a handoff. */
export function captchaOutcome(found: Captcha, r: { solved: boolean; byUser: boolean; waitedMs: number }, page: string): string {
  const host = hostOf(found.url);
  if (r.solved && r.byUser) return `A ${found.kind} appeared on ${host}; the user solved it on your screen. Continue the task from here.\n${page}`;
  if (r.solved) return `A ${found.kind} on ${host} cleared by itself. Continue.\n${page}`;
  return `A ${found.kind} on ${host} is still waiting for a person after ${Math.max(1, Math.round(r.waitedMs / 60_000))} minutes. Don't try to solve or get around it. Tell the user you stopped at this step because the site wants a human check, and that you'll continue once they've solved it on your screen.`;
}
