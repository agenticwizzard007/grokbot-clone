import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Blocks, ChevronLeft, ChevronRight, CircleUserRound, Gauge, KeyRound, MessageCircle, Monitor, Search, Server, Settings as SettingsIcon, ShieldCheck, Terminal, X, type LucideIcon } from 'lucide-react';
import type { Toolkit } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type ComputerDetails, type KeysResponse, type KeyStatus, type Pairing } from '../../lib/configApi';
import { ModelPicker, refreshModels } from './ModelPicker';
import { UsageSection } from './UsageSection';
import { relativeShort } from '../../lib/time';
import { useConfigUI, type AppSection, type Theme } from '../../configStore';
import { useStore } from '../../store';
import { computerStatusText } from '../DetailsPanel';
import { ToolkitLogo } from '../ToolkitLogo';
import { ConfirmButton, Segmented, Switch } from './ui';
import { McpSettings } from './McpSettings';
import { MessagingSettings } from './MessagingSettings';
import { SubscriptionSettings } from './SubscriptionSettings';
import { OpenRouterSettings } from './OpenRouterSettings';
import { AppleSignIn } from '../AppleSignIn';
import { api } from '../../lib/api';
import { useCompactLayout } from '../../lib/useCompactLayout';
import { isNativeApp } from '../../lib/native';
import '../../styles/settings.css';

