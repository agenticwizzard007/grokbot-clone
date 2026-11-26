import { modelDisplayName } from '../../lib/modelDisplay';
import { ProviderLabel, ProviderMark } from '../ProviderMark';
import { ApprovalLevelSettings } from './ApprovalLevelSettings';
import { InputLatencyDiagnostics } from '../InputLatencyDiagnostics';
import { prefetchApps } from '../../lib/appsCatalogCache';
import { visibleConnections, connectionStatus, connectionSummary } from '@shared/connection-details';
import { ConnectedAccountDetails, ConnectedAccounts, type DisplayAccount } from '../ConnectedAccountDetails';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, ChevronRight, CircleUserRound, Clock3, TextCursorInput, KeyRound, Monitor, PanelLeftOpen, Settings2, ShieldCheck } from 'lucide-react';
import { SettingRow, SettingIcon } from './SettingRow';
export { SettingRow } from './SettingRow';
import type { Toolkit, User } from '@shared/types';
import { configApi, type ComputerDetails, type KeysResponse, type KeyStatus, type Pairing } from '../../lib/configApi';
import { ModelPicker, refreshModels } from './ModelPicker';
import { LearningSettingsPanel } from './LearningSettings';
import { UsageSection } from './UsageSection';
import { relativeShort } from '../../lib/time';
import { openConversation, useConfigUI, useVersion, type Theme } from '../../configStore';
import { useStore } from '../../store';
import { computerStatusText } from './computerStatus';
import { ConfirmButton, Segmented, Switch } from './ui';
import { McpSettings } from './McpSettings';
import { MessagingSettings } from './MessagingSettings';
import { SubscriptionSettings } from './SubscriptionSettings';
import { PlanConnections } from '../PlanConnections';
import { OpenRouterSettings } from './OpenRouterSettings';
import { PrivateKeysSettings } from './PrivateKeysSettings';
import { AppleSignIn } from '../AppleSignIn';
import { AuthLink } from '../AuthButton';
import { openPopup, api, needsReauth } from '../../lib/api';
import { verifyAccessAccount } from '../../lib/accessApi';
import { ConnectAppsCatalog } from '../modals/ConnectAppsModal';
import { isNativeApp } from '../../lib/native';
import { DeviceAccessSection } from './DeviceAccessSection';
import { readDetailsDefault, writeDetailsDefault } from '../../lib/detailsDefault';
import { toast } from '../../lib/toast';
import { SHORTCUTS, shortcutKeys } from '../../lib/shortcuts';
import { TimeZonePicker } from './TimeZonePicker';
import { browserTimeZone, canonicalTimeZone, buildTimeZoneOptions, loadErrorText, toolkitDisplayName } from './settingsLogic';
import { AccountSessions } from './AccountSessions';
import { ReauthPrompt } from './ReauthPrompt';
import { useAccessReauth } from './useAccessReauth';
import { useAccessPanel } from './useAccessPanel';
import '../../styles/settings.css';
import '../../styles/access-settings.css';

const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Keep the public entry for existing embedded Settings surfaces.
export { AppSettings } from './SettingsFrame';

export function AppSettingsContent() {
  const section = useConfigUI(s => s.appSettings);
  const catalogAccountId = useStore(s => s.user?.id);
  useEffect(() => { prefetchApps(catalogAccountId); }, [catalogAccountId]);
  return <>
            {section === 'general' && <GeneralSection />}
            {section === 'keys' && <KeysSection />}
            {section === 'usage' && <UsageSection />}
            {section === 'learning' && <LearningSettingsPanel />}
            {section === 'computer' && <ComputerSection />}
            {section === 'messaging' && <MessagingSettings />}
            {section === 'permissions' && <PermissionsSection />}
            {section === 'apps' && <AppsSection />}
            {section === 'mcp' && <McpSettings />}
            {section === 'subscriptions' && <SubscriptionSettings />}
            {section === 'account' && <AccountSection />}
  </>;
}

function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="app-settings__head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
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
  const accountId = useStore((s) => s.user?.id);
  const [detailsDefault, setDetailsDefault] = useState(() => readDetailsDefault(accountId));
  useEffect(() => { setDetailsDefault(readDetailsDefault(accountId)); }, [accountId]);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  // Every shortcut the app handles (lib/shortcuts.ts), with platform glyphs (MF-028, MF-029).
  const shortcuts: [string, string[]][] = SHORTCUTS.filter(s => !(s.web && isNativeApp)).map(s => [s.label, shortcutKeys(s)]);
  return (
    <>
      <PageHead title="General" sub="Appearance, layout, and keyboard shortcuts" />
      <section className="cfg-section settings-appearance">
        <h2 className="cfg-section__label">Appearance & layout</h2>
        <div className="cfg-card">
          <SettingRow icon={Settings2} title="Theme" sub="Choose how Swarm looks on this device.">
            <Segmented label="Theme" value={theme} onChange={setTheme} options={(['system', 'light', 'dark'] as const).map((t) => ({ value: t, label: THEME_LABEL[t] }))} />
          </SettingRow>
          <SettingRow icon={PanelLeftOpen} title="Open Bot details with each chat" sub="Show activity, tasks, files, and setup beside the chat.">
            <Switch label="Open Bot details with each chat" on={detailsDefault} onChange={(v) => { writeDetailsDefault(accountId, v); setDetailsDefault(v); }} />
          </SettingRow>
          <SettingRow icon={PanelLeftOpen} title="Compact sidebar" sub="Give chats more room on desktop.">
            <Switch label="Compact sidebar" on={collapsed} onChange={(v) => useStore.getState().set({ sidebarCollapsed: v })} />
          </SettingRow>
        </div>
      </section>
      <InputLatencyDiagnostics />
      <section className="cfg-section">
        <h2 className="cfg-section__label">Keyboard shortcuts</h2>
        {IS_MAC && !isNativeApp && <div className="cfg-field__hint">On Windows and Linux, use Ctrl instead of ⌘ and Alt instead of ⌥.</div>}
        <div className="cfg-card settings-shortcuts">
          {shortcuts.map(([label, keys]) => <SettingRow icon={TextCursorInput} key={label} title={label}><Keys keys={keys} /></SettingRow>)}
        </div>
      </section>
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
      setNote({ tone: 'ok', text: r.modelOk === false ? `Key works, but ${modelDisplayName(r.model.value)} isn't available on it. Pick a model above.` : 'Verified and saved. Bots use it right away.' });
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
      <div className="cfg-row"><SettingIcon icon={KeyRound} />
        <div className="cfg-row__text">
          <div className="cfg-row__title"><ProviderLabel provider={name === "voice" ? "xai" : name}>{title}</ProviderLabel> · {status.set ? 'Connected' : required ? 'Needed' : 'Not set'}</div>
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
  const user = useStore(s => s.user);
  return user ? <AccountKeysSection key={user.id} accountId={user.id} accountEmail={user.email} /> : null;
}

