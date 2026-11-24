import { botSlug, routeBot, linkedWork, workHash, type WorkRoute } from './userRoutes';

export const APP_SECTIONS = ['general', 'keys', 'usage', 'computer', 'messaging', 'permissions', 'apps', 'mcp', 'account', 'subscriptions', 'learning'] as const;
export const BOT_TABS = ['general', 'skills', 'memories', 'routines', 'learning', 'analytics'] as const;
export type AppSection = typeof APP_SECTIONS[number];
export type BotSettingsTab = typeof BOT_TABS[number];
export type DetailTab = 'activity' | 'tasks' | 'library' | 'configuration';
export type SetupTab = 'responsibilities' | 'harness' | 'files' | 'history';
export type Screen =
  | { kind: 'bots' }
  | { kind: 'chat'; bot: string }
  | { kind: 'details'; bot: string; tab: DetailTab; setup?: SetupTab; reports?: boolean }
  | { kind: 'bot-settings'; bot: string; tab: BotSettingsTab }
  | { kind: 'settings'; section?: AppSection }
  | { kind: 'work'; route: WorkRoute }
  | { kind: 'create' | 'group' | 'search' | 'apps' };

export function parseScreen(hash: string): Screen | null {
  if (!hash.startsWith('#')) return null;
  if (hash === '#bots') return { kind: 'bots' };
  if (hash === '#new-bot') return { kind: 'create' };
  if (hash === '#new-bot/group') return { kind: 'group' };
  if (hash === '#search' || hash === '#apps/connect') return { kind: hash === '#search' ? 'search' : 'apps' };
  if (/^#settings\/?$/.test(hash)) return { kind: 'settings' };
  const section = hash.replace(/^#(?:settings\/)?/, '').replace(/^whatsapp$/, 'messaging');
  if (APP_SECTIONS.includes(section as AppSection)) return { kind: 'settings', section: section as AppSection };
  const work = linkedWork(hash);
  if (work) return { kind: 'work', route: work };
  const match = hash.match(/^#bot\/([^/]{1,256})(?:\/(.*))?$/);
  if (!match) return null;
  let bot: string;
  try { bot = decodeURIComponent(match[1]); } catch { return null; }
  if (!bot) return null;
  const parts = match[2]?.split('/') ?? [];
  if (!parts.length) return { kind: 'chat', bot };
  if (parts[0] === 'settings' && parts.length <= 2 && BOT_TABS.includes((parts[1] ?? 'general') as BotSettingsTab))
    return { kind: 'bot-settings', bot, tab: (parts[1] ?? 'general') as BotSettingsTab };
  if (parts[0] !== 'details' || parts.length > 3) return null;
  const detailTabs = { activity: 'activity', tasks: 'tasks', files: 'library', setup: 'configuration' } as const;
  const key = parts[1] ?? 'activity';
  const tab = Object.hasOwn(detailTabs, key) ? detailTabs[key as keyof typeof detailTabs] : null;
  if (!tab) return null;
  if (parts[2]) {
    if (tab === 'configuration' && ['responsibilities', 'harness', 'files', 'history'].includes(parts[2])) return { kind: 'details', bot, tab, setup: parts[2] as SetupTab };
    if (tab === 'library' && parts[2] === 'reports') return { kind: 'details', bot, tab, reports: true };
    return null;
  }
  return { kind: 'details', bot, tab };
}

export function screenHash(screen: Screen): string {
  switch (screen.kind) {
    case 'bots': return '#bots';
    case 'chat': return `#bot/${encodeURIComponent(screen.bot)}`;
    case 'details': return `#bot/${encodeURIComponent(screen.bot)}/details/${({ activity: 'activity', tasks: 'tasks', library: 'files', configuration: 'setup' })[screen.tab]}${screen.setup ? `/${screen.setup}` : screen.reports ? '/reports' : ''}`;
    case 'bot-settings': return `#bot/${encodeURIComponent(screen.bot)}/settings/${screen.tab}`;
    case 'settings': return `#settings${screen.section ? `/${screen.section}` : ''}`;
    case 'work': return workHash(screen.route);
    case 'create': return '#new-bot';
    case 'group': return '#new-bot/group';
    case 'search': return '#search';
    case 'apps': return '#apps/connect';
  }
}

export function parentScreen(screen: Screen): Screen {
  switch (screen.kind) {
    case 'group': return { kind: 'create' };
    case 'details': case 'bot-settings': return { kind: 'chat', bot: screen.bot };
    case 'settings': return screen.section ? { kind: 'settings' } : { kind: 'bots' };
    default: return { kind: 'bots' };
  }
}

/** Delay scoped links until the roster arrives; never resolve across accounts. */
export function resolveScreen(screen: Screen, bots: { id: string; name: string }[], loaded: boolean): Screen | null {
  if ('bot' in screen) {
    const bot = routeBot(screen.bot, bots);
    if (!bot) return loaded ? { kind: 'bots' } : null;
    return { ...screen, bot: botSlug(bot) };
  }
  if (screen.kind === 'work' && screen.route.botSlug) {
    const bot = routeBot(screen.route.botSlug, bots);
    if (bot) return { kind: 'work', route: { ...screen.route, botSlug: botSlug(bot) } };
  }
  return screen;
}

export interface NavigationEntry { account: string; hash: string; trail: string[] }
interface Browser {
  location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  history: Pick<History, 'state' | 'pushState' | 'replaceState' | 'go'>;
}
/** A trail contains only entries created in this app for this account. It survives
 * reload in history.state, so an in-app Back never guesses from history.length. */
export class ScreenHistory {
  private current?: NavigationEntry;
  private undoing = false;
  constructor(private browser: Browser, private account: () => string,
    private apply: (screen: Screen) => void,
    private guard: (screen: Screen, proceed: () => void) => boolean = (_screen, proceed) => { proceed(); return true; }) {}
  private read(): NavigationEntry | undefined {
    const value = this.browser.history.state?.swarmNavigation;
    return value?.account === this.account() && typeof value.hash === 'string' && Array.isArray(value.trail) && value.trail.every((h: unknown) => typeof h === 'string') ? value : undefined;
  }
  private write(entry: NavigationEntry, mode: 'push' | 'replace') {
    const { history, location } = this.browser;
    history[mode === 'push' ? 'pushState' : 'replaceState']({ ...history.state, swarmNavigation: entry }, '', location.pathname + location.search + entry.hash);
    this.current = entry;
  }
  get trail(): string[] { return this.read()?.trail ?? []; }
  get screen(): Screen | null { return parseScreen(this.browser.location.hash); }
  reset() { this.current = undefined; }
  initialize(fallback: Screen) {
    const screen = this.screen ?? fallback;
    const hash = screenHash(screen);
    const entry = this.read();
    this.write({ account: this.account(), hash, trail: entry?.hash === this.browser.location.hash ? entry.trail : [] }, 'replace');
    this.apply(screen);
  }
  navigate(screen: Screen, mode: 'push' | 'replace' = 'push') {
    this.guard(screen, () => {
      const hash = screenHash(screen);
      let entry = this.read();
      if (!entry || entry.hash !== this.browser.location.hash) {
        entry = { account: this.account(), hash: parseScreen(this.browser.location.hash) ? this.browser.location.hash : '#bots', trail: [] };
        this.write(entry, 'replace');
      }
      if (hash !== entry.hash) this.write({ account: this.account(), hash, trail: mode === 'push' ? [...entry.trail, entry.hash] : entry.trail }, mode);
      else this.current = entry;
      this.apply(screen);
    });
  }
  /** Close a whole surface (Settings, Create, details), retaining its Forward entries. */
  back(fallback: Screen, matches: (screen: Screen) => boolean = () => true) {
    const trail = this.trail;
    for (let i = trail.length - 1; i >= 0; i--) {
      const screen = parseScreen(trail[i]);
      if (screen && matches(screen)) { this.browser.history.go(i - trail.length); return; }
    }
    this.navigate(fallback, 'replace');
  }
  restore = () => {
    if (this.undoing) { this.undoing = false; return; }
    const { location } = this.browser;
    if (this.current?.hash === location.hash && this.read()?.hash === location.hash) return; // popstate also emits hashchange
    const screen = this.screen;
    if (!screen) return; // OAuth callback fragments belong to authCallback.ts
    const previous = this.current;
    let entry = this.read();
    // An anchor/address-bar hash adds a browser entry while copying the old state.
    if (!entry || entry.hash !== location.hash) {
      entry = { account: this.account(), hash: location.hash, trail: previous?.account === this.account() ? [...previous.trail, previous.hash] : [] };
      this.write(entry, 'replace');
    }
    const destination = entry;
    const delta = previous ? destination.trail.length - previous.trail.length : 0;
    let deferred = false;
    const accepted = this.guard(screen, () => {
      if (deferred && delta) { this.browser.history.go(delta); return; }
      this.current = destination;
      this.apply(screen);
    });
    if (!accepted && previous) {
      deferred = true;
      this.current = previous;
      if (delta) { this.undoing = true; this.browser.history.go(-delta); }
      else this.write(previous, 'replace');
    }
  };
}

// The data store calls this bridge without importing the UI store (no module cycle).
export const navigationActions: {
  chat?: (id: string, replace?: boolean) => void;
  modal?: (kind: 'create' | 'group' | 'search' | 'apps' | null) => void;
  details?: (open: boolean) => void;
  list?: () => void;
} = {};