// Design: Paper › "Swarm — Mobile" › "Settings · Redesign" (desktop, phone, Mac and iPhone app boards).
type NavItem = { id: AppSection; label: string; icon: LucideIcon; keywords: string };
const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Personal', items: [
    { id: 'general', label: 'General', icon: SettingsIcon, keywords: 'theme dark light appearance layout sidebar details panel keyboard shortcuts' },
    { id: 'account', label: 'Account', icon: CircleUserRound, keywords: 'profile name email sign out log out apple delete' },
    { id: 'messaging', label: 'Messaging', icon: MessageCircle, keywords: 'imessage sms text phone number whatsapp voice replies invite friends contact' },
    { id: 'usage', label: 'Usage', icon: Gauge, keywords: 'cost spend money dollars tokens requests billing limits' },
  ] },
  { group: 'Bots', items: [
    { id: 'computer', label: 'Computer', icon: Monitor, keywords: 'vm cloud browser screen desktop pc companion sleep wake reset' },
    { id: 'permissions', label: 'Permissions', icon: ShieldCheck, keywords: 'approvals always allow ask again tools' },
  ] },
  { group: 'Integrations', items: [
    { id: 'apps', label: 'Connected apps', icon: Blocks, keywords: 'composio gmail google calendar slack notion integrations connect' },
    { id: 'mcp', label: 'MCP servers', icon: Server, keywords: 'mcp custom tools server url command stdio headers token' },
    { id: 'subscriptions', label: 'Subscriptions', icon: Terminal, keywords: 'chatgpt codex claude code cli bridge connect subscription plan login auth api' },
    { id: 'keys', label: 'API keys', icon: KeyRound, keywords: 'openrouter model provider key composio default model platform voice xai admin' },
  ] },
];
const matches = (it: NavItem, q: string) => {
  const hay = `${it.label} ${it.keywords}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};
const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Full-window settings, opened from the account menu or ⌘,. Phones get a section list that drills into each page. */
export function AppSettings() {
  const section = useConfigUI((s) => s.appSettings);
  const home = useConfigUI((s) => s.appSettingsHome);
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  const theme = useConfigUI((s) => s.theme);
  const computer = useStore((s) => s.computer);
  const compact = useCompactLayout();
  const [listView, setListView] = useState(home);
  const [query, setQuery] = useState('');
  const main = useRef<HTMLDivElement>(null);
  const state = useRef({ query, compact, listView });
  state.current = { query, compact, listView };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal-root')) return;
      e.preventDefault();
      const st = state.current;
      if (st.query && (e.target as HTMLElement | null)?.closest?.('.settings-search')) setQuery('');
      else if (st.compact && !st.listView) setListView(true);
      else close();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);
  useEffect(() => { main.current?.scrollTo({ top: 0 }); }, [section, listView]);

  if (!section) return null;
  const pick = (id: AppSection) => { open(id); setListView(false); setQuery(''); };
  const q = query.trim();
  const groups = q ? NAV.map((g) => ({ ...g, items: g.items.filter((it) => matches(it, q)) })).filter((g) => g.items.length) : NAV;
  const valueFor = (id: AppSection) => (id === 'general' ? THEME_LABEL[theme] : id === 'computer' && computer ? computerStatusText(computer) : null);
  // Up/Down move between sections, like a native sidebar.
  const arrows = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.settings-nav__item')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0 && !(document.activeElement as HTMLElement | null)?.closest('.settings-search')) return;
    e.preventDefault();
    items[at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };

  const nav = (
    <nav className="settings-nav" aria-label="Settings sections" onKeyDown={arrows}>
      <button type="button" className="settings-nav__back" onClick={close} aria-label="Back to Bots">
        {compact ? <ChevronLeft size={24} strokeWidth={2} aria-hidden /> : <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />}
        <span>{compact ? 'Bots' : 'Back to Bots'}</span>
      </button>
      <h2 className="settings-nav__title">Settings</h2>
      <label className="settings-search">
        <Search size={compact ? 18 : 16} strokeWidth={1.75} aria-hidden />
        <input
          type="search" value={query} placeholder="Search settings" aria-label="Search settings" autoComplete="off" spellCheck={false} enterKeyHint="go"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && groups[0]) { e.preventDefault(); pick(groups[0].items[0].id); } }}
        />
      </label>
      {groups.map((g) => (
        <div key={g.group} className="settings-nav__group" role="group" aria-label={g.group}>
          <div className="settings-nav__label" aria-hidden>{g.group}</div>
          <div className="settings-nav__items">
            {g.items.map((it) => {
              const active = !compact && section === it.id;
              const value = compact ? valueFor(it.id) : null;
              return (
                <button key={it.id} type="button" className={`cfg-nav__item settings-nav__item${active ? ' is-active' : ''}`} onClick={() => pick(it.id)} aria-current={active ? 'page' : undefined}>
                  <it.icon className="settings-nav__icon" size={compact ? 20 : 18} strokeWidth={1.75} aria-hidden />
                  <span className="settings-nav__text">{it.label}</span>
                  {value && <span className="settings-nav__value">{value}</span>}
                  {compact && <ChevronRight className="settings-nav__chev" size={16} strokeWidth={2} aria-hidden />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {!groups.length && <div className="settings-nav__empty" role="status">No settings match “{q}”.</div>}
    </nav>
  );

  const showList = compact && listView;
  return createPortal(
    <div className={`app-settings${showList ? ' is-list' : ''}`} role="dialog" aria-modal="true" aria-label="Settings">
      {!compact && <aside className="app-settings__nav">{nav}</aside>}
      <div className="app-settings__main" ref={main}>
        {showList ? nav : <>
          {compact
            ? <button type="button" className="settings-page-back" onClick={() => setListView(true)}><ChevronLeft size={24} strokeWidth={2} aria-hidden /><span>Settings</span></button>
            : <button type="button" className="app-settings__close icon-btn" onClick={close} aria-label="Close settings" title="Close (Esc)"><X size={18} strokeWidth={1.75} aria-hidden /></button>}
          <div className="app-settings__page" key={section}>
            {section === 'general' && <GeneralSection />}
            {section === 'keys' && <KeysSection />}
            {section === 'usage' && <UsageSection />}
            {section === 'computer' && <ComputerSection />}
            {section === 'messaging' && <MessagingSettings />}
            {section === 'permissions' && <PermissionsSection />}
            {section === 'apps' && <AppsSection />}
            {section === 'mcp' && <McpSettings />}
            {section === 'subscriptions' && <SubscriptionSettings />}
            {section === 'account' && <AccountSection />}
          </div>
        </>}
      </div>
    </div>,
    document.body,
  );
}

function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="app-settings__head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

/** A settings row: title and description on the left, its control on the right. */
export function SettingRow({ title, sub, children, wrap }: { title: string; sub?: string; children?: ReactNode; wrap?: boolean }) {
  return (
    <div className={`cfg-row${wrap ? ' settings-row--wrap' : ''}`}>
      <div className="cfg-row__text">
        <div className="cfg-row__title">{title}</div>
        {sub && <div className="cfg-row__sub">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Keys({ keys }: { keys: string[] }) {
  return <span className="settings-keys" aria-label={keys.join(' ')}>{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</span>;
}

// ---------------------------------------------------------------------------

function GeneralSection() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
  const detailsOpen = useStore((s) => s.detailsOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const compact = useCompactLayout();
  const mod = IS_MAC ? '⌘' : 'Ctrl';
  const shift = IS_MAC ? '⇧' : 'Shift';
  const shortcuts: [string, string[]][] = [
    ['Search Bots and chats', [mod, 'K']],
    // In the Mac app ⌘, opens the app's own server settings, so it never reaches this page.
    ...(isNativeApp ? [] : [['Open settings', [mod, ',']] as [string, string[]]]),
    ['Focus the message box', [mod, 'I']],
    ['Show or hide the sidebar', [mod, 'B']],
    ['Show or hide Bot details', [shift, mod, ',']],
  ];
  return (
    <>
      <PageHead title="General" />
      <section className="cfg-section">
        <h2 className="cfg-section__label">Appearance</h2>
        <div className="cfg-card">
          <SettingRow title="Theme" sub="Match your device, or always use light or dark." wrap>
            <Segmented label="Theme" value={theme} onChange={setTheme} options={(['system', 'light', 'dark'] as const).map((t) => ({ value: t, label: THEME_LABEL[t] }))} />
          </SettingRow>
        </div>
      </section>
      {!compact && (
        <section className="cfg-section">
          <h2 className="cfg-section__label">Layout</h2>
          <div className="cfg-card">
            <SettingRow title="Bot details panel" sub="Show a Bot’s tasks, files and settings next to the chat.">
              <Switch label="Bot details panel" on={detailsOpen} onChange={(v) => useStore.getState().set({ detailsOpen: v })} />
            </SettingRow>
            <SettingRow title="Compact sidebar" sub="Show only Bot avatars in the sidebar to give chats more room.">
              <Switch label="Compact sidebar" on={collapsed} onChange={(v) => useStore.getState().set({ sidebarCollapsed: v })} />
            </SettingRow>
          </div>
        </section>
      )}
      {!compact && (
        <section className="cfg-section">
          <h2 className="cfg-section__label">Keyboard shortcuts</h2>
          <div className="cfg-card settings-shortcuts">
            {shortcuts.map(([label, keys]) => <SettingRow key={label} title={label}><Keys keys={keys} /></SettingRow>)}
          </div>
          {IS_MAC && !isNativeApp && <div className="cfg-field__hint">On Windows and Linux, use Ctrl instead of ⌘.</div>}
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// API keys: the server's provider keys, entered in the app and verified before saving.

const sourceText = (s: KeyStatus) => (s.source === 'app' ? 'saved in the app' : s.source === 'env' ? 'from the server’s .env file' : '');

function KeyCard({ name, title, what, link, status, canEdit, required, onChange }: {
  name: 'voice' | 'direct' | 'composio' | 'openrouter'; title: string; what: string; link?: { href: string; label: string };
  status: KeyStatus; canEdit: boolean; required?: boolean; onChange: (r: KeysResponse) => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const save = async () => {
    setBusy('save'); setNote(null);
    try {
      const r = await configApi.saveKey(name, value.trim());
      setValue('');
      setNote({ tone: 'ok', text: r.modelOk === false ? `Key works, but ${r.model.value} isn’t available on it. Pick a model above.` : 'Verified and saved. Bots use it right away.' });
      onChange(r);
    } catch (e) { setNote({ tone: 'error', text: (e as Error).message }); }
    finally { setBusy(null); }
  };
  const clear = async () => {
    setBusy('clear'); setNote(null);
    try { onChange(await configApi.clearKey(name)); } catch (e) { setNote({ tone: 'error', text: (e as Error).message }); }
    finally { setBusy(null); }
  };
  return (
    <div className="cfg-card cfg-key">
      <div className="cfg-row">
        <span className={`computer-status-dot is-${status.set ? 'on' : 'off'}`} aria-hidden />
        <div className="cfg-row__text">
          <div className="cfg-row__title">{title} · {status.set ? 'Connected' : required ? 'Needed' : 'Not set'}</div>
          <div className="cfg-row__sub">{what}{status.set && canEdit ? ` ${status.hint ? `Key ${status.hint}, ` : 'Key '}${sourceText(status)}.` : ''}</div>
        </div>
        {status.source === 'app' && canEdit && (
          <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Remove key" onConfirm={clear}>{busy === 'clear' ? 'Removing…' : 'Remove'}</ConfirmButton>
        )}
      </div>
      {canEdit ? (
        <form className="cfg-key__form" onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void save();
          else { document.getElementById(`key-input-${name}`)?.focus(); setNote({ tone: 'error', text: 'Paste your key in the box first.' }); }
        }}>
          <input id={`key-input-${name}`} className="text-input cfg-key__input" type="password" autoComplete="off" spellCheck={false} placeholder={status.set ? 'Paste a new key to replace it' : 'Paste your key'} value={value} onChange={(e) => { setValue(e.target.value); if (note?.tone === 'error') setNote(null); }} aria-label={`${title} API key`} />
          <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!!busy}>{busy === 'save' ? 'Verifying…' : 'Save & verify'}</button>
        </form>
      ) : null}
      <div className="cfg-key__foot">
        {note
          ? <span className={note.tone === 'error' ? 'cfg-key__err' : 'cfg-key__ok'} role="status">{note.text}</span>
          : name === 'voice' && !canEdit ? 'Managed by your platform admin. No personal voice key is needed.'
            : link ? <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a> : 'Use any compatible provider key.'}
      </div>
    </div>
  );
}

function KeysSection() {
  return <>
    <PageHead title="API keys" sub="Manage model connections and shared platform services." />
    <OpenRouterSettings />
    <ServerKeysSection />
  </>;
}

function ServerKeysSection() {
  const [keys, setKeys] = useState<KeysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  useEffect(() => { configApi.keys().then(setKeys).catch((e) => setError((e as Error).message)); }, []);
  // Keep fields the save response may not repeat (e.g. canEdit).
  const changed = (r: KeysResponse) => { setKeys((k) => (k ? { ...k, ...r } : r)); refreshModels(); setPickerKey((n) => n + 1); };
  const save = async (name: 'provider' | 'model' | 'openrouter_model', value: string) => {
    setNote(null);
    try { changed(await configApi.saveKey(name, value)); setNote({ tone: 'ok', text: 'Saved. Bots use it from their next message.' }); }
    catch (e) { setNote({ tone: 'error', text: (e as Error).message }); }
  };

  if (error) return <div className="cfg-error">Could not load server defaults: {error}</div>;
  if (!keys) return <div className="cfg-empty cfg-empty--flat">Loading server defaults…</div>;
  const running = keys.provider.value;
  const chosen = keys.provider.chosen ?? running;
  const keyFor = (p: 'direct' | 'openrouter') => (p === 'openrouter' ? keys.openrouter.set : keys.direct.set);
  const nameOf = (p: 'direct' | 'openrouter') => (p === 'openrouter' ? 'OpenRouter' : 'custom provider');
  const current = chosen === 'openrouter' ? keys.openrouterModel.value : keys.model.value;
  // OpenRouter's catalog is public, so a model can be chosen before the key is added; direct provider needs the key.
  const canPick = keys.canEdit && (chosen === 'openrouter' || keys.direct.set);
  const choose = async (p: 'direct' | 'openrouter') => {
    if (p === chosen) { if (!keyFor(p)) document.getElementById(`key-input-${p}`)?.focus(); return; }
    await save('provider', p);
    if (!keyFor(p)) {
      document.getElementById(`key-input-${p}`)?.focus();
      setNote({ tone: 'ok', text: `Paste your ${nameOf(p)} key below to finish switching.${keyFor(p === 'direct' ? 'openrouter' : 'direct') ? ` Until then Bots keep using ${nameOf(p === 'direct' ? 'openrouter' : 'direct')}.` : ''}` });
    }
  };
  const status = !keyFor(chosen)
    ? keyFor(running) && running !== chosen
      ? `Waiting for your ${nameOf(chosen)} key. Bots use ${running === 'openrouter' ? keys.openrouterModel.value : keys.model.value} through ${nameOf(running)} until then.`
      : `Add your ${nameOf(chosen)} key below so Bots can run.`
    : `Bots use ${current} through ${nameOf(chosen)}.`;
  return (
    <>
      <section className="cfg-section">
        <h2 className="cfg-section__label">Platform voice</h2>
        <KeyCard name="voice" title="xAI · Platform voice" what="One platform key enables live calls, dictation and spoken replies for all existing and new accounts on iOS, macOS and web. Works with any text-model connection. Voice usage is billed to the platform’s xAI account."
          link={{ href: 'https://console.x.ai', label: 'Get a voice-enabled API key at console.x.ai' }} status={keys.voice} canEdit={keys.canEdit} onChange={changed} />
      </section>
      <h2 className="cfg-section__label">Server defaults</h2>
      <p className="cfg-field__hint">These shared keys apply when you choose server defaults. Your personal OpenRouter connection or selected subscription takes priority. Only the server owner can change shared keys.</p>

      <section className="cfg-section">
        <h2 className="cfg-section__label">Models</h2>
        <div className="cfg-card cfg-key">
          <div className="cfg-key__form">
            <div className="cfg-row__text"><div className="cfg-row__title">Run Bots on</div><div className="cfg-row__sub">OpenRouter gives one key for Claude, GPT, Gemini and hundreds more.</div></div>
            <div className="cfg-seg" role="radiogroup" aria-label="Model provider">
              {(['openrouter', 'direct'] as const).map((p) => (
                <button key={p} type="button" role="radio" aria-checked={chosen === p} className={chosen === p ? 'is-active' : ''} disabled={!keys.canEdit} onClick={() => void choose(p)}>
                  {p === 'openrouter' ? 'OpenRouter' : 'Custom provider'}
                </button>
              ))}
            </div>
          </div>
          <div className="cfg-key__form">
            <div className="cfg-row__text"><div className="cfg-row__title">Default model</div><div className="cfg-row__sub">Used by every Bot unless you pick one in its settings.</div></div>
            <ModelPicker key={`${chosen}-${pickerKey}`} provider={chosen} label="Default model" value={current} disabled={!canPick}
              onChange={(id) => { if (id && id !== current) void save(chosen === 'openrouter' ? 'openrouter_model' : 'model', id); }} />
          </div>
          <div className="cfg-key__foot">
            {note ? <span className={note.tone === 'error' ? 'cfg-key__err' : 'cfg-key__ok'} role="status">{note.text}</span> : status}
          </div>
        </div>
      </section>

      <section className="cfg-section">
        <h2 className="cfg-section__label">Keys</h2>
        <KeyCard name="openrouter" title="OpenRouter" what="Recommended: one key for 290+ models that can use tools, with per-token pricing." link={{ href: 'https://openrouter.ai/keys', label: 'Get a key at openrouter.ai/keys' }} status={keys.openrouter} canEdit={keys.canEdit} onChange={changed} />
        <KeyCard name="direct" title="Custom provider" what="Direct model access through a compatible provider." status={keys.direct} canEdit={keys.canEdit} onChange={changed} />
        <KeyCard name="composio" title="Composio · Connected apps" what="One project key enables connected apps for everyone on this server. Each person connects their own accounts; their connections stay private." link={{ href: 'https://platform.composio.dev', label: 'Create a Composio account or get a project key' }} status={keys.composio} canEdit={keys.canEdit} onChange={changed} />
      </section>
    </>
  );
}

const screenLabel = (id: string) => (id === 'default' ? 'Main screen' : `Screen ${Number(id.replace('screen-', '')) - 98 || id}`);

function ComputerSection() {
  const computer = useStore((s) => s.computer);
  const bots = useStore((s) => s.bots);
  const [details, setDetails] = useState<ComputerDetails | null>(null);
  const [busy, setBusy] = useState<'wake' | 'sleep' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { configApi.computerDetails().then(setDetails).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, computer?.status, computer?.screens.length, computer?.provider, computer?.device?.name]);

  const status = computer?.status ?? details?.computer.status;
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'resuming' || status === 'creating' || status === 'suspending';
  const act = async (kind: 'wake' | 'sleep') => {
    setBusy(kind); setNote(null);
    try { kind === 'wake' ? await configApi.wake() : await configApi.sleep(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(null); }
  };
  const byId = new Map(bots.map((b) => [b.id, b]));

  if ((computer ?? details?.computer)?.provider === 'local') return <LocalComputerSection details={details} reload={load} />;

  return (
    <>
      <PageHead title="Computer" sub="Your Bots share one cloud computer. Each Bot works on its own screen." />
      <section className="cfg-section">
        <h2 className="cfg-section__label">Status</h2>
        <div className="cfg-card">
          <div className="cfg-row">
            <span className={`computer-status-dot is-${running ? 'on' : transitioning ? 'busy' : 'off'}`} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Bots’ computer · {computerStatusText(computer ?? null)}</div>
              <div className="cfg-row__sub">
                {details ? `Goes to sleep after ${details.hibernation.idleMinutes} idle minutes when nobody is watching. Starts again on its own once a Bot has work.` : 'Checking…'}
              </div>
            </div>
            {running || status === 'suspending' ? (
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!running || !!busy} onClick={() => act('sleep')}>{busy === 'sleep' || status === 'suspending' ? 'Going to sleep…' : 'Sleep'}</button>
            ) : (
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={transitioning || !!busy} onClick={() => act('wake')}>{busy === 'wake' || transitioning ? 'Waking…' : 'Wake'}</button>
            )}
          </div>
          {computer?.error && status === 'error' && <div className="cfg-error cfg-error--inset">{computer.error}</div>}
          {note && <div className="cfg-error cfg-error--inset">{note}</div>}
        </div>
      </section>

      <section className="cfg-section">
        <h2 className="cfg-section__label">Screens in use</h2>
        <div className="cfg-card">
          {!details ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">No Bot has used the computer yet.</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row">
                {bot ? <BotAvatarFor bot={bot} size={28} /> : <span className="cfg-row__ph" />}
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot?.name ?? 'Removed Bot'}</div>
                  <div className="cfg-row__sub">{screenLabel(s.screenId)} · used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div>
                </div>
                <ConfirmButton
                  className="cfg-btn cfg-btn--secondary"
                  confirmLabel="Reset screen"
                  disabled={!running}
                  title={running ? 'Closes everything open on this screen' : 'Wake the computer first'}
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); load(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Reset
                </ConfirmButton>
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">Reset closes every window on that Bot’s screen, so it starts clean next time. {(computer ?? details?.computer)?.provider === 'cloudvm' ? 'Every Bot has its own screen; the computer grows as you add Bots.' : 'Up to 4 Bots can have a screen at once.'}</div>
      </section>
    </>
  );
}

/** Local computers: Bots use a Chrome browser on the user's own PC through the companion program. */
function LocalComputerSection({ details, reload }: { details: ComputerDetails | null; reload: () => void }) {
  const computer = useStore((s) => s.computer) ?? details?.computer ?? null;
  const bots = useStore((s) => s.bots);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const connected = computer?.status === 'running';
  const nativeMac = !!details?.localComputer?.enabled;
  const paired = !!details?.pairing?.paired;
  const here = details?.thisComputer;
  const useHere = async () => {
    setBusy(true); setNote(null);
    try { await configApi.useThisComputer(); setPairing(null); reload(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  };
  const byId = new Map(bots.map((b) => [b.id, b]));
  const desktop = !!computer?.desktop;

  // Once the PC connects, the one-time command has done its job.
  useEffect(() => { if (connected) setPairing(null); }, [connected]);

  const pair = async () => {
    setBusy(true); setNote(null); setCopied(false);
    try { setPairing(await configApi.pairPc()); reload(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    if (!pairing) return;
    try { await navigator.clipboard.writeText(pairing.command); setCopied(true); } catch { setNote('Couldn’t copy. Select the command and copy it yourself.'); }
  };

  return (
    <>
      <PageHead title="Computer" sub={desktop
        ? 'Your Bots use your own computer: its full desktop and apps, your default browser, and a shell. They take turns, one Bot at a time.'
        : 'Your Bots use a Chrome browser on your own PC. Each Bot gets its own browser profile there, separate from yours.'} />
      <section className="cfg-section">
        <h2 className="cfg-section__label">Status</h2>
        <div className="cfg-card">
          <div className="cfg-row">
            <span className={`computer-status-dot is-${connected ? 'on' : 'off'}`} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">{nativeMac ? 'Your Mac' : 'Your PC'} · {computerStatusText(computer)}</div>
              <div className="cfg-row__sub">
                {connected
                  ? `${computer?.device?.name ?? 'PC'}${computer?.device?.platform ? ` · ${computer.device.platform}` : ''} · ${desktop ? 'Your Bots can use this desktop now.' : 'Your Bots can browse now.'}`
                  : nativeMac ? 'Open the Swarm desktop app → Mac Control to start. Your tasks stay on this Mac while it is offline.' : paired ? 'Paired, but the companion isn’t running. Start it again on your PC, or connect a new one.' : desktop ? 'Connect a PC so your Bots can use its desktop.' : 'Connect a PC so your Bots can use a browser.'}
              </div>
            </div>
            {!nativeMac && <div className="settings-row__actions">
              {!connected && here?.available && !here.active && <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={useHere}>{busy ? 'Starting…' : 'Use this computer'}</button>}
              {!connected && here?.active && <span className="cfg-row__sub">Starting…</span>}
              {!connected && !here?.active && <button type="button" className={`cfg-btn ${here?.available ? 'cfg-btn--secondary' : 'cfg-btn--primary'}`} disabled={busy} onClick={pair}>{busy ? 'Preparing…' : here?.available ? 'Connect another PC' : paired ? 'New connect command' : 'Connect your PC'}</button>}
              {connected && here?.active && (
                <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Stop using it" onConfirm={async () => { try { await configApi.stopThisComputer(); reload(); } catch (e) { setNote((e as Error).message); } }}>
                  Stop
                </ConfirmButton>
              )}
              {paired && (
                <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Disconnect PC" onConfirm={async () => { try { await configApi.unpairPc(); setPairing(null); reload(); } catch (e) { setNote((e as Error).message); } }}>
                  Disconnect
                </ConfirmButton>
              )}
            </div>}
          </div>
          {nativeMac && <div className="cfg-field__hint">Manage permissions, Stop, or Disconnect in the Swarm desktop app → Mac Control. Terminal commands run as your Mac user. Playwright uses managed Chrome; desktop controls can use your existing browser windows.</div>}
          {pairing && !connected && (
            <div className="cfg-pair">
              <div className="cfg-pair__step">On your PC (needs <b>Node.js 22+</b>{desktop ? <> on macOS or Linux</> : <> and <b>Google Chrome</b></>}), run this in a terminal and keep it running:</div>
              <div className="cfg-pair__cmd">
                <code className="cfg-pair__code" aria-label="Connect command">{pairing.command}</code>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              {desktop
                ? <div className="cfg-field__hint">It contains a private token: anyone who has it can connect their PC as your Bots’ computer. On macOS, allow the terminal app in System Settings → Privacy &amp; Security → <b>Accessibility</b> and <b>Screen Recording</b>. Waiting for your PC to connect…</div>
                : <div className="cfg-field__hint">It contains a private token: anyone who has it can connect their PC as your Bots’ browser. Add <code className="cfg-code">--headed</code> to see the browser windows on your PC. Waiting for your PC to connect…</div>}
            </div>
          )}
          {note && <div className="cfg-error cfg-error--inset">{note}</div>}
        </div>
      </section>

      <section className="cfg-section">
        <h2 className="cfg-section__label">{desktop ? 'Bots using the desktop' : 'Browsers in use'}</h2>
        <div className="cfg-card">
          {!details ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">{connected ? (desktop ? 'No Bot has used the desktop yet.' : 'No Bot has opened a browser yet.') : 'None while your PC is disconnected.'}</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row">
                {bot ? <BotAvatarFor bot={bot} size={28} /> : <span className="cfg-row__ph" />}
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot?.name ?? 'Removed Bot'}</div>
                  <div className="cfg-row__sub">{desktop ? 'Desktop' : 'Browser'} · used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div>
                </div>
                {!desktop && <ConfirmButton
                  className="cfg-btn cfg-btn--secondary"
                  confirmLabel="Close browser"
                  disabled={!connected}
                  title="Closes this Bot’s browser on your PC. Its logins are kept."
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); reload(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Close
                </ConfirmButton>}
              </div>
            );
          })}
        </div>
        {desktop
          ? <div className="cfg-field__hint">Bots act as you: they can open any app, read and change your files, and run shell commands. You can watch or take over any time from a Bot’s screen. Press <b>Stop</b> (or Ctrl+C in the companion) to cut them off.</div>
          : <div className="cfg-field__hint">Bots only get a browser on your PC: no files and no shell. Local-network addresses are blocked unless you start the companion with <code className="cfg-code">--allow-private-network</code>.</div>}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function humanizeTool(slug: string): { app: string; action: string } {
  const parts = slug.split(/[_:]/).filter(Boolean);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (parts.length < 2) return { app: cap(slug), action: '' };
  return { app: cap(parts[0]), action: cap(parts.slice(1).join(' ')) };
}

function PermissionsSection() {
  const [policies, setPolicies] = useState<{ tool: string; mode: string }[] | null>(null);
  const [mcpNames, setMcpNames] = useState<Record<string, { app: string; action: string }>>({});
  useEffect(() => { configApi.mcpServers().then(({ servers }) => setMcpNames(Object.fromEntries(servers.flatMap(s => s.tools.map(t => [t.toolName, { app: s.name, action: t.name }]))))).catch(() => {}); }, []);
  const load = useCallback(() => { configApi.policies().then((r) => setPolicies(r.policies)).catch(() => setPolicies([])); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHead title="Permissions" sub="Actions your Bots can take without asking first. Remove one and they’ll ask again next time." />
      <section className="cfg-section">
        <h2 className="cfg-section__label">Always allowed</h2>
        <div className="cfg-card">
          {policies === null ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : policies.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">Nothing here yet. When you choose “Always allow” on an approval, it shows up here.</div>
          ) : policies.map((p) => {
            const h = mcpNames[p.tool] ?? (p.tool.startsWith('mcp_') ? { app: 'MCP server', action: 'Previous tool permission' } : humanizeTool(p.tool));
            return (
              <div key={p.tool} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{h.app}{h.action ? ` · ${h.action}` : ''}</div>
                  <div className="cfg-row__sub">{p.mode === 'always_allow' ? 'Always allowed' : p.mode === 'blocked' ? 'Never allowed' : 'Asks first'}{!p.tool.startsWith('mcp_') && <> · <code className="cfg-code">{p.tool}</code></>}</div>
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.deletePolicy(p.tool).then(load).catch(() => {})}>Ask again</button>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function AppsSection() {
  const version = useStore((s) => s.connectionsVersion);
  const [apps, setApps] = useState<Toolkit[] | null>(null);
  useEffect(() => { configApi.connectedApps().then((r) => setApps(r.connectedApps ?? [])).catch(() => setApps([])); }, [version]);
  const openApps = () => { useConfigUI.getState().closeAppSettings(); useStore.getState().setModal('apps'); };
  return (
    <>
      <PageHead title="Connected apps" sub="Apps your Bots can use for you, like email, calendar and docs." />
      <section className="cfg-section">
        <h2 className="cfg-section__label">Your apps</h2>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{apps === null ? 'Checking…' : apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'} connected` : 'No apps connected yet'}</div>
              <div className="cfg-row__sub">Bots ask before doing anything that changes data in an app.</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={openApps}>{apps?.length ? 'Manage apps' : 'Connect apps'}</button>
          </div>
          {apps?.map((a) => (
            <div key={a.slug} className="cfg-row">
              <ToolkitLogo slug={a.slug} name={a.name} logo={a.logo} size={28} />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{a.name}</div>
                {a.description && <div className="cfg-row__sub">{a.description}</div>}
              </div>
              <span className="cfg-chip">Connected</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function AccountSection() {
  const user = useStore((s) => s.user);
  const appleLogin = useStore((s) => s.appleLogin);
  const appleLinked = useStore((s) => s.appleLinked);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const initials = (user?.name ?? user?.email ?? '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <PageHead title="Account" />
      <section className="cfg-section">
        <h2 className="cfg-section__label">Profile</h2>
        <div className="cfg-card">
          <div className="cfg-row">
            <span className="account__initials">{initials}</span>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{user?.name}</div>
              <div className="cfg-row__sub">{user?.email.endsWith('@openrouter.invalid') ? 'Signed up with OpenRouter' : user?.email}</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={async () => { setBusy(true); await configApi.logout().catch(() => {}); location.reload(); }}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </section>
      {(appleLogin || appleLinked) && (
        <section className="cfg-section">
          <h2 className="cfg-section__label">Sign-in methods</h2>
          <div className="cfg-card">
            <SettingRow title="Sign in with Apple" sub={appleLinked ? 'Connected. Use it to sign in to this account on your iPhone, iPad, Mac or the web.' : 'Connect Apple to sign in to this same account on your iPhone, iPad, Mac or the web.'} wrap={!appleLinked}>
              {appleLinked ? <span className="cfg-chip">Connected</span> : <AppleSignIn link />}
            </SettingRow>
          </div>
        </section>
      )}
      <section className="cfg-section">
        <h2 className="cfg-section__label">Delete account</h2>
        <div className="cfg-card">
          <SettingRow title="Delete your account" sub="Permanently deletes your account, Bots and conversations. Apple sign-in access is revoked too.">
            <ConfirmButton confirmLabel="Permanently delete my account" onConfirm={async () => {
              setError(null);
              try { await api.deleteAccount(); location.href = '/'; } catch (err) { setError((err as Error).message); }
            }}>Delete account…</ConfirmButton>
          </SettingRow>
          {error && <div className="cfg-error cfg-error--inset" role="alert">{error}</div>}
        </div>
      </section>
    </>
  );
}