const credentialIntent = (value: unknown) => value === 'verify-credentials' ? value : null;

function AccountKeysSection({ accountId, accountEmail }: { accountId: string; accountEmail: string }) {
  const reauth = useAccessReauth('keys', accountId, credentialIntent);
  const onReauth = (error: Error) => reauth.request('verify-credentials', error.message);
  return <>
    {reauth.pending && <ReauthPrompt accountEmail={accountEmail} reason={reauth.pending.reason} resume={{ section: 'keys', accountId, action: 'login' }} retryLabel="the credential action" terminalActive={false} onCancel={reauth.cancel} />}
    {reauth.checking && <p role="status">Verifying your sign-in…</p>}
    {reauth.returned && <p role="status">You’re signed in again. Review your credentials and retry the change.</p>}
    {reauth.error && <p className="cfg-error" role="alert">{reauth.error}</p>}
    <OpenRouterSettings onReauth={onReauth} />
    <PlanConnections settings />
    <ServerKeysSection accountId={accountId} onReauth={onReauth} />
  </>;
}

function ServerKeysSection({ accountId, onReauth }: { accountId: string; onReauth: (error: Error) => void }) {
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
  if (keys.isolated) return <PrivateKeysSettings accountId={accountId} onReauth={onReauth} />;
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
      ? `Waiting for your ${nameOf(chosen)} key. Bots use ${modelDisplayName(running === 'openrouter' ? keys.openrouterModel.value : keys.model.value)} through ${nameOf(running)} until then.`
      : `Add your ${nameOf(chosen)} key below so Bots can run.`
    : `Bots use ${modelDisplayName(current)} through ${nameOf(chosen)}.`;
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
          <div className="cfg-row cfg-key__form"><SettingIcon icon={KeyRound} />
            <div className="cfg-row__text"><div className="cfg-row__title">Run Bots on</div><div className="cfg-row__sub">OpenRouter gives one key for Claude, GPT, Gemini and hundreds more.</div></div>
            <div className="cfg-seg" role="radiogroup" aria-label="Model provider">
              {(['openrouter', 'direct'] as const).map((p) => (
                <button key={p} type="button" role="radio" aria-checked={chosen === p} className={chosen === p ? 'is-active' : ''} disabled={!keys.canEdit} onClick={() => void choose(p)}>
                  <ProviderMark provider={p} />{p === 'openrouter' ? 'OpenRouter' : 'Custom provider'}
                </button>
              ))}
            </div>
          </div>
          <div className="cfg-row cfg-key__form"><span className="cfg-key__icon-space" aria-hidden="true" />
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
  const accountId = useStore(s => s.user?.id);
  const version = useVersion('access-computer');
  const computer = useStore((s) => s.computer);
  const bots = useStore((s) => s.bots);
  const [details, setDetails] = useState<ComputerDetails | null>(null);
  const [detailsError, setDetailsError] = useState('');
  const detailsEpoch = useRef(0);
  const [busy, setBusy] = useState<'wake' | 'sleep' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => {
    const epoch = ++detailsEpoch.current;
    const current = () => detailsEpoch.current === epoch && useStore.getState().user?.id === accountId;
    setDetailsError('');
    void configApi.computerDetails().then(result => { if (current()) setDetails(result); }).catch(err => { if (current()) setDetailsError(err.message); });
  }, [accountId]);
  useEffect(() => { load(); return () => { detailsEpoch.current++; }; }, [load, version, computer?.status, computer?.screens.length, computer?.provider, computer?.device?.name]);

  const status = computer?.status;
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'resuming' || status === 'creating' || status === 'suspending';
  const act = async (kind: 'wake' | 'sleep') => {
    setBusy(kind); setNote(null);
    try { kind === 'wake' ? await configApi.wake() : await configApi.sleep(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(null); }
  };
  const byId = new Map(bots.map((b) => [b.id, b]));

  if ((computer ?? details?.computer)?.provider === 'local') return <LocalComputerSection key={accountId} details={details} detailsError={detailsError} reload={load} />;

  // Watch opens a Bot's screen in the viewer: the open chat's Bot, else the primary.
  const watchBot = bots.find(b => b.id === useStore.getState().selectedBotId && b.kind !== 'room') ?? bots.find(b => b.isPrimary && b.kind !== 'room') ?? bots.find(b => b.kind !== 'room');
  const watch = () => {
    if (!watchBot) return;
    openConversation(watchBot.id);
    useStore.getState().set({ viewerOpen: true, viewerControl: false });
  };

  return (
    <>
      <PageHead title="Computer" sub="Manage where Bots work and which device they can use." />
      <section className="cfg-section cloud-computer" aria-label="Cloud computer">
        <h2 className="cfg-section__label">Cloud computer</h2>
        <p className="cfg-field__hint">Each Bot has its own cloud computer. Bots can browse and run commands there without asking. Connected app actions that change data still ask first.</p>
        <div className="cfg-card">
          <div className="cfg-row"><SettingIcon icon={Monitor} />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Bots' computer · {computerStatusText(computer ?? null)}</div>
              <div className="cfg-row__sub">
                {details ? `Goes to sleep after ${details.hibernation.idleMinutes} idle minutes when nobody is watching. Starts again on its own once a Bot has work.` : 'Checking…'}
              </div>
            </div>
            <div className="settings-row__actions">
              {watchBot && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={watch} title={`Watch ${watchBot.name}'s screen`}>Watch</button>}
              {running || status === 'suspending' ? (
                <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!running || !!busy} onClick={() => act('sleep')}>{busy === 'sleep' || status === 'suspending' ? 'Going to sleep…' : 'Sleep'}</button>
              ) : (
                <button type="button" className="cfg-btn cfg-btn--primary" disabled={transitioning || !!busy} onClick={() => act('wake')}>{busy === 'wake' || transitioning ? 'Waking…' : 'Wake'}</button>
              )}
            </div>
          </div>
          {computer?.error && status === 'error' && <div className="cfg-error cfg-error--inset" role="alert">{computer.error} <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => act('wake')}>Try again</button></div>}
          {note && <div className="cfg-error cfg-error--inset">{note}</div>}
          <AskBeforeComputerRow />
        </div>
      </section>

      <section className="cfg-section">
        <h2 className="cfg-section__label">Screens in use</h2>
        <div className="cfg-card">
          {detailsError ? <div className="cfg-error" role="alert">{detailsError} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={load}>Try again</button></div> : !details ? <div className="cfg-empty cfg-empty--flat" role="status">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">No Bot screens are open.</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row"><SettingIcon icon={Monitor} />

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
        <div className="cfg-field__hint">Reset closes every window on that Bot's screen, so it starts clean next time. {(computer ?? details?.computer)?.provider === 'cloudvm' ? 'Every Bot has its own screen; the computer grows as you add Bots.' : 'Up to 4 Bots can have a screen at once.'}</div>
      </section>
      <DeviceAccessSection />
    </>
  );
}

