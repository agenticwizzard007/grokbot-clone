/** Stored conversation size compared with the automatic summary threshold, in characters. */
export function conversationUsagePercent(historyChars: number, compactAtChars: number): number | null {
  if (!Number.isFinite(historyChars) || !Number.isFinite(compactAtChars) || compactAtChars <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(historyChars / compactAtChars * 100)));
}
