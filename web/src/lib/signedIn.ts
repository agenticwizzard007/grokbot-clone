/**
 * After a full-page sign-in the server redirects to /?signed_in=1. Strip the marker and add one
 * in-app history entry so the first Back stays in Swarm instead of returning to a stale consent page.
 */
type Loc = Pick<Location, 'pathname' | 'search' | 'hash'>;
type Hist = Pick<History, 'replaceState' | 'pushState' | 'state'>;

export function consumeSignedInRedirect(loc: Loc = location, hist: Hist = history): boolean {
  const params = new URLSearchParams(loc.search);
  if (params.get('signed_in') !== '1') return false;
  params.delete('signed_in');
  const query = params.toString();
  const url = `${loc.pathname || '/'}${query ? `?${query}` : ''}${loc.hash}`;
  hist.replaceState({ ...(hist.state ?? {}), swarmEntry: 'signed-in' }, '', url);
  hist.pushState({ swarmEntry: 'app' }, '', url);
  return true;
}
