import { create } from 'zustand';
import { DEFAULT_CONFIG, uiConfigSchema, type UiConfig } from '../../../server/src/ui-config/schema';
import { effectiveTokens } from '../../../server/src/ui-config/derive';
import { effectiveConfig } from '../../../server/src/ui-config/presets';
import type { PatchOp, StoredPreview, Violation, ApplyResult } from '../../../server/src/ui-config/service';
import type { ServerEvent } from '@shared/types';
import { uiRequest, UiApiError } from './api';

export const CACHE_KEY = 'swarm.ui.v1';
export const USER_KEY = 'swarm.ui.user';
export type UiStatus = 'loading' | 'ready' | 'offline' | 'disabled';
interface UiState {
  userId: string | null; saved: UiConfig; effective: UiConfig; revision: number; status: UiStatus;
  preview: StoredPreview | null; showBefore: boolean; safe: boolean; phone: boolean; invalidStored: boolean;
  errors: Violation[]; undoUntil: number;
}
const initial: UiState = { userId: null, saved: DEFAULT_CONFIG, effective: DEFAULT_CONFIG, revision: 0, status: 'loading', preview: null, showBefore: false, safe: false, phone: false, invalidStored: false, errors: [], undoUntil: 0 };
export const useCustomization = create<UiState>(() => initial);
let generation = 0;
let previewRequest = 0;
let expiry: ReturnType<typeof setTimeout> | undefined;
let refresh: Promise<void> | null = null;
let refreshAgain = false;
let undoTimer: ReturnType<typeof setTimeout> | undefined;
function offerUndo() { clearTimeout(undoTimer); update({ undoUntil: Date.now() + 30_000 }); undoTimer = setTimeout(() => update({ undoUntil: 0 }), 30_000); }

