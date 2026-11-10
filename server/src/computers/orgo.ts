import { db } from '../db.js';
import { hub } from '../lib/hub.js';
import { orgo } from '../orgo.js';
import { startIdleWatcher } from '../idle.js';
import type { LibraryFile } from '../types.js';
import { computerState, ensureComputer, refreshComputer, screenFor, suspendComputer } from './orgo-box.js';
import { orgoViewer } from './orgo-viewer.js';
import { ComputerError, type BotScreen, type ComputerProvider, type Shot } from './types.js';

/** Orgo cloud VMs: one Linux box per user, one X screen per Bot (see orgo-box.ts). */

const LIB_ROOT = '/root/swarm/files';
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function toShot(s: { image: string; mime_type?: string; width: number; height: number }): Shot {
  const m = s.image.match(/^data:([^;,]+)[^,]*,/);
  return { image: m ? s.image.slice(m[0].length) : s.image, mime: m?.[1] ?? s.mime_type ?? 'image/jpeg', width: s.width, height: s.height };
}

/** Parse `ls -la --time-style=+%s` output. */
export function parseLs(out: string): LibraryFile[] {
  const files: LibraryFile[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^([-dlcbps])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    let name = m[4];
    if (m[1] === 'l') name = name.replace(/ -> .*$/, '');
    if (name === '.' || name === '..') continue;
    files.push({ name, size: Number(m[2]), modifiedAt: Number(m[3]) * 1000, isDir: m[1] === 'd' });
  }
  return files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.modifiedAt - a.modifiedAt);
}

/** The bot's computer id if it is awake (or `wake` is set), plus the bot's leased screen if it has one. */
async function boxFor(userId: string, botId: string, wake: boolean): Promise<{ computerId: string; screenId?: string } | null> {
  const comp = db.prepare('SELECT orgo_id, status FROM computers WHERE user_id=?').get(userId) as any;
  let computerId: string | null = comp?.status === 'running' ? comp.orgo_id : null;
  if (!computerId && wake) computerId = await ensureComputer(userId);
  if (!computerId) return null;
  // Use the bot's own screen when it has one; never lease (and evict) a screen just to list files.
  const scr = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(botId) as any;
  return { computerId, screenId: scr?.screen_id };
}