/** Account preference: Bots ask before using their computer (browser, shell, desktop). Off by default. */
function AskBeforeComputerRow() {
  const accountId = useStore(s => s.user?.id);
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError('');
    api.preferences().then(p => { if (alive && useStore.getState().user?.id === accountId) setOn(!!p?.askBeforeComputer); })
      .catch(e => { if (alive) setError(`Couldn’t load this setting: ${(e as Error).message}`); });
    return () => { alive = false; };
  }, [accountId, attempt]);
  const change = async (next: boolean) => {
    if (busy) return;
    setBusy(true); setError(''); setOn(next);
    try {
      const saved = await api.updatePreferences({ askBeforeComputer: next });
      if (useStore.getState().user?.id === accountId) setOn(typeof saved?.askBeforeComputer === 'boolean' ? saved.askBeforeComputer : next);
    } catch (e) {
      if (useStore.getState().user?.id === accountId) { setOn(!next); setError(`Couldn’t save: ${(e as Error).message}`); }
    } finally { setBusy(false); }
  };
  return <>
    <SettingRow icon={ShieldCheck} title="Ask before Bots use their computer" sub="When on, Bots show an approval card before browsing, running commands or using the desktop. Choose Always allow on a card to stop asking for that kind of action.">
      <Switch label="Ask before Bots use their computer" on={!!on} disabled={on === null || busy} onChange={v => void change(v)} />
    </SettingRow>
    {error && <div className="cfg-error cfg-error--inset" role="alert">{error} {on === null && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setAttempt(n => n + 1)}>Retry</button>}</div>}
  </>;
}

