import type { AgentSetupView, Bot, ComputerState, LibraryFile, Memory, Routine, Skill, Task, Toolkit } from '@shared/types';
import { ApiError } from './api';
import type { McpServerInput, McpServerView } from '@shared/types';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export interface BotSettingsBundle {
  memories: Memory[];
  skills: Skill[];
  routines: Routine[];
  tasks: Task[];
  memory: { lastConsolidatedAt: number | null; historyChars: number; compactAtChars: number; lastCompaction: { method: string; created_at: number } | null };
}

export interface LibraryListing { status: 'ok' | 'asleep' | 'error'; path: string; files: LibraryFile[]; error?: string }

export interface ComputerDetails {
  computer: ComputerState;
  screens: { botId: string; screenId: string; lastUsedAt: number }[];
  hibernation: { idleMinutes: number; viewers: number; dryRun: boolean };
  /** Local computers only: whether a PC has been paired. */
  pairing: { paired: boolean; lastSeenAt: number | null } | null;
  /** Local computers: whether "Use this computer" is offered (you're on the machine the server runs on) and active. */
  thisComputer: { available: boolean; active: boolean } | null;
}

export interface Pairing { token: string; server: string; command: string }

export interface KeyStatus { set: boolean; source: 'app' | 'env' | null; hint: string | null }
export interface KeysResponse {
  canEdit: boolean;
  xai: KeyStatus;
  composio: KeyStatus;
  openrouter: KeyStatus;
  model: { value: string; source: 'app' | 'env' | null };
  openrouterModel: { value: string; source: 'app' | 'env' | null };
  provider: { value: 'xai' | 'openrouter'; chosen: 'xai' | 'openrouter' | null; source: 'app' | 'env' | null };
  models?: string[];
  modelOk?: boolean;
}

export interface ModelInfo { id: string; name: string; vision: boolean; reasoning: boolean; context: number; price: { input: number; output: number } | null }
export type SettingKey = 'xai' | 'composio' | 'model' | 'openrouter' | 'openrouter_model' | 'provider';

export type MessagingChannel = 'imessage' | 'sms';
export interface MessagingLink {
  channel: MessagingChannel;
  channelName: string;
  status: 'pairing' | 'connected' | 'disconnected' | 'logged_out' | 'error';
  phone: string | null;
  lastInboundAt: number | null;
  error: string | null;
}
export interface MessagingLine { number: string; connectCommand: string; smsLink: string }
export type SignupMode = 'invite' | 'open' | 'closed';
export interface MessagingOwner {
  inkbox: { adminKeySet: boolean; configured: boolean; handle: string; identityId: string | null; sms: boolean; webhookUrl: string; inbox: { status: string; n: number }[] };
  signup: { mode: SignupMode; signupsPerDay: number; dailyTurns: number; memberInvites: number };
}
export type VoiceReplies = 'voice-in' | 'always' | 'off';
export interface PhoneStart { id: string; line: { number: string; connectCommand: string; smsLink: string } | null }
export interface MessagingStatus {
  account: { phone: string | null; email: string | null; signupSource: 'web' | 'text' };
  links: MessagingLink[];
  prefs: { forward: 'all' | 'engaged'; activeBot: { id: string; name: string } | null; voiceReplies: VoiceReplies; ttsVoice: string | null };
  /** Who transcribes voice notes and speaks voice replies on this server (null = not available). */
  speech: { transcription: 'openrouter' | 'xai' | null; speech: 'openrouter' | 'xai' | null; voices: string[] };
  /** null = texting isn't set up on this server. */
  line: MessagingLine | null;
  invites: { allowance: number };
  /** Present only for the server owner. */
  owner?: MessagingOwner;
}
export interface MessagingCode { code: string; expiresAt: number; number: string; connectCommand: string; smsLink: string; qr: string }
export interface InkboxSetupResult { step: 'identity' | 'key' | 'signing' | 'webhook' | 'done'; handle: string; identityId: string | null; error?: string }
export interface MessagingInvite { code: string; createdBy: string | null; createdByName: string | null; maxUses: number; uses: number; expiresAt: number | null; note: string | null; revoked: boolean; createdAt: number; url: string; qr?: string }
export interface WaitlistEntry { phone: string; channel: MessagingChannel | string; name: string | null; firstMessage: string | null; status: 'pending' | 'approved' | 'declined' | 'deleted'; createdAt: number; decidedAt: number | null }
export interface JoinInfo { valid: boolean; inviter: string | null; line: (MessagingLine & { qr: string }) | null; reason: string | null }

