import '../handoffs/polish.css';
import type { FlowModel, FlowNode } from '@shared/flow/model-types';
import type { HandoffLink } from '@shared/handoffs/contracts';
import { ApiError } from '../lib/api';
import { requireActiveSession, revalidateSession } from '../lib/session';
import { navigation, useConfigUI } from '../configStore';
import { useStore } from '../store';
import { parseScreen } from '../lib/navigation';
import { botSlug } from '../lib/userRoutes';

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  requireActiveSession();
  const result = await fetch(`/api${path}`, { method, credentials: 'include', signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  requireActiveSession();
  if (!result.ok) {
    const error = await result.json().catch(() => ({}));
    if (result.status === 401) void revalidateSession();
    throw new ApiError(result.status, error.error || 'Flow is unavailable.', error.code);
  }
  return result.json();
}
export type LinkInput = Pick<HandoffLink, 'toBotId' | 'mode' | 'trigger' | 'template' | 'autoApproveLoops'>;
export const flowApi = {
  hasRuns: async (id: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/bots/${encodeURIComponent(id)}/flow`, { credentials: 'include', signal });
    if (response.status === 503) { const error = await response.json().catch(() => ({})); if (error.code === 'disabled') throw new ApiError(503, error.error, error.code); }
    return !response.ok || response.headers.get('X-Flow-Has-Runs') !== '0';
  },
  get: async (id: string, signal?: AbortSignal) => {
    const model = await request<FlowModel>(`/bots/${encodeURIComponent(id)}/flow`, 'GET', undefined, signal);
    if (!model || !Array.isArray(model.lanes) || !Array.isArray(model.warnings) || !model.loopBack
      || model.lanes.some(lane => !lane || !Array.isArray(lane.nodes))) {
      throw new Error('Flow is unavailable. Try again.');
    }
    return model;
  },
  refresh: (id: string) => request<{ accepted: boolean; retryAfter: number }>(`/bots/${encodeURIComponent(id)}/flow/refresh`, 'POST', {}),
  links: (id: string) => request<{ links: HandoffLink[] }>(`/handoff-links?botId=${encodeURIComponent(id)}`),
  saveLinks: (id: string, links: LinkInput[]) => request<{ links: HandoffLink[] }>(`/handoff-links?botId=${encodeURIComponent(id)}`, 'PUT', { links }),
};

// Flow links use the shared route history, including cold entry and Back.
const FLOW = /^#bot\/([^/]+)\/details\/flow(?:\?link=([^&]+))?$/;
export const flowLocation = () => { const match = location.hash.match(FLOW); try { return match ? { bot: decodeURIComponent(match[1]), link: match[2] ? decodeURIComponent(match[2]) : null } : null; } catch { return null; } };
const announce = () => window.dispatchEvent(new Event('swarm:flow-location'));
let returnNode: { account?: string; botId: string; nodeId: string } | undefined;
export function openFlow(botId: string, link?: string, replace = false) {
  const st = useStore.getState(), bot = st.bots.find(b => b.id === botId && b.kind !== 'room');
  if (!bot) return;
  const current = flowLocation();
  const target = { kind: 'details', bot: botSlug(bot), tab: 'activity', flow: true, ...(link ? { link } : {}) } as const;
  const previous = parseScreen(navigation.trail.at(-1) ?? '');
  if (replace && current?.link && !link && previous?.kind === 'details' && previous.flow && previous.bot === target.bot) {
    navigation.backTo(target);
  } else navigation.navigate(target, replace ? 'replace' : 'push');
  announce();
}
export function openFlowNode(botId: string, node: FlowNode) {
  returnNode = { account: useStore.getState().user?.id, botId, nodeId: node.id };
  const link = node.target.hash.match(FLOW);
  if (link) { openFlow(botId, link[2] ? decodeURIComponent(link[2]) : undefined); return; }
  const screen = parseScreen(node.target.hash);
  if (!screen) { location.hash = node.target.hash; return; }
  navigation.navigate(screen);
  history.replaceState({ ...history.state, flowFocus: node.target.focus }, '');
  if (node.target.focus) window.dispatchEvent(new CustomEvent('swarm:flow-focus', { detail: node.target.focus }));
}
export function restoreFlowFocus(botId: string, root: HTMLElement | null) {
  if (returnNode?.botId !== botId || returnNode.account !== useStore.getState().user?.id) return;
  const target = [...(root?.querySelectorAll<HTMLElement>('[data-flow-node]') ?? [])].find(el => el.dataset.flowNode === returnNode?.nodeId);
  if (target?.getClientRects().length && !target.closest('[hidden], [inert]')) { target.focus({ preventScroll: true }); if (document.activeElement === target) returnNode = undefined; }
}
window.addEventListener('hashchange', announce);
window.addEventListener('popstate', announce);
// The shared per-user SSE handler invalidates mounted Flow surfaces.
export function notifyFlow(botId: string) { useConfigUI.getState().bump(`flow:${botId}`); }
