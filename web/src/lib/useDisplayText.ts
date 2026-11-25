import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import { stripInternalIds } from './stripInternalIds';

/** Clean display text only. Action identifiers and submitted values stay intact. */
export function useDisplayText() {
  // Presence, previews and unread counts change frequently during a live chat.
  // Only a name change affects redaction, including already rendered messages.
  const names = useStore(useShallow(s => Object.fromEntries(s.bots.map(bot => [bot.id, bot.name]))));
  return useCallback((text: string) => stripInternalIds(text, { botName: id => names[id] }), [names]);
}
