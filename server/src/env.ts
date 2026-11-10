import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** Where Bots' computers come from: 'orgo' (cloud VMs) or 'local' (a browser on your own PC via the companion). */
const computerProvider = (process.env.COMPUTER_PROVIDER || (process.env.ORGO_API_KEY ? 'orgo' : 'local')).toLowerCase();
if (computerProvider !== 'orgo' && computerProvider !== 'local') throw new Error(`COMPUTER_PROVIDER must be "orgo" or "local", got "${computerProvider}"`);

const dbPath = process.env.DB_PATH ?? new URL('../../data/grokbot.db', import.meta.url).pathname;

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  xaiKey: req('XAI_API_KEY'),
  xaiModel: process.env.XAI_MODEL ?? 'grok-4.7',
  /** Base URL of the xAI API (override to use a compatible proxy or a local mock). */
  xaiBaseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
  /** Composio powers connected apps and Google sign-in; without it those are off and everything else works. */
  composioKey: process.env.COMPOSIO_API_KEY ?? '',
  composioEnabled: !!process.env.COMPOSIO_API_KEY,
  computerProvider: computerProvider as 'orgo' | 'local',
  orgoKey: computerProvider === 'orgo' ? req('ORGO_API_KEY') : (process.env.ORGO_API_KEY ?? ''),
  /** Orgo workspace that holds every user's box. */
  orgoWorkspaceId: process.env.ORGO_WORKSPACE_ID ?? '',
  /** Orgo box size for new users. */
  orgoRamGb: Number(process.env.ORGO_RAM_GB ?? 8),
  orgoCpu: Number(process.env.ORGO_CPU ?? 2),
  orgoResolution: process.env.ORGO_RESOLUTION ?? '1280x800x24',
  sessionSecret: req('SESSION_SECRET'),
  devLogin: process.env.DEV_LOGIN === '1',
  dbPath,
  /** Library files for the local computer provider (Orgo keeps them on the VM). */
  filesDir: process.env.FILES_DIR ?? path.join(path.dirname(dbPath), 'files'),
};
