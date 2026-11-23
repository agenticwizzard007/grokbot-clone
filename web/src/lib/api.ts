import type { Bot, ComputerState, LiveState, Routine, Row, Toolkit, User } from '@shared/types';
import { isNativeApp } from './native';
import { requireActiveSession, revalidateSession } from './session';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
/** The session is valid, but this change needs a sign-in from the last few minutes. */
export const needsReauth = (err: unknown): err is ApiError => err instanceof ApiError && err.status === 401 && err.code === 'reauth_required';

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  requireActiveSession();
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  requireActiveSession();
  if (!res.ok) {
    let msg = res.statusText, code: string | undefined;
    try { const body = (await res.json()) as { error?: string; code?: string }; msg = body.error ?? msg; code = body.code; } catch { /* not json */ }
    if (res.status === 401 && code !== 'reauth_required') void revalidateSession();
    throw new ApiError(res.status, msg, code);
  }
  if (res.status === 204) return undefined as T;
  const result = await res.json() as T;
  requireActiveSession();
  return result;
}

export interface AppsResponse { apps: Toolkit[]; connected: string[]; connectedApps?: Toolkit[]; categories: string[]; total: number; nextOffset?: number | null; notConfigured?: boolean }
export type SuggestedToolkit = Omit<Toolkit, 'connected'> & { reason: string };

export interface RoomMember { id: string; name: string; label: string; avatarShape: string; avatarColor: string }

// The first paint uses a small window; explicit history reads can fetch more.
export const INITIAL_ROW_PAGE_SIZE = 24;
export const ROW_PAGE_SIZE = 200;
interface RowPage { generation: number; rows: Row[]; revision?: number; olderCursor?: number | null }

export const api = {
  me: (signal?: AbortSignal) => req<{ user: User | null; devLogin: boolean; googleLogin?: boolean; googleLinked?: boolean; appleLogin?: boolean; appleLinked?: boolean }>('GET', '/auth/me', undefined, signal),
  devLogin: (email: string, name?: string) => req<{ ok: true }>('POST', '/auth/dev', { email, name }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
  deleteAccount: (expectedUserId: string) => req<{ ok: true }>('DELETE', '/account', { confirmation: 'DELETE', expectedUserId }),

  bots: () => req<{ bots: Bot[]; live: LiveState[] }>('GET', '/bots'),
  createBot: (b: Pick<Bot, 'name' | 'avatarShape' | 'avatarColor' | 'mode'>) => req<{ bot: Bot }>('POST', '/bots', b),
  markRead: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/read`),
  rows: (id: string, beforeSeq?: number) => req<RowPage>('GET', `/bots/${id}/rows?${beforeSeq === undefined ? `limit=${INITIAL_ROW_PAGE_SIZE}` : `beforeSeq=${beforeSeq}&limit=${ROW_PAGE_SIZE}`}`),
  rowChanges: (id: string, afterRev: number, throughRev: number, minSeq: number) => req<{ generation: number; rows: Row[]; nextRev: number | null }>('GET', `/bots/${id}/row-changes?afterRev=${afterRev}&throughRev=${throughRev}&minSeq=${minSeq}`),
  send: (id: string, text: string, submissionId: string) => req<{ row: Row; jobIds: string[]; submissionId: string }>('POST', `/bots/${id}/messages`, { text, submissionId }),
  interrupt: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/interrupt`),
  fresh: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/fresh`),

  approve: (approvalId: string, decision: 'allow' | 'always' | 'deny') => req<{ ok: true }>('POST', `/approvals/${approvalId}`, { decision }),
  answer: (id: string, seq: number, answer: string) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/answer`, { answer }),
  dismiss: (id: string, seq: number) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/dismiss`),

  routines: (id: string) => req<{ routines: Routine[] }>('GET', `/bots/${id}/routines`),
  setRoutine: (rid: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${rid}`, { enabled }),

  computer: () => req<{ computer: ComputerState }>('GET', '/computer'),
  ensureComputer: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),

  apps: (search = '', category = '', offset = 0) => req<AppsResponse>('GET', `/apps?search=${encodeURIComponent(search)}&category=${encodeURIComponent(category)}&offset=${offset}`),
  suggestedApps: (botId: string, draft: { description: string; instructions: string }, signal?: AbortSignal) => req<{ suggestions: SuggestedToolkit[]; hasContext?: boolean }>('POST', `/bots/${encodeURIComponent(botId)}/suggested-apps`, draft, signal),
  connect: (slug: string, botId?: string, seq?: number) => req<{ redirectUrl: string }>('POST', `/apps/${slug}/connect`, { botId, seq }),
  disconnect: (slug: string) => req<{ ok: true }>('DELETE', `/apps/${slug}`),

  roomMembers: (id: string) => req<{ members: RoomMember[] }>('GET', `/rooms/${id}/members`),
  setRoomMembers: (id: string, botIds: string[]) => req<{ ok: true; members: string[] }>('PUT', `/rooms/${id}/members`, { botIds }),
  createRoom: (name: string, botIds: string[]) => req<{ id: string }>('POST', '/rooms', { name, botIds }),

  /** Everything waiting on the user across Bots: setup reviews, approvals, questions and connect cards (WS4). */
  needsYou: () => req<{ items: NeedsYouItem[] }>('GET', '/needs-you'),
  /** Account preferences (WS4). */
  preferences: () => req<AccountPreferences>('GET', '/account/preferences'),
  updatePreferences: (p: AccountPreferences) => req<AccountPreferences>('PATCH', '/account/preferences', p),
  /** Account fields the user can change (WS3: browser time zone on boot; WS4: Settings > Account). */
  updateMe: (patch: { timezone: string }) => req<{ user?: User | null; ok?: true }>('PATCH', '/auth/me', patch),
  skipSetup: (botId: string) => req<{ ok: true; bot: Bot }>('POST', `/bots/${botId}/setup/skip`),
  conversationSearch: (q: string) => req<{ results: ConversationSearchHit[] }>('GET', `/conversation-search?q=${encodeURIComponent(q)}`),
};

export interface NeedsYouItem { id: string; type: 'setup_review' | 'approval' | 'question' | 'connect'; botId: string; botName: string; title: string; createdAt: number; seq: number | null }
export interface AccountPreferences { askBeforeComputer: boolean }
export interface ConversationSearchHit { botId: string; botName: string; seq: number; generation: number; role: string; text: string; createdAt: number }

/** Open a Composio redirect in a centered popup. */
export function openPopup(url: string) {
  // WKWebView opens the final URL in the system browser. An empty popup cannot
  // provide a WindowProxy for the later async redirect.
  if (isNativeApp) return null;
  const w = 520, h = 680;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  return window.open(url, 'swarm-connect', `width=${w},height=${h},left=${left},top=${top}`);
}
