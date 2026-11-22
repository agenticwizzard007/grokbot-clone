/** "Open Bot details with each chat": a per-account preference, separate from whether the panel is open right now. */
export const detailsDefaultKey = (userId: string) => `swarm.${userId}.detailsDefault`;

export function readDetailsDefault(userId: string | null | undefined): boolean {
  if (!userId) return false;
  try { return localStorage.getItem(detailsDefaultKey(userId)) === '1'; } catch { return false; }
}

export function writeDetailsDefault(userId: string | null | undefined, on: boolean): void {
  if (!userId) return;
  try { localStorage.setItem(detailsDefaultKey(userId), on ? '1' : '0'); } catch { /* storage unavailable */ }
}