function update(partial: Partial<UiState>) {
  const next = { ...useCustomization.getState(), ...partial };
  const doc = next.safe || next.status === 'disabled' ? DEFAULT_CONFIG : next.preview && !next.showBefore ? next.preview.result : next.saved;
  const current = useCustomization.getState();
  const before = current.safe || current.status === 'disabled' ? DEFAULT_CONFIG : current.preview && !current.showBefore ? current.preview.result : current.saved;
  next.effective = doc === before && next.phone === current.phone ? current.effective : effectiveConfig(doc, next.phone);
  useCustomization.setState(next);
}
function storage(action: (store: Storage) => void) { try { action(localStorage); } catch { /* Private browsing can disable storage. */ } }
export function readCachedConfig(userId: string): { doc: UiConfig; revision: number } | null {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (cache?.userId !== userId || !Number.isSafeInteger(cache.revision) || cache.revision < 0) return null;
    const parsed = uiConfigSchema.safeParse(cache.doc);
    return parsed.success ? { doc: parsed.data, revision: cache.revision } : null;
  } catch { return null; }
}
function cacheSaved() {
  const { userId, saved: doc, revision, status } = useCustomization.getState();
  if (userId && status !== 'disabled') storage(store => store.setItem(CACHE_KEY, JSON.stringify({ userId, revision, doc, boot: { light: effectiveTokens(effectiveConfig(doc), 'light'), dark: effectiveTokens(effectiveConfig(doc), 'dark'), phoneLight: effectiveTokens(effectiveConfig(doc, true), 'light'), phoneDark: effectiveTokens(effectiveConfig(doc, true), 'dark') } })));
}
function accept(value: { doc: UiConfig; revision: number; status?: string }) {
  const parsed = uiConfigSchema.safeParse(value.doc);
  if (!parsed.success || !Number.isSafeInteger(value.revision)) throw new Error('Invalid appearance response.');
  if (value.revision < useCustomization.getState().revision) return;
  update({ saved: parsed.data, revision: value.revision, status: 'ready', invalidStored: value.status === 'invalid_stored', errors: [] });
  cacheSaved();
}
export function clearPreview() {
  ++previewRequest;
  clearTimeout(expiry);
  update({ preview: null, showBefore: false });
}
export function setUiUser(userId: string | null) {
  if (userId === useCustomization.getState().userId) return;
  ++generation; clearPreview(); refresh = null;
  const cached = userId ? readCachedConfig(userId) : null;
  update({ ...initial, safe: useCustomization.getState().safe, phone: useCustomization.getState().phone, userId,
    ...(cached ? { saved: cached.doc, revision: cached.revision } : {}) });
  storage(store => {
    if (userId) store.setItem(USER_KEY, userId);
    else { store.removeItem(USER_KEY); store.removeItem(CACHE_KEY); }
  });
  if (userId) void refreshUiConfig();
}
export async function refreshUiConfig(): Promise<void> {
  if (!useCustomization.getState().userId) return;
  if (refresh) { refreshAgain = true; return refresh; }
  const epoch = generation;
  refresh = (async () => {
    do {
      refreshAgain = false;
      try {
        const result = await uiRequest<{ doc: UiConfig; revision: number; status?: string }>('/config', { etag: useCustomization.getState().revision || undefined });
        if (epoch !== generation) return;
        if (result) accept(result); else update({ status: 'ready' });
      } catch (error) {
        if (epoch !== generation) return;
        if (error instanceof UiApiError && error.errors[0]?.code === 'disabled') {
          clearPreview(); update({ status: 'disabled', saved: DEFAULT_CONFIG, revision: 0 });
          storage(store => store.removeItem(CACHE_KEY));
        } else update({ status: 'offline' });
      }
    } while (refreshAgain && epoch === generation);
  })().finally(() => { if (epoch === generation) refresh = null; });
  return refresh;
}
export type UiPatchResult = { ok: true; revision: number } | { ok: false; errors: Violation[] };
export async function patchUiConfig(ops: PatchOp[], _intent?: string): Promise<UiPatchResult> {
  const { userId, revision } = useCustomization.getState(), epoch = generation;
  if (!userId) return { ok: false, errors: [{ path: '/', code: 'not_found', message: 'Sign in to continue.' }] };
  try {
    const result = await uiRequest<ApplyResult>('/config', { method: 'PATCH', body: { patch: ops }, revision });
    if (epoch !== generation) return { ok: false, errors: [{ path: '/', code: 'not_found', message: 'Your session has changed.' }] };
    if (!result?.ok) return result ?? { ok: false, errors: [] };
    clearPreview(); accept(result); offerUndo(); return { ok: true, revision: result.revision };
  } catch (error) {
    const errors = error instanceof UiApiError ? error.errors : [{ path: '/', code: 'invalid_value' as const, message: 'Could not save appearance. Try again when connected.' }];
    if (epoch === generation) { update({ errors }); if (error instanceof UiApiError && error.status === 409) await refreshUiConfig(); }
    return { ok: false, errors };
  }
}
export async function loadPreview(id: string) {
  const epoch = generation, request = ++previewRequest;
  if (!useCustomization.getState().userId || useCustomization.getState().safe) return;
  try {
    const value = await uiRequest<Omit<StoredPreview, 'userId'>>(`/previews/${encodeURIComponent(id)}`);
    if (epoch !== generation || request !== previewRequest || !value || value.status !== 'pending' || value.expiresAt <= Date.now()) return;
    const parsed = uiConfigSchema.safeParse(value.result);
    if (!parsed.success) return;
    clearTimeout(expiry);
    update({ preview: { ...value, userId: useCustomization.getState().userId!, result: parsed.data }, showBefore: false, errors: [] });
    expiry = setTimeout(clearPreview, Math.min(value.expiresAt - Date.now(), 2 ** 31 - 1));
  } catch { /* A stale or inaccessible preview never replaces the saved appearance. */ }
}
export async function applyPreview() {
  const { preview, revision } = useCustomization.getState(), epoch = generation;
  if (!preview) return;
  const result = await uiRequest<ApplyResult>(`/previews/${encodeURIComponent(preview.id)}/apply`, { method: 'POST', body: {}, revision });
  if (epoch !== generation) return;
  if (result?.ok) { clearPreview(); accept(result); offerUndo(); }
}
export async function discardPreview() {
  const { preview, revision } = useCustomization.getState();
  clearPreview();
  if (preview) await uiRequest(`/previews/${encodeURIComponent(preview.id)}/discard`, { method: 'POST', body: {}, revision });
}
export const setShowBefore = (showBefore: boolean) => update({ showBefore });
export const setUiPhone = (phone: boolean) => update({ phone });
export const setUiSafe = (safe: boolean) => { clearPreview(); update({ safe }); };
export async function handleUiEvent(event: ServerEvent, conversationBotId: string | null) {
  if (event.type === 'ui_config') { if (event.revision > useCustomization.getState().revision) await refreshUiConfig(); }
  if (event.type === 'ui_preview') {
    if (event.state === 'pending' && event.botId === conversationBotId) await loadPreview(event.previewId);
    else if (event.previewId === useCustomization.getState().preview?.id) clearPreview();
    if (event.state === 'applied') await refreshUiConfig();
  }
}

export async function recoverAppearance(action: 'reset' | 'undo') {
  const { revision } = useCustomization.getState(), epoch = generation;
  const result = await uiRequest<ApplyResult>(`/${action}`, { method: 'POST', body: action === 'reset' ? { scope: 'appearance' } : { steps: 1 }, revision });
  if (epoch === generation && result?.ok) { clearPreview(); accept(result); offerUndo(); }
}
