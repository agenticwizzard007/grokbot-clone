import type { ServerEvent } from '../types.js';

export type UiEvent = Extract<ServerEvent, { type: 'ui_config' | 'ui_preview' }>;
export type UiEventSink = (userId: string, event: UiEvent) => void;

export const previewEvent = (previewId: string, actor: string, state: 'pending' | 'applied' | 'discarded' | 'expired'): UiEvent => ({
  type: 'ui_preview', previewId, botId: actor.startsWith('agent:') ? actor.slice(6) : '', state,
});
