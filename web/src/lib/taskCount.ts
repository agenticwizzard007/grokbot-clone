type CountSource = { known: boolean; error?: boolean; loading?: boolean };

/** Never report a partial count as a complete count, including failed refreshes. */
export function taskCountState(sources: CountSource[]): 'loading' | 'unavailable' | 'ready' {
  if (sources.some(source => source.loading && (!source.known || source.error))) return 'loading';
  if (sources.some(source => source.error)) return 'unavailable';
  return sources.every(source => source.known) ? 'ready' : 'loading';
}

/** A bounded visible count keeps the slot stable; the accessible label stays exact. */
export const taskCountText = (count: number) => count > 99 ? '99+' : String(count);
