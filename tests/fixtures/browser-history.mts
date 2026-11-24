/** Browser history fixture with Back/Forward and route events, including copied
 * state on an address-bar hash link. No network or DOM required. */
export function browserHistory(initialHash = '') {
  const location = { pathname: '/', search: '', hash: initialHash };
  const entries: { hash: string; state: any }[] = [{ hash: initialHash, state: null }];
  const listeners = new Map<string, Set<() => void>>();
  let index = 0;
  const urls: string[] = [];
  const emit = (type: string) => listeners.get(type)?.forEach(fn => fn());
  const history = {
    get state() { return entries[index].state; },
    get index() { return index; },
    pushes: 0,
    replaceState(state: any, _title: string, url?: string | URL | null) {
      if (url != null) { urls.push(String(url)); location.hash = new URL(url, 'http://localhost').hash; }
      entries[index] = { state, hash: location.hash };
    },
    pushState(state: any, title: string, url?: string | URL | null) {
      this.pushes++; entries.splice(++index); this.replaceState(state, title, url);
    },
    go(delta: number) {
      if (index + delta < 0 || index + delta >= entries.length) throw Error('History left the app');
      index += delta; location.hash = entries[index].hash; emit('popstate'); emit('hashchange');
    },
    back() { this.go(-1); },
  };
  const window = { location, history, addEventListener(type: string, fn: () => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); }, dispatchEvent() { return true; } };
  return { window, location, history, entries, urls,
    reset(hash = '') { index = 0; entries.splice(0, entries.length, { hash, state: null }); location.hash = hash; },
    link(hash: string) { history.pushState(history.state, '', hash); emit('popstate'); emit('hashchange'); },
  };
}
