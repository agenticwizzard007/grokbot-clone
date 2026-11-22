import { useCallback } from 'react';
import { api } from './api';
import { confirmDialog } from './confirmDialog';
import { toast } from './toast';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';

export const FRESH_CONFIRM = {
  title: 'Start a new conversation?',
  body: 'The current chat will be cleared from view. Past messages stay in memory and analytics but leave this view.',
  confirmLabel: 'Start new conversation',
} as const;

const inFlight = new Set<string>();

/** A late reply must not post a receipt over another Bot's chat. */
function stillHere(botId: string, accountId: string | undefined) {
  const state = useStore.getState();
  if (state.user?.id !== accountId) return false;
  const settings = useConfigUI.getState().botSettings;
  return settings ? settings.botId === botId : state.selectedBotId === botId;
}

/** Ask, clear the conversation on the server, drop the old rows from view, and confirm with a toast. */
export async function startFreshConversation(botId: string): Promise<void> {
  if (inFlight.has(botId)) return;
  if (!await confirmDialog(FRESH_CONFIRM)) return;
  inFlight.add(botId);
  const accountId = useStore.getState().user?.id;
  try {
    await api.fresh(botId);
    const state = useStore.getState();
    if (state.user?.id !== accountId) return;
    // The `cleared` event normally resets the view. Reload too, so a missed event cannot leave
    // older-generation rows (such as a stale greeting) on screen: loadRows replaces the transcript
    // whenever the server reports a newer generation.
    await state.loadRows(botId).catch(() => {});
    if (stillHere(botId, accountId)) toast('Started a new conversation');
  } catch (error) {
    if (stillHere(botId, accountId)) toast((error as Error).message || 'Could not start a new conversation', { tone: 'error' });
  } finally {
    inFlight.delete(botId);
  }
}

export function useFreshConversation(botId: string): () => Promise<void> {
  return useCallback(() => startFreshConversation(botId), [botId]);
}
