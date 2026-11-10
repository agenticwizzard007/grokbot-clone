import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * Where Bots' computers come from: 'orgo' (cloud VMs), 'local' (a browser on your own PC via the
 * companion), or 'desktop' (your own PC's full desktop and a shell, via the companion).
 */
const computerSetting = (process.env.COMPUTER_PROVIDER || (process.env.ORGO_API_KEY ? 'orgo' : 'local')).toLowerCase();
if (!['orgo', 'local', 'desktop'].includes(computerSetting)) throw new Error(`COMPUTER_PROVIDER must be "orgo", "local" or "desktop", got "${computerSetting}"`);
/** 'desktop' is the local provider (the companion) in full-desktop mode. */
const computerProvider = computerSetting === 'orgo' ? 'orgo' : 'local';

/**
 * Provider keys can also be set in the app (Settings → API keys; see settings.ts). Values saved
 * there override .env and take effect immediately, so the getters below read them live.
 */
const overrides = new Map<string, string>();
export function setEnvOverride(name: string, value: string | null) {
  if (value) overrides.set(name, value);
  else overrides.delete(name);
}
export const envSource = (name: string): 'app' | 'env' | null => (overrides.has(name) ? 'app' : process.env[name] ? 'env' : null);
const live = (name: string) => overrides.get(name) ?? process.env[name] ?? '';

const dbPath = process.env.DB_PATH ?? new URL('../../data/grokbot.db', import.meta.url).pathname;

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  /** Without a key the server still runs; Bots explain that a key is needed. */
  get xaiKey() { return live('XAI_API_KEY'); },
  get xaiModel() { return live('XAI_MODEL') || 'grok-4.7'; },
  /** Base URL of the xAI API (override to use a compatible proxy or a local mock). */
  xaiBaseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
  /** Composio powers connected apps and Google sign-in; without it those are off and everything else works. */
  /** OpenRouter: one key for Grok, Claude, GPT, Gemini and hundreds more (Responses API). */
  get openrouterKey() { return live('OPENROUTER_API_KEY'); },
  get openrouterModel() { return live('OPENROUTER_MODEL') || 'x-ai/grok-4.7'; },
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  /** Which service runs the Bots' models: LLM_PROVIDER if set, else OpenRouter when it has a key, else xAI. */
  /** The chosen provider, unless only the other one has a key (so Bots keep working while you add one). */
  get llmProvider(): 'xai' | 'openrouter' {
    const p = live('LLM_PROVIDER');
    const or = !!live('OPENROUTER_API_KEY');
    const xai = !!live('XAI_API_KEY');
    if (p === 'openrouter') return or || !xai ? 'openrouter' : 'xai';
    if (p === 'xai') return xai || !or ? 'xai' : 'openrouter';
    return or ? 'openrouter' : 'xai';
  },
  /** The provider picked in Settings (or LLM_PROVIDER), even before its key is added. */
  get llmProviderChoice(): 'xai' | 'openrouter' | null {
    const p = live('LLM_PROVIDER');
    return p === 'xai' || p === 'openrouter' ? p : null;
  },
  get composioKey() { return live('COMPOSIO_API_KEY'); },
  get composioEnabled() { return !!live('COMPOSIO_API_KEY'); },
  /** Inkbox (inkbox.ai): the server's iMessage/SMS line. Set in Settings → Messaging, or here. */
  get inkboxAdminKey() { return live('INKBOX_ADMIN_API_KEY'); },
  get inkboxHandle() { return live('INKBOX_HANDLE') || 'grokbot'; },
  get inkboxIdentityId() { return live('INKBOX_IDENTITY_ID'); },
  get inkboxIdentityKey() { return live('INKBOX_API_KEY'); },
  get inkboxSigningKey() { return live('INKBOX_SIGNING_KEY'); },
  get inkboxPhoneNumberId() { return live('INKBOX_PHONE_NUMBER_ID'); },
  /** Inkbox API origin (override for a mock in tests). */
  inkboxBaseUrl: (process.env.INKBOX_BASE_URL || 'https://inkbox.ai').replace(/\/$/, ''),
  /** Sign-up by text: 'invite' (invites + waitlist), 'open' or 'closed'; and its limits. */
  get messagingSignupMode() { return live('MESSAGING_SIGNUP_MODE') || 'invite'; },
  get messagingSignupsPerDay() { return live('MESSAGING_SIGNUPS_PER_DAY'); },
  get messagingDailyTurns() { return live('MESSAGING_DAILY_MESSAGES'); },
  get messagingMemberInvites() { return live('MESSAGING_MEMBER_INVITES'); },
  computerProvider: computerProvider as 'orgo' | 'local',
  /** Local computers give Bots the whole desktop (screen, mouse, keyboard, shell), not just a browser. */
  localDesktop: computerSetting === 'desktop',
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
