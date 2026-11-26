import { modelDisplayName } from './modelDisplay';

type SavedModel = { id: string; model: string | null };
const key = (accountId: string, bot: SavedModel) => `swarm.model-label:${accountId}:${bot.id}`;

/** Display-only memory. A stale label never enables choices, billing or effort controls. */
export function lastModelLabel(accountId: string | undefined, bot: SavedModel): string {
  try {
    const saved = accountId && JSON.parse(localStorage.getItem(key(accountId, bot)) ?? 'null');
    // Older releases saved this internal fallback instead of the visible plan label.
    if (saved?.model === bot.model && typeof saved.label === 'string' && saved.label && saved.label !== 'CLI default') return modelDisplayName('', saved.label);
  } catch { /* Private browsing or unavailable storage. */ }
  return bot.model ? modelDisplayName(bot.model) : 'Loading model';
}

export function rememberModelLabel(accountId: string | undefined, bot: SavedModel, label: string) {
  if (!accountId) return;
  try { localStorage.setItem(key(accountId, bot), JSON.stringify({ model: bot.model, label })); }
  catch { /* The saved Bot model still provides an immediate fallback. */ }
}
