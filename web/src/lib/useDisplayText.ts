import { useStore } from '../store';
import { stripInternalIds } from './stripInternalIds';

/** Clean display text only. Action identifiers and submitted values stay intact. */
export function useDisplayText() {
  const bots = useStore(s => s.bots);
  return (text: string) => stripInternalIds(text, { botName: id => bots.find(bot => bot.id === id)?.name });
}