export const orgoProvider: ComputerProvider = {
  kind: 'orgo',
  capabilities: { shell: true },
  promptLine:
    "You have your own computer: a Linux desktop screen that only you use, with Chrome and a root shell. Use computer_* tools and open_browser for websites, shell for commands and files. Save finished deliverables (reports, notes, data) with save_file so they appear in the user's Library. Always take a screenshot before clicking, and check the screenshot after each action.",

  state: computerState,
  refresh: refreshComputer,
  ensure: async (userId) => { await ensureComputer(userId); },
  suspend: (userId) => suspendComputer(userId),

  async screen(userId, botId): Promise<BotScreen> {
    const { computerId: c, screenId: s } = await screenFor(userId, botId);
    return {
      screenshot: async () => toShot(await orgo.screenshot(c, s)),
      click: async (a) => { await orgo.click(c, s, { x: a.x, y: a.y, button: a.button ?? 'left', double: !!a.double }); },
      drag: async (a) => { await orgo.drag(c, s, a); },
      type: async (text) => { for (let i = 0; i < text.length; i += 1500) await orgo.type(c, s, text.slice(i, i + 1500)); },
      key: async (keys) => { await orgo.key(c, s, keys); },
      scroll: async (a) => { await orgo.scroll(c, s, a); },
      openUrl: async (rawUrl) => {
        const url = rawUrl.replace(/'/g, '%27');
        const display = s === 'default' ? ':99' : `:${s.replace('screen-', '')}`;
        const profile = `/root/swarm/profiles/${botId}`;
        // Reuse the bot's running Chrome if present (opens a new tab), else start one detached.
        await orgo.bash(
          c,
          s,
          `export DISPLAY=${display}; mkdir -p ${profile}; pgrep -f "user-data-dir=${profile}" >/dev/null || rm -f ${profile}/Singleton*; ` +
            `setsid nohup google-chrome --no-sandbox --no-first-run --no-default-browser-check --disable-dev-shm-usage --password-store=basic ` +
            `--user-data-dir=${profile} --start-maximized '${url}' >/tmp/chrome-${botId}.log 2>&1 < /dev/null & sleep 4; echo ok`,
          40,
        );
      },
      shell: async (command, timeoutSec) => {
        const r = await orgo.bash(c, s, command, timeoutSec);
        return { exit_code: r.exit_code, output: r.output ?? '' };
      },
    };
  },

  async peek(userId, botId) {
    const comp = db.prepare("SELECT orgo_id FROM computers WHERE user_id=? AND status='running'").get(userId) as any;
    const scr = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(botId) as any;
    if (!comp?.orgo_id || !scr) return null;
    return toShot(await orgo.screenshot(comp.orgo_id, scr.screen_id));
  },

  /** Give a bot a clean screen: close its windows (default screen) or destroy its extra screen so a fresh one is made next time. */
  async resetScreen(userId, botId) {
    const lease = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(botId) as any;
    if (!lease) return { ok: true, note: 'no screen yet' };
    const comp = db.prepare("SELECT orgo_id FROM computers WHERE user_id=? AND status='running'").get(userId) as any;
    if (!comp?.orgo_id) throw new ComputerError('Wake the computer first', 409);
    const profile = `/root/swarm/profiles/${botId}`;
    await orgo.bash(comp.orgo_id, undefined, `pkill -f ${shq(`user-data-dir=${profile}`)}; rm -f ${shq(profile)}/Singleton*; echo ok`, 30).catch(() => null);
    if (lease.screen_id !== 'default') {
      await orgo.deleteScreen(comp.orgo_id, lease.screen_id).catch((e) => console.warn('[computer] delete screen', e?.message));
      db.prepare('DELETE FROM screens WHERE bot_id=?').run(botId);
    }
    console.log(`[computer] reset screen ${lease.screen_id} for bot ${botId}`);
    hub.emit(userId, { type: 'computer', state: computerState(userId) });
    return { ok: true, screenId: lease.screen_id };
  },

  screens: (userId) =>
    (db.prepare('SELECT bot_id, screen_id, last_used_at FROM screens WHERE user_id=? ORDER BY last_used_at DESC').all(userId) as any[])
      .map((l) => ({ botId: l.bot_id, screenId: l.screen_id, lastUsedAt: l.last_used_at })),

  files: {
    async save(userId, botId, name, content) {
      const dir = `${LIB_ROOT}/${botId}`;
      const b64 = Buffer.from(content, 'utf8').toString('base64');
      const { computerId: c, screenId: s } = await screenFor(userId, botId);
      // Chunk the base64 so very large files don't exceed a single command's size.
      const run = async (command: string) => {
        const result = await orgo.bash(c, s, command, 30);
        if (result.exit_code !== 0) throw new ComputerError(`Could not save ${name}: ${(result.output ?? '').slice(0, 300)}`);
      };
      await run(`mkdir -p ${dir} && : > ${dir}/${name}.b64`);
      for (let i = 0; i < b64.length; i += 60000) await run(`printf '%s' '${b64.slice(i, i + 60000)}' >> ${dir}/${name}.b64`);
      await run(`base64 -d ${dir}/${name}.b64 > ${dir}/${name} && rm ${dir}/${name}.b64 && wc -c ${dir}/${name}`);
      return `${dir}/${name}`;
    },
    async list(userId, botId, rel, wake) {
      const box = await boxFor(userId, botId, wake);
      if (!box) return { status: 'asleep', path: rel, files: [] };
      const dir = `${LIB_ROOT}/${botId}${rel ? `/${rel}` : ''}`;
      const r = await orgo.bash(box.computerId, box.screenId, `mkdir -p ${shq(`${LIB_ROOT}/${botId}`)} && ls -la --time-style=+%s ${shq(dir)} 2>&1`, 30);
      if (r.exit_code !== 0) return { status: 'error', path: rel, files: [], error: (r.output ?? '').slice(0, 300) };
      return { status: 'ok', path: rel, files: parseLs(r.output ?? '') };
    },
    async download(userId, botId, rel) {
      const box = await boxFor(userId, botId, true);
      if (!box) throw new ComputerError('computer unavailable', 409);
      const r: any = await orgo.exportFile(box.computerId, `${LIB_ROOT}/${botId}/${rel}`);
      const url = r?.url ?? r?.file?.url ?? r?.download_url;
      if (!url) throw new ComputerError('export returned no link', 502);
      return url;
    },
  },

  viewer: orgoViewer,
  start: () => { startIdleWatcher(); },
};