/** Local computers: Bots use a Chrome browser on the user's own PC through the companion program. */
function LocalComputerSection({ details, detailsError, reload }: { details: ComputerDetails | null; detailsError: string; reload: () => void }) {
  const accountId = useStore(s => s.user?.id);
  const current = useAccessPanel(accountId);
  const computer = useStore((s) => s.computer);
  const bots = useStore((s) => s.bots);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'stop' | 'disconnect' | null>(null);
  const connected = computer?.status === 'running';
  const nativeMac = !!details?.localComputer?.enabled;
  const paired = !!details?.pairing?.paired;
  const here = details?.thisComputer;
  const refresh = () => {
    if (useStore.getState().user?.id !== accountId) return;
    useConfigUI.getState().bump('access-computer');
    void useStore.getState().loadComputer().catch(() => {});
  };
  const useHere = async () => {
    if (!accountId || !current()) return;
    setBusy(true); setNote(null);
    try {
      await verifyAccessAccount(accountId);
      if (!current()) return;
      try { await configApi.useThisComputer(); } finally { refresh(); }
      if (current()) setPairing(null);
    } catch (e) { if (current()) setNote((e as Error).message); }
    finally { if (current()) setBusy(false); }
  };
  const byId = new Map(bots.map((b) => [b.id, b]));
  const desktop = !!computer?.desktop;
  const connectOnly = !!computer && !!details && !connected && !nativeMac && !paired && !here?.available;

  // Once the PC connects, the one-time command has done its job.
  useEffect(() => { if (connected) setPairing(null); }, [connected]);

  const pair = async () => {
    if (!accountId || !current()) return;
    setBusy(true); setNote(null); setCopied(false);
    try {
      await verifyAccessAccount(accountId);
      if (!current()) return;
      try {
        const result = await configApi.pairPc();
        if (current()) setPairing(result);
      } finally { refresh(); }
    } catch (e) { if (current()) setNote((e as Error).message); }
    finally { if (current()) setBusy(false); }
  };
  const copy = async () => {
    if (!pairing) return;
    try { await navigator.clipboard.writeText(pairing.command); setCopied(true); } catch { setNote('Couldn’t copy. Select the command and copy it yourself.'); }
  };
  const changeConnection = async () => {
    if (!confirm || busy || nativeMac || !accountId || !current()) return;
    setBusy(true); setNote(null);
    try {
      await verifyAccessAccount(accountId);
      if (!current()) return;
      try {
        if (confirm === 'stop') await configApi.stopThisComputer();
        else await configApi.unpairPc();
      } finally { refresh(); }
      if (!current()) return;
      if (confirm === 'disconnect') setPairing(null);
      setConfirm(null);
    } catch (err) { if (current()) setNote(err instanceof Error ? err.message : 'Couldn’t change the computer connection.'); }
    finally { if (current()) setBusy(false); }
  };

  return (
    <>
      <PageHead title={connectOnly ? 'Connect your PC' : 'Computer'} sub={connectOnly ? 'Pair a computer to give your Bots access.' : nativeMac ? 'Manage this Mac’s device access and connection for your account.' : desktop
        ? 'Your Bots use your own computer: its full desktop and apps, your default browser, and a shell. They take turns, one Bot at a time.'
        : 'Your Bots use a Chrome browser on your own PC. Each Bot gets its own browser profile there, separate from yours.'} />
      <DeviceAccessSection />
      {detailsError && <div className="cfg-error" role="alert">{detailsError} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={reload}>Try again</button></div>}
      <section className="cfg-section">
        {!connectOnly && <h2 className="cfg-section__label">Status</h2>}
        <div className="cfg-card">
          <div className="cfg-row"><SettingIcon icon={Monitor} />
            <div className="cfg-row__text">
              <div className="cfg-row__title">{nativeMac ? 'Your Mac' : 'Your PC'}</div>
              <div className="cfg-row__sub">
                {connected
                  ? `${computer?.device?.name ?? 'PC'}${computer?.device?.platform ? ` · ${computer.device.platform}` : ''} · ${desktop ? 'Your Bots can use this desktop now.' : 'Your Bots can browse now.'}`
                  : nativeMac ? 'Use the Swarm Mac app to connect. Tasks wait while this Mac is offline.' : paired ? 'Paired, but the companion isn’t running. Start it again on your PC, or connect a new one.' : 'No companion PC is connected.'}
              </div>
              <div className="cfg-row__sub">{connectOnly ? 'Not connected' : computerStatusText(computer)}</div>
            </div>
            {!nativeMac && details && !connectOnly && <div className="settings-row__actions">
              {!connected && here?.available && !here.active && <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={useHere}>{busy ? 'Starting…' : 'Use this computer'}</button>}
              {!connected && here?.active && <span className="cfg-row__sub">Starting…</span>}
              {!connected && !here?.active && <button type="button" className={`cfg-btn ${here?.available ? 'cfg-btn--secondary' : 'cfg-btn--primary'}`} disabled={busy} onClick={pair}>{busy ? 'Preparing…' : here?.available ? 'Connect another PC' : paired ? 'New connect command' : 'Connect your PC'}</button>}
              {here?.active && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setConfirm('stop')}>Stop</button>}
              {paired && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setConfirm('disconnect')}>Disconnect</button>}
            </div>}
          </div>
          {nativeMac && <div className="access-callout">Manage approvals in the Swarm Mac app. Stop keeps this Mac selected but offline. Disconnect revokes device access and returns Bots to the server’s default computer.</div>}
          {confirm && <div className="access-callout" role="group" aria-label={confirm === 'stop' ? 'Stop this computer?' : 'Disconnect this PC?'}>
            <strong>{confirm === 'stop' ? 'Stop this computer?' : 'Disconnect this PC?'}</strong>
            <p>{confirm === 'stop' ? 'Stop the companion process on this computer. Its pairing is kept.' : 'Revoke this account’s PC pairing. To use the computer again, start a new pairing.'}</p>
            <div className="access-row-actions"><button type="button" className="cfg-btn cfg-btn--danger" disabled={busy} onClick={() => void changeConnection()}>{busy ? 'Working…' : confirm === 'stop' ? 'Stop this computer' : 'Disconnect PC'}</button><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button></div>
          </div>}
          {pairing && !connected && (
            <div className="cfg-pair">
              <div className="cfg-pair__step">On your PC (needs <b>Node.js 22+</b>{desktop ? <> on macOS or Linux</> : <> and <b>Google Chrome</b></>}), run this in a terminal and keep it running:</div>
              <div className="cfg-pair__cmd">
                <code className="cfg-pair__code" aria-label="Connect command">{pairing.command}</code>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              {desktop
                ? <div className="cfg-field__hint">It contains a private token: anyone who has it can connect their PC as your Bots' computer. On macOS, allow the terminal app in System Settings → Privacy &amp; Security → <b>Accessibility</b> and <b>Screen Recording</b>. Waiting for your PC to connect…</div>
                : <div className="cfg-field__hint">It contains a private token: anyone who has it can connect their PC as your Bots' browser. Add <code className="cfg-code">--headed</code> to see the browser windows on your PC. Waiting for your PC to connect…</div>}
            </div>
          )}
          {note && <div className="cfg-error cfg-error--inset" role="alert">{note}</div>}
        </div>
        {connectOnly && !pairing && <button type="button" className="cfg-btn cfg-btn--primary access-device-pair" disabled={busy} onClick={pair}>{busy ? 'Preparing…' : 'Connect your PC'}</button>}
      </section>

      {!connectOnly && <section className="cfg-section">
        <h2 className="cfg-section__label">{desktop ? 'Bots using the desktop' : 'Browsers in use'}</h2>
        <div className="cfg-card">
          {!details ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">{connected ? (desktop ? 'No Bot has used the desktop yet.' : 'No Bot has opened a browser yet.') : 'None while your PC is disconnected.'}</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row"><SettingIcon icon={Monitor} />

                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot?.name ?? 'Removed Bot'}</div>
                  <div className="cfg-row__sub">{desktop ? 'Desktop' : 'Browser'} · used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div>
                </div>
                {!desktop && <ConfirmButton
                  className="cfg-btn cfg-btn--secondary"
                  confirmLabel="Close browser"
                  disabled={!connected}
                  title="Closes this Bot's browser on your PC. Its logins are kept."
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); reload(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Close
                </ConfirmButton>}
              </div>
            );
          })}
        </div>
        {desktop
          ? <div className="cfg-field__hint">Bots act as you: they can open any app, read and change your files, and run shell commands. You can watch or take over any time from a Bot's screen. Press <b>Stop</b> (or Ctrl+C in the companion) to cut them off.</div>
          : <div className="cfg-field__hint">Bots only get a browser on your PC: no files and no shell. Local-network addresses are blocked unless you start the companion with <code className="cfg-code">--allow-private-network</code>.</div>}
      </section>}
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
  const [loadError, setLoadError] = useState('');
  const [rowError, setRowError] = useState<{ tool: string; text: string } | null>(null);
  const [mcpNames, setMcpNames] = useState<Record<string, { app: string; action: string }>>({});
  // Names are a nicety: without them rows fall back to the tool id, so a failure here is not an error state.
  useEffect(() => { configApi.mcpServers().then(({ servers }) => setMcpNames(Object.fromEntries(servers.flatMap(s => s.tools.map(t => [t.toolName, { app: s.name, action: t.name }]))))).catch(() => {}); }, []);
  const load = useCallback(() => {
    setLoadError('');
    configApi.policies().then((r) => { setPolicies(Array.isArray(r?.policies) ? r.policies : []); setLoadError(''); })
      .catch((e) => setLoadError(loadErrorText(e)));
  }, []);
  useEffect(() => { load(); }, [load]);
  const askAgain = (tool: string) => {
    setRowError(null);
    configApi.deletePolicy(tool).then(load).catch((e) => setRowError({ tool, text: `Couldn’t reset this permission: ${(e as Error).message}` }));
  };
  return (
    <>
      <PageHead title="Permissions" sub="Choose when Bots ask before taking action." />
      <ApprovalLevelSettings explain />
      <section className="cfg-section">
        <h2 className="cfg-section__label">Actions you’ve always allowed</h2>
        <p>These are individual tool approvals. Remove a choice to have your Bots ask again.</p>
        <div className="cfg-card">
          {loadError ? <div className="cfg-error" role="alert">Couldn’t load permissions. {loadError} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={load}>Retry</button></div>
            : policies === null ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : policies.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">Nothing here yet. When you choose “Always allow” on an approval, it shows up here.</div>
          ) : policies.map((p) => {
            const displayTool = p.tool.replace(/^api_max:/, '');
            const h = mcpNames[displayTool.replace(/:bot:.*$/, '')] ?? (displayTool.startsWith('mcp_') ? { app: 'MCP server', action: 'Previous tool permission' } : humanizeTool(displayTool));
            return (
              <div key={p.tool} className="cfg-row"><SettingIcon icon={ShieldCheck} />
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{h.app}{h.action ? ` · ${h.action}` : ''}</div>
                  <div className="cfg-row__sub">{p.tool.startsWith('api_max:') ? 'Ask before every action only · ' : 'Standard and CLI plans · '}{p.mode === 'always_allow' ? 'Always allowed' : p.mode === 'blocked' ? 'Never allowed' : 'Asks first'}{!displayTool.startsWith('mcp_') && <> · <code className="cfg-code">{displayTool}</code></>}</div>
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => askAgain(p.tool)}>Ask again</button>
                {rowError?.tool === p.tool && <div className="cfg-error cfg-error--inset" role="alert">{rowError.text}</div>}
              </div>
            );
          })}
        </div>
      </section>
      <div className="device-access-link" data-swarm-device-access-link="">
        <span>Looking for device access?</span>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openAppSettings('computer')}>Computer settings <ChevronRight size={14} aria-hidden /></button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

