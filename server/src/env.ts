import fs from 'node:fs';
import path from 'node:path';

// Installs from before the Swarm rename may still set GROKBOT_* variables; read them as SWARM_*.
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith('GROKBOT_') && value !== undefined) process.env[`SWARM_${name.slice(8)}`] ??= value;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * Where Bots' computers come from: 'orgo' (Orgo cloud VMs), 'local' (a browser on your own PC via the
 * companion), 'desktop' (your own PC's full desktop and a shell, via the companion), or 'cloudvm'
 * (a VM per user, created automatically through a provider API, with one screen per Bot; see computers/cloudvm.ts).
 */
const computerSetting = (process.env.COMPUTER_PROVIDER || (process.env.ORGO_API_KEY ? 'orgo' : 'local')).toLowerCase();
if (!['orgo', 'local', 'desktop', 'cloudvm'].includes(computerSetting)) throw new Error(`COMPUTER_PROVIDER must be "orgo", "local", "desktop" or "cloudvm", got "${computerSetting}"`);
/** 'desktop' is the local provider (the companion) in full-desktop mode. */
const computerProvider = computerSetting === 'orgo' ? 'orgo' : computerSetting === 'cloudvm' ? 'cloudvm' : 'local';
const vmDriver = (process.env.VM_DRIVER || 'fly').toLowerCase();
if (computerProvider === 'cloudvm' && !['fly', 'fake'].includes(vmDriver)) throw new Error(`VM_DRIVER must be "fly" or "fake", got "${vmDriver}"`);

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
const inkboxHandle = () => {
  const h = live('INKBOX_HANDLE').trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9-]/g, '');
  return !h || h === 'swarm-team' ? 'swarm' : h;
};

/** `current`, unless only `legacy` exists (an install from before the Swarm rename). */
export const preferExisting = (current: string, legacy: string) => (!fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current);
const dataFile = (name: string) => new URL(`../../data/${name}`, import.meta.url).pathname;
const dbPath = process.env.DB_PATH ?? preferExisting(dataFile('swarm.db'), dataFile('grokbot.db'));

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  /** Without a key the server still runs; Bots explain that a key is needed. */
  get directKey() { return live('DIRECT_API_KEY'); },
  get directModel() { return live('DIRECT_MODEL') || 'openai/gpt-4.1'; },
  /** Base URL of the direct provider API (override to use any compatible provider or a local mock). */
  directBaseUrl: process.env.DIRECT_BASE_URL || 'https://api.openai.com/v1',
  /** Platform voice is shared by every account, independently of its text-model provider. */
  get voiceKey() { return live('XAI_API_KEY'); },
  voiceBaseUrl: (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/$/, ''),
  /** Composio powers connected apps and Google sign-in; without it those are off and everything else works. */
  /** OpenRouter: one key for Claude, GPT, Gemini and hundreds more (Responses API). */
  get openrouterKey() { return live('OPENROUTER_API_KEY'); },
  get openrouterModel() { return live('OPENROUTER_MODEL') || 'openai/gpt-4.1'; },
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  /** Which service runs the Bots' models: LLM_PROVIDER if set, else OpenRouter when it has a key, else direct provider. */
  /** The chosen provider, unless only the other one has a key (so Bots keep working while you add one). */
  get llmProvider(): 'direct' | 'openrouter' {
    const p = live('LLM_PROVIDER');
    const or = !!live('OPENROUTER_API_KEY');
    const direct = !!live('DIRECT_API_KEY');
    if (p === 'openrouter') return or || !direct ? 'openrouter' : 'direct';
    if (p === 'direct') return direct || !or ? 'direct' : 'openrouter';
    return or ? 'openrouter' : 'direct';
  },
  /** The provider picked in Settings (or LLM_PROVIDER), even before its key is added. */
  get llmProviderChoice(): 'direct' | 'openrouter' | null {
    const p = live('LLM_PROVIDER');
    return p === 'direct' || p === 'openrouter' ? p : null;
  },
  get composioKey() { return live('COMPOSIO_API_KEY'); },
  get composioEnabled() { return !!live('COMPOSIO_API_KEY'); },
  get composioOrgId() { return live('COMPOSIO_ORG_ID'); },
  get composioProjectId() { return live('COMPOSIO_PROJECT_ID'); },
  /** Inkbox (inkbox.ai): the server's iMessage/SMS/WhatsApp line. Set in Settings → Messaging, or here. */
  get inkboxAdminKey() { return live('INKBOX_ADMIN_API_KEY'); },
  get inkboxHandle() { return inkboxHandle(); },
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
  computerProvider: computerProvider as 'orgo' | 'local' | 'cloudvm',
  /** cloudvm: which VM provider API creates the VMs ('fly' = Fly.io Machines; 'fake' = local processes, for dev and tests). */
  vmDriver: vmDriver as 'fly' | 'fake',
  /** cloudvm: the VM image (OS, desktop, Chrome, supervisor); the companion itself is fetched from this server at boot. */
  vmImage: process.env.VM_IMAGE ?? 'registry.fly.io/swarm-vm:latest',
  vmRegion: process.env.VM_REGION ?? '',
  /** cloudvm: memory for the base system plus each Bot screen (MB), and vCPUs. */
  vmBaseMemoryMb: Number(process.env.VM_BASE_MEMORY_MB ?? 2048),
  vmScreenMemoryMb: Number(process.env.VM_SCREEN_MEMORY_MB ?? 768),
  vmCpus: Number(process.env.VM_CPUS ?? 2),
  vmVolumeGb: Number(process.env.VM_VOLUME_GB ?? 10),
  flyApiToken: process.env.FLY_API_TOKEN ?? '',
  flyApp: process.env.FLY_VM_APP ?? '',
  flyApiBase: (process.env.FLY_API_BASE || 'https://api.machines.dev').replace(/\/$/, ''),
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