/** Inkbox line setup answers 400 with a full body (setup.error) when a step fails, so read the body either way. */
async function inkboxSetup(p: { handle?: string; withPhone?: boolean; rotateSigningKey?: boolean }): Promise<{ setup: InkboxSetupResult } & MessagingStatus> {
  const res = await fetch('/api/messaging/inkbox/setup', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  let body: ({ setup?: InkboxSetupResult; error?: string } & Partial<MessagingStatus>) | null = null;
  try { body = await res.json(); } catch { /* not json */ }
  if (body?.setup) return body as { setup: InkboxSetupResult } & MessagingStatus;
  throw new ApiError(res.status, body?.error ?? res.statusText);
}

export type BotPatch = Partial<Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'effort' | 'mode' | 'model'>>;

export const configApi = {
  mcpServers: () => req<{ servers: McpServerView[]; canManage: boolean }>('GET', '/mcp/servers'),
  createMcpServer: (input: McpServerInput) => req<{ server: McpServerView }>('POST', '/mcp/servers', input),
  updateMcpServer: (id: string, input: Partial<McpServerInput>) => req<{ server: McpServerView }>('PATCH', `/mcp/servers/${id}`, input),
  testMcpServer: (id: string) => req<{ server: McpServerView }>('POST', `/mcp/servers/${id}/test`),
  deleteMcpServer: (id: string) => req<{ ok: true }>('DELETE', `/mcp/servers/${id}`),
  agentSetup: (botId: string) => req<AgentSetupView>('GET', `/bots/${botId}/setup`),
  startSetupInterview: (botId: string) => req<AgentSetupView>('POST', `/bots/${botId}/setup/interview`),
  activateSetup: (botId: string, revision: number) => req<AgentSetupView>('POST', `/bots/${botId}/setup/activate`, { revision }),
  settings: (botId: string) => req<BotSettingsBundle>('GET', `/bots/${botId}/settings`),
  updateBot: (botId: string, p: BotPatch) => req<{ bot: Bot }>('PATCH', `/bots/${botId}`, p),
  deleteBot: (botId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}`),
  makePrimary: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/primary`),
  fresh: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/fresh`),

  deleteMemory: (id: string) => req<{ ok: true }>('DELETE', `/memories/${id}`),

  createSkill: (botId: string, s: Pick<Skill, 'name' | 'description' | 'body'>) => req<{ skill: Skill }>('POST', `/bots/${botId}/skills`, s),
  updateSkill: (id: string, s: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => req<{ skill: Skill }>('PATCH', `/skills/${id}`, s),
  deleteSkill: (id: string) => req<{ ok: true }>('DELETE', `/skills/${id}`),

  setRoutine: (id: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${id}`, { enabled }),
  runRoutine: (id: string) => req<{ ok: true }>('POST', `/routines/${id}/run`),
  deleteRoutine: (id: string) => req<{ ok: true }>('DELETE', `/routines/${id}`),

  tasks: () => req<{ tasks: Task[] }>('GET', '/tasks'),
  botTasks: (botId: string) => req<{ tasks: Task[] }>('GET', `/bots/${botId}/tasks`),

  files: (botId: string, path = '', wake = false) => req<LibraryListing>('GET', `/bots/${botId}/files?path=${encodeURIComponent(path)}${wake ? '&wake=1' : ''}`),
  downloadFile: (botId: string, path: string) => req<{ url: string }>('POST', `/bots/${botId}/files/download`, { path }),

  computerDetails: () => req<ComputerDetails>('GET', '/computer/details'),
  wake: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),
  sleep: () => req<{ computer: ComputerState }>('POST', '/computer/suspend'),
  resetScreen: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/screen/reset`),
  pairPc: () => req<Pairing>('POST', '/computer/pair'),
  useThisComputer: () => req<{ ok: true }>('POST', '/computer/this-computer'),
  stopThisComputer: () => req<{ ok: true }>('DELETE', '/computer/this-computer'),
  keys: () => req<KeysResponse>('GET', '/settings/keys'),
  saveKey: (name: SettingKey, value: string) => req<KeysResponse>('PUT', `/settings/keys/${name}`, { value }),
  clearKey: (name: SettingKey) => req<KeysResponse>('DELETE', `/settings/keys/${name}`),
  models: (provider?: 'xai' | 'openrouter') => req<{ provider: 'xai' | 'openrouter'; models: ModelInfo[]; error?: string }>('GET', `/settings/models${provider ? `?provider=${provider}` : ''}`),
  unpairPc: () => req<{ ok: true; revoked: number }>('DELETE', '/computer/pair'),

  policies: () => req<{ policies: { tool: string; mode: string }[] }>('GET', '/policies'),
  deletePolicy: (tool: string) => req<{ ok: true }>('DELETE', `/policies/${encodeURIComponent(tool)}`),

  connectedApps: () => req<{ connectedApps?: Toolkit[]; connected: string[] }>('GET', '/apps?limit=1'),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),

  messaging: () => req<MessagingStatus>('GET', '/messaging'),
  messagingPrefs: (p: { forward?: 'all' | 'engaged'; activeBotId?: string | null; voiceReplies?: VoiceReplies; ttsVoice?: string | null }) => req<MessagingStatus>('PATCH', '/messaging/prefs', p),
  /** An mp3 sample of a voice-reply voice. */
  voiceSample: async (voice: string): Promise<Blob> => {
    const res = await fetch('/api/voice/preview', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice, codec: 'mp3', text: "Hi, it's your Bot. This is how my voice replies will sound." }) });
    if (!res.ok) throw new Error('Preview unavailable');
    return res.blob();
  },
  messagingCode: () => req<MessagingCode>('POST', '/messaging/code'),
  messagingUnlink: (channel: MessagingChannel) => req<MessagingStatus>('DELETE', `/messaging/links/${channel}`),
  messagingTest: () => req<{ ok: true }>('POST', '/messaging/test'),
  messagingEmail: (email: string) => req<MessagingStatus>('PUT', '/messaging/email', { email }),
  messagingMyInvite: () => req<{ url: string; remaining: number }>('POST', '/messaging/my-invite'),
  inkboxSaveKey: (adminKey: string) => req<MessagingStatus>('PUT', '/messaging/inkbox', { adminKey }),
  inkboxSetup,
  inkboxForget: () => req<MessagingStatus>('DELETE', '/messaging/inkbox'),
  messagingSignup: (p: Partial<MessagingOwner['signup']>) => req<MessagingStatus>('PUT', '/messaging/signup', p),
  invites: () => req<{ invites: MessagingInvite[] }>('GET', '/messaging/invites'),
  createInvite: (p: { maxUses?: number; expiresInDays?: number | null; note?: string }) => req<{ invite: MessagingInvite & { qr: string } }>('POST', '/messaging/invites', p),
  revokeInvite: (code: string) => req<{ ok: true }>('DELETE', `/messaging/invites/${encodeURIComponent(code)}`),
  waitlist: () => req<{ waitlist: WaitlistEntry[] }>('GET', '/messaging/waitlist'),
  approveWaitlist: (phone: string) => req<{ ok: true }>('POST', `/messaging/waitlist/${encodeURIComponent(phone)}/approve`),
  declineWaitlist: (phone: string) => req<{ ok: true }>('POST', `/messaging/waitlist/${encodeURIComponent(phone)}/decline`),

  // Public (no session): the join page and sign-in by text.
  joinInfo: (code: string) => req<JoinInfo>('GET', `/join/${encodeURIComponent(code)}`),
  claimInvite: (code: string, phone: string) => req<{ ok: true }>('POST', `/join/${encodeURIComponent(code)}/claim`, { phone }),
  textSignIn: (phone: string) => req<{ ok: true }>('POST', '/auth/text/request', { phone }),
  /** Continue with your phone number (signed out): a code reaches the phone; verifying signs in or creates the account. */
  phoneStart: (phone: string) => req<PhoneStart>('POST', '/auth/phone/start', { phone }),
  phoneVerify: (id: string, code: string, inviteCode?: string) => req<{ ok: true; created: boolean }>('POST', '/auth/phone/verify', { id, code, inviteCode }),
  /** Connect your phone (signed in): the same code flow, attaching the number to this account. */
  phoneAttachStart: (phone: string) => req<PhoneStart>('POST', '/messaging/phone/start', { phone }),
  phoneAttachVerify: (id: string, code: string) => req<MessagingStatus>('POST', '/messaging/phone/verify', { id, code }),
};