type SettingsAppConnection = DisplayAccount & {
  id: string;
  toolkit: string;
  status: string;
  isDefault?: boolean;
  isDisabled?: boolean;
  authorizationIncomplete?: boolean;
};

function AppsSection() {
  const accountId = useStore(s => s.user?.id);
  return accountId ? <AccountAppsSection key={accountId} accountId={accountId} /> : null;
}

function AccountAppsSection({ accountId }: { accountId: string }) {
  const current = useAccessPanel(accountId);
  const version = useStore((s) => s.connectionsVersion);
  const [connections, setConnections] = useState<SettingsAppConnection[] | null>(null);
  const [apps, setApps] = useState<Toolkit[] | null>(null);
  const [connectionsError, setConnectionsError] = useState('');
  const [appsError, setAppsError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [catalog, setCatalog] = useState(false);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  const connectionsRequest = useRef(0);
  const appsRequest = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const managing = useRef(false);

  const loadConnections = useCallback(async (signal: AbortSignal) => {
    const request = ++connectionsRequest.current;
    try {
      const r = await fetch('/api/apps/connections', { credentials: 'include', signal });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? 'Could not load accounts.');
      if (!Array.isArray(body.connections)) throw new Error('Could not load accounts.');
      if (request === connectionsRequest.current) {
        setConnections(visibleConnections(body.connections));
        setConnectionsError('');
      }
    } catch (e) {
      if (request === connectionsRequest.current) setConnectionsError(signal.aborted ? 'The request took too long. Try again.' : (e as Error).message);
    }
  }, []);
  const loadApps = useCallback(async (signal: AbortSignal) => {
    const request = ++appsRequest.current;
    try {
      const r = await configApi.connectedApps(signal);
      if (!Array.isArray(r.connectedApps)) throw new Error('Could not load connected apps.');
      if (request === appsRequest.current) {
        setApps(r.connectedApps);
        setAppsError('');
      }
    } catch (e) {
      if (request === appsRequest.current) setAppsError(signal.aborted ? 'The request took too long. Try again.' : (e as Error).message);
    }
  }, []);
  const cancelRefresh = useCallback(() => {
    // Invalidate before aborting so cancelled reads cannot overwrite a newer result.
    connectionsRequest.current++;
    appsRequest.current++;
    refreshController.current?.abort();
    refreshController.current = null;
  }, []);
  const refresh = useCallback(async () => {
    cancelRefresh();
    const controller = new AbortController();
    refreshController.current = controller;
    // Even a warm catalog waits on the provider's account lookup. Bound both
    // reads so a stalled response cannot leave Checking or Retry stuck.
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    setRefreshing(true);
    try {
      await Promise.all([loadConnections(controller.signal), loadApps(controller.signal)]);
    } finally {
      window.clearTimeout(timeout);
      if (refreshController.current === controller) {
        refreshController.current = null;
        setRefreshing(false);
      }
    }
  }, [cancelRefresh, loadConnections, loadApps]);
  useEffect(() => { void refresh(); return cancelRefresh; }, [version, refresh, cancelRefresh]);

  const manage = async (id: string, action: 'default' | 'disconnect' | 'remove-expired') => {
    if (managing.current) return;
    managing.current = true;
    if (action !== 'disconnect') setDisconnectId(null);
    setBusy(true);
    setError('');
    try {
      await verifyAccessAccount(accountId);
      const suffix = action === 'default' ? '/default' : action === 'remove-expired' ? '/expired' : '';
      const r = await fetch(`/api/apps/connections/${encodeURIComponent(id)}${suffix}`, {
        method: action === 'default' ? 'POST' : 'DELETE', credentials: 'include',
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || body?.ok !== true) {
        if (action === 'remove-expired' && r.status === 409) await refresh();
        throw new Error(body?.error ?? (action === 'remove-expired'
          ? 'Could not remove this expired record. Refresh its status and try again.'
          : 'Could not update this account.'));
      }
      if (action === 'remove-expired') {
        setConnections(current => current?.filter(c => c.id !== id) ?? null);
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      managing.current = false;
      setBusy(false);
      if (action === 'disconnect') setDisconnectId(null);
    }
  };
  const visible = visibleConnections(connections ?? []);
  const connectedCount = connectionSummary(connections ?? []).connectedCount;
  const active = visible.filter(c => connectionStatus(c.status, c.isDisabled) === 'active');
  const expired = visible.filter(c => c.status === 'EXPIRED');
  const other = visible.filter(c => c.status !== 'EXPIRED' && connectionStatus(c.status, c.isDisabled) !== 'active');
  const accountDetails = (c: SettingsAppConnection, index: number) => {
    const app = apps?.find(app => app.slug === c.toolkit);
    const name = toolkitDisplayName(c.toolkit, app?.name);
    return <>
      <div className="cfg-row__text">
        <div className="cfg-row__title" title={`Connection ID: ${c.id}`}>{name} · Account {index + 1}</div>
        <ConnectedAccountDetails account={c} />
        <div className="access-apps-settings__statuses">
          {c.isDisabled && <span className="cfg-chip">Disabled</span>}
          {c.status === 'ACTIVE' && !c.isDisabled && c.isDefault && <span className="cfg-chip">Default</span>}
        </div>
        {c.status === 'EXPIRED' && c.authorizationIncomplete && <div className="cfg-row__sub">Authorization was not completed</div>}
      </div>
    </>;
  };
  const reconnect = async (toolkit: string) => {
    if (managing.current || !current()) return;
    managing.current = true; setBusy(true); setError('');
    const popup = openPopup('about:blank');
    try {
      await verifyAccessAccount(accountId);
      if (!current()) { popup?.close(); return; }
      const { redirectUrl } = await api.connect(toolkit);
      if (!current()) { popup?.close(); return; }
      if (popup && !popup.closed) popup.location.href = redirectUrl;
      else if (!window.open(redirectUrl, '_blank') && !isNativeApp) throw new Error('Allow pop-ups and try again.');
    } catch (e) { popup?.close(); if (current()) setError((e as Error).message); }
    finally { managing.current = false; if (current()) setBusy(false); }
  };
  const reconnectAction = (c: SettingsAppConnection) => connectionStatus(c.status, c.isDisabled) === 'needs_reauth'
    ? <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void reconnect(c.toolkit)}>Reconnect</button> : null;
  const openApps = () => { setDisconnectId(null); setCatalog(true); };
  if (catalog) return <ConnectAppsCatalog inline onClose={() => setCatalog(false)} />;
  return (
    <div className="access-apps-settings">
      <div className="access-apps__heading">
        <PageHead title="Connected apps" sub="Apps your Bots can use for you, like email, calendar and docs." />
        <button type="button" className="cfg-btn cfg-btn--primary access-apps-settings__manage" onClick={openApps}>{apps === null || apps.length ? 'Manage apps' : 'Connect apps'}</button>
      </div>
      {(connectionsError || appsError) && <div className="access-apps-settings__errors">
        {connectionsError && <div className="cfg-error" role="alert">Accounts could not be refreshed: {connectionsError}</div>}
        {appsError && <div className="cfg-error" role="alert">Apps could not be refreshed: {appsError}</div>}
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy || refreshing} onClick={() => void refresh()}>Retry refresh</button>
      </div>}
      {error && <div className="cfg-error" role="alert">{error}</div>}
      <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy || refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh status'}</button>
      <section className="cfg-section" aria-label="Your apps">
        <h2 className="cfg-section__label">Your apps</h2>
        <div className="access-apps-settings__summary" role="status">
          <strong>{connections === null ? (connectionsError ? 'Apps unavailable' : 'Checking…') : connectedCount ? `${connectedCount} app${connectedCount === 1 ? '' : 's'} connected` : 'No apps connected yet'}</strong>
          <p className="cfg-field__hint">Bots ask before doing anything that changes data in an app.</p>
        </div>
        {!!apps?.length && (
          <div className="cfg-card">
            {apps.map((a) => (
              <div key={a.slug} className="cfg-row access-apps-settings__row"><SettingIcon icon={Blocks} />
                <div className="cfg-row__text">
                  <div className="access-apps-settings__name"><span className="cfg-row__title">{a.name}</span><span className="cfg-chip">Connected</span></div>
                  <ConnectedAccounts accounts={a.accounts} />
                  {a.description && <div className="cfg-row__sub access-apps-settings__description">{a.description}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="cfg-section" aria-label="Your connected accounts">
        <h2 className="cfg-section__label">Your connected accounts</h2>
        <p className="cfg-field__hint">Choose a default when you have several accounts for an app. Otherwise, select the account explicitly when asking a Bot to use it.</p>
        <div className="cfg-card">
          {connections === null ? <div className="cfg-empty cfg-empty--flat">{connectionsError ? 'Accounts unavailable' : 'Loading accounts…'}</div>
            : !active.length ? <div className="cfg-empty cfg-empty--flat">No active accounts connected.</div>
              : active.map((c, index) => <div className="cfg-row access-apps-settings__row" key={c.id}><SettingIcon icon={CircleUserRound} />
                {accountDetails(c, index)}
                <div className="settings-row__actions">
                  <button className="cfg-btn cfg-btn--secondary" type="button" disabled={busy || c.isDefault} onClick={() => void manage(c.id, 'default')}>Use by default</button>
                  <button ref={disconnectId === c.id ? disconnectButton : undefined} className={`cfg-btn access-apps-settings__disconnect ${disconnectId === c.id ? 'cfg-btn--danger' : 'cfg-btn--secondary'}`} type="button" disabled={busy} onClick={() => {
                    if (disconnectId === c.id) void manage(c.id, 'disconnect');
                    else { setError(''); setDisconnectId(c.id); }
                  }}>{disconnectId === c.id ? (busy ? 'Disconnecting…' : 'Confirm disconnect') : 'Disconnect'}</button>
                  {disconnectId === c.id && <button className="cfg-btn cfg-btn--secondary" type="button" disabled={busy} onClick={() => { disconnectButton.current?.focus(); setDisconnectId(null); }}>Cancel</button>}
                </div>
              </div>)}
        </div>
      </section>
      {!!other.length && <section className="cfg-section" aria-label="Other connections">
        <h2 className="cfg-section__label">Other connections</h2>
        <p className="cfg-field__hint">These accounts are unavailable for Bots to use. Their current status is shown below.</p>
        <div className="cfg-card">
          {other.map((c, index) => <div className="cfg-row access-apps-settings__row" key={c.id}><SettingIcon icon={CircleUserRound} />{accountDetails(c, index)}<div className="settings-row__actions">{reconnectAction(c)}</div></div>)}
        </div>
      </section>}
      {!!expired.length && <section className="cfg-section" aria-label="Expired connections">
        <details className="cfg-card access-apps-settings__disclosure">
          <summary className="cfg-row"><SettingIcon icon={CircleUserRound} />
            <span className="cfg-row__text">
              <span className="cfg-row__title">Expired connections ({expired.length})</span>
              <span className="cfg-row__sub">Review and remove expired records one at a time.</span>
            </span>
            <ChevronRight size={18} strokeWidth={1.75} aria-hidden />
          </summary>
          {expired.map((c, index) => <div className="cfg-row access-apps-settings__row" key={c.id}><SettingIcon icon={CircleUserRound} />
            {accountDetails(c, index)}
            <div className="settings-row__actions">
              {reconnectAction(c)}
              <ConfirmButton disabled={busy} confirmLabel="Confirm removal" title="Remove only this expired connection record" onConfirm={() => manage(c.id, 'remove-expired')}>Remove expired record</ConfirmButton>
            </div>
          </div>)}
        </details>
      </section>}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Account time zone: daily synopses, check-ins and analytics days follow it. */
function TimeZoneRow({ user }: { user: User }) {
  const saved = (user as User & { timezone?: string | null }).timezone ?? null;
  const [value, setValue] = useState(saved ? canonicalTimeZone(saved) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setValue(saved ? canonicalTimeZone(saved) : ''); }, [saved]);
  const browserZone = browserTimeZone();
  const zones = useMemo(() => buildTimeZoneOptions(value || browserZone), [value, browserZone]);
  const change = async (next: string) => {
    if (busy || !next) return;
    const previous = value;
    setValue(next); setBusy(true); setError('');
    try {
      const result = await api.updateMe({ timezone: next });
      const state = useStore.getState();
      if (state.user?.id !== user.id) return;
      state.set({ user: { ...(result?.user ?? state.user), timezone: next } as User });
      toast(`Time zone set to ${zones.find(zone => zone.value === next)?.label ?? next}`);
    } catch (e) {
      if (useStore.getState().user?.id === user.id) { setValue(previous); setError(`Couldn’t save the time zone: ${(e as Error).message}`); }
    } finally { setBusy(false); }
  };
  return <>
    <SettingRow icon={Clock3} title="Time zone" sub={saved ? 'Schedules and analytics use this as the account default.' : 'No time zone is saved. UTC is the account default for schedules and analytics.'}>
      <TimeZonePicker value={value} options={zones} disabled={busy} onChange={next => void change(next)} />
    </SettingRow>
    {!saved && browserZone && <div className="settings-timezone-suggestion"><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void change(canonicalTimeZone(browserZone))}>Use {zones.find(zone => zone.value === canonicalTimeZone(browserZone))?.label ?? browserZone}</button></div>}
    {error && <div className="cfg-error cfg-error--inset" role="alert">{error}</div>}
  </>;
}

function AccountSection() {
  const user = useStore((s) => s.user);
  return user && <AccountSettings key={user.id} user={user} />;
}

const deleteAccountIntent = (value: unknown) => value === 'delete-account' ? 'delete-account' : null;

function AccountSettings({ user }: { user: User }) {
  const appleLogin = useStore((s) => s.appleLogin);
  const appleLinked = useStore((s) => s.appleLinked);
  const googleLogin = useStore((s) => s.googleLogin);
  const googleLinked = useStore((s) => s.googleLinked);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<'signout' | 'delete' | null>(null);
  const action = useRef(false);
  const mounted = useRef(false);
  const deleteHeading = useRef<HTMLHeadingElement>(null);
  const reauth = useAccessReauth('account', user.id, deleteAccountIntent);
  const email = user.email.endsWith('@openrouter.invalid') ? 'OpenRouter account' : user.email;
  const current = () => mounted.current && useStore.getState().user?.id === user.id;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (reauth.returned) setDeleting(true); }, [reauth.returned]);
  useEffect(() => { if (deleting) deleteHeading.current?.focus(); }, [deleting, reauth.pending]);

  async function act(kind: 'signout' | 'delete') {
    if (action.current || !current() || reauth.pending || reauth.checking) return;
    action.current = true; setBusy(kind); setError(null);
    try {
      await verifyAccessAccount(user.id);
      if (!current()) return;
      await (kind === 'delete' ? api.deleteAccount(user.id) : api.logout());
      if (useStore.getState().user?.id === user.id) window.location.replace('/');
    } catch (err) {
      if (!current()) return;
      if (kind === 'delete' && needsReauth(err)) reauth.request('delete-account', err.message);
      else setError(err instanceof Error ? err.message : 'The account action failed.');
    } finally {
      action.current = false;
      if (current()) setBusy(null);
    }
  }

  if (reauth.checking) return <><PageHead title="Your account" /><p role="status">Verifying your sign-in…</p></>;
  if (reauth.pending) return <>
    <PageHead title="Delete your Swarm account?" />
    <ReauthPrompt accountEmail={user.email} reason={reauth.pending.reason} resume={{ section: 'account', accountId: user.id, action: 'login' }} retryLabel="Delete my account" terminalActive={false} onCancel={() => { reauth.cancel(); setDeleting(false); }} />
  </>;
  if (deleting) return <div className="account-delete">
    <div className="app-settings__head"><h1 ref={deleteHeading} tabIndex={-1}>Delete your Swarm account?</h1><p>This permanently removes your account, Bots and conversations. Apple access is revoked if linked.</p></div>
    {reauth.returned && <p role="status" className="access-section-note">You’re signed in again. Nothing has been deleted.</p>}
    <div className="account-delete__warning"><strong>This can’t be undone</strong><p>Deleting your account is different from signing out or clearing local data.</p></div>
    <SettingRow icon={CircleUserRound} title="Account to delete" sub={email} />
    <section className="cfg-section">
      <h2 className="cfg-section__label">Before you continue</h2>
      <p>Cancel to keep your account and return to Account settings.</p>
      {error && <div className="cfg-error" role="alert">{error}</div>}
      <div className="access-row-actions">
        <button type="button" className="cfg-btn cfg-btn--danger" disabled={!!busy} onClick={() => void act('delete')}>{busy ? 'Deleting…' : 'Delete my account'}</button>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => { setDeleting(false); setError(null); }}>Cancel</button>
      </div>
    </section>
  </div>;

  return (
    <>
      <PageHead title="Your account" sub="Review the identity and sign-in methods for this Swarm account." />
      <section className="cfg-section access-account" aria-label="Profile and sign-in methods">
        {reauth.error && <div className="cfg-error" role="alert">{reauth.error}</div>}
        <div className="cfg-card">
          <div className="cfg-row"><SettingIcon icon={CircleUserRound} /><div className="cfg-row__text"><div className="cfg-row__title">{user.name || 'Swarm member'}</div><div className="cfg-row__sub">{email}</div><div className="cfg-row__sub">Signed in</div></div></div>
          {(appleLogin || appleLinked) && <SettingRow icon={CircleUserRound} title="Sign in with Apple" sub={appleLinked ? 'Connected. Use it to sign in to this account on the web or in the Swarm app.' : 'Use your Apple account on the web or in the Swarm app.'}>
            {appleLinked ? <span className="cfg-chip">Connected</span> : <AppleSignIn link />}
          </SettingRow>}
          {(googleLogin || googleLinked) && <SettingRow icon={CircleUserRound} title="Sign in with Google" sub={googleLinked ? 'Connected. Use it to sign in to this account on the web or in the Swarm app.' : 'Google sign-in uses Composio and requests Gmail access to verify your email address.'}>
            {googleLinked ? <span className="cfg-chip">Connected</span> : <AuthLink className="signin__google" href="/api/auth/google/start?intent=link">Connect Google</AuthLink>}
          </SettingRow>}
          <TimeZoneRow user={user} />
          <SettingRow icon={ShieldCheck} title="Delete your account" sub="Permanently removes your account, Bots and conversations.">
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => { setError(null); setDeleting(true); }}>Delete account…</button>
          </SettingRow>
        </div>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => void act('signout')}>{busy ? 'Signing out…' : 'Sign out'}</button>
        {error && <div className="cfg-error" role="alert">{error}</div>}
      </section>
      <AccountSessions accountId={user.id} />
    </>
  );
}
