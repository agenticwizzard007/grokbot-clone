import { InfoTip, SettingsMenu } from './SettingsControls';
import { Section, Card, Row, ButtonGroup } from '../layout';
import { ProviderMark } from '../ProviderMark';
import { ApprovalLevelSettings } from './ApprovalLevelSettings';
import { InputLatencyDiagnostics } from '../InputLatencyDiagnostics';
import { prefetchApps } from '../../lib/appsCatalogCache';
import { visibleConnections, connectionStatus } from '@shared/connection-details';
import { ConnectedAccountDetails, type DisplayAccount } from '../ConnectedAccountDetails';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, ChevronRight, CircleUserRound, Clock3, TextCursorInput, Monitor, PanelLeftOpen, Settings2, ShieldCheck } from 'lucide-react';
import { SettingRow, SettingIcon } from './SettingRow';
export { SettingRow } from './SettingRow';
import type { Toolkit, User } from '@shared/types';
import { configApi, type ComputerDetails, type KeysResponse, type KeyStatus, type Pairing } from '../../lib/configApi';
import { ModelPicker, refreshModels } from './ModelPicker';
import { LearningSettingsPanel } from './LearningSettings';
import { UsageSection } from './UsageSection';
import { relativeShort } from '../../lib/time';
import { navigation, openConversation, useConfigUI, useVersion, type Theme } from '../../configStore';
import { handoffApi, type HandoffLink, type HandoffSettings } from '../../handoffs/api';
import { errorText, handoffText, refreshHandoffs, useHandoffResource } from '../../handoffs/useHandoffs';
import { useStore } from '../../store';
import { computerStatusText } from './computerStatus';
import { ConfirmButton, Segmented, Switch } from './ui';
import { McpSettings } from './McpSettings';
import { MessagingSettings } from './MessagingSettings';
import { SubscriptionSettings } from './SubscriptionSettings';
import { openrouterApi } from '../../lib/openrouterApi';
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

// Keep the public entry for existing embedded Settings surfaces.
export { AppSettings } from './SettingsFrame';

export function AppSettingsContent() {
  const section = useConfigUI(s => s.appSettings);
  const catalogAccountId = useStore(s => s.user?.id);
  useEffect(() => { prefetchApps(catalogAccountId); }, [catalogAccountId]);
  return <>
            {section === 'general' && <GeneralSection />}
            {section === 'agents' && <AgentsSection key={catalogAccountId} />}
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

/** Account policy and per-pair automation use the existing handoff services. */
export function AgentsSection() {
  const accountId = useStore(s => s.user?.id);
  const bots = useStore(s => s.bots);
  const senders = bots.filter(bot => bot.kind !== 'room');
  const [selected, setSelected] = useState('');
  const sender = senders.find(bot => bot.id === selected) ?? senders[0];
  const policy = useHandoffResource(`agents-policy:${accountId}`, signal => handoffApi.settings(signal));
  const settings = policy.data?.settings;
  const links = useHandoffResource(`agents-links:${accountId}:${sender?.id}`, signal => handoffApi.links(sender!.id, signal), !!sender && !!settings?.enabled);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const locked = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && useStore.getState().user?.id === accountId;
  const save = async (write: () => Promise<unknown>) => {
    if (locked.current || !current()) return;
    locked.current = true; setBusy(true); setError(''); setSaved(false);
    try { await write(); if (current()) { setSaved(true); refreshHandoffs(); } }
    catch (reason) { if (current()) setError(errorText(reason)); }
    finally { locked.current = false; if (current()) setBusy(false); }
  };
  const changePolicy = (patch: Partial<HandoffSettings>) => settings && save(() => handoffApi.saveSettings({ ...settings, ...patch }));
  const changeLink = (link: HandoffLink, patch: Partial<HandoffLink>) => save(async () => {
    const senderId = sender!.id;
    const latest = (await handoffApi.links(senderId)).links;
    if (!current()) return;
    if (!latest.some(item => item.id === link.id)) throw new Error('This link changed. Reload and try again.');
    // Link ids are server-owned. Preserve every editable field, including links
    // not shown in this row, while sending only the strict command schema.
    return handoffApi.saveLinks(senderId, latest.map(item => {
      const { toBotId, mode, trigger, template, autoApproveLoops } = item.id === link.id ? { ...item, ...patch } : item;
      return { toBotId, mode, trigger, template, autoApproveLoops };
    }));
  });
  const disabled = busy || policy.loading;
  const state = (resource: { loading: boolean; error?: string; retry: () => void }) => resource.error
    ? <Card role="alert"><span className="cfg-chip">Unavailable</span><InfoTip label="Load error">{resource.error}</InfoTip><ButtonGroup><button className="cfg-btn cfg-btn--secondary" onClick={resource.retry}>Retry</button></ButtonGroup></Card>
    : resource.loading ? <span className="cfg-chip" role="status">Loading</span> : null;
  return <div className="agents-settings" aria-busy={busy || policy.loading || links.loading}>
    <style>{`
      .agents-settings { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; font-size: 14px; line-height: 20px; }
      .agents-settings .cfg-chip { display: inline-flex; align-items: center; align-self: flex-start; height: 20px; padding: 2px var(--space-2); border-radius: var(--radius-full); font: 500 var(--text-xs)/var(--line-caption) var(--font-stack); white-space: normal; }
      .agents-settings .cfg-btn { font-size: 14px; padding-inline: 16px; gap: 8px; }
      .agents-settings .agents-field { display: flex; flex-direction: column; gap: 8px; min-width: 0; font-size: 14px; }
      .agents-settings select { width: 100%; min-width: 0; min-height: var(--control-h); padding: 8px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg-pane); color: var(--color-text-primary); font: inherit; }
      .agents-settings .agents-check { display: flex; align-items: center; gap: 8px; min-height: var(--control-h); cursor: pointer; }
      .agents-settings .agents-check input { flex: 0 0 20px; width: 20px; height: 20px; margin: 0; accent-color: var(--color-primary); }
      .agents-settings .layout-row__subtitle { font-size: 13px; line-height: 18px; }
      .agents-settings .layout-row__trailing { align-self: center; }
      .agents-settings .settings-disclosure .layout-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); align-items: center; }
      .agents-settings .settings-disclosure .layout-row__text { min-width: 0; }
      .agents-settings .agents-saved { color: var(--color-success); background: var(--color-success-bg); }
    `}</style>
    <Section title="Handoffs" action={<InfoTip label="About handoffs">Send finished work to another agent. Team allows any available teammate; Links only follows standing links; Off stops agent sends. You can still send work yourself. Limits: 20 per agent per hour, 100 per account per day.</InfoTip>}>
      {!settings && state(policy)}
      {settings && <Card>
        <Row title={<label className="agents-check"><input type="checkbox" role="switch" aria-label="Enable handoffs and loops" aria-checked={settings.enabled} checked={settings.enabled} disabled={disabled} onChange={event => void changePolicy({ enabled: event.target.checked })} />Enabled</label>} />
        <Row title={<label className="agents-field">Agent handoffs<select aria-label="Agent handoffs" value={settings.agentHandoffs} disabled={disabled || !settings.enabled} onChange={event => void changePolicy({ agentHandoffs: event.target.value as HandoffSettings['agentHandoffs'] })}>
          <option value="team">Team</option><option value="links_only">Links only</option><option value="off">Off</option>
        </select></label>} />
      </Card>}
    </Section>
    {settings?.enabled && <Section title="Standing links" action={<InfoTip label="About standing links">Automatic sends matching finished work without another tap. Suggest offers a send button. Loop approval applies only to this pair.</InfoTip>}>
      <Card>
        {sender && <Row title={<label className="agents-field">From<select aria-label="Links from" value={sender.id} disabled={busy || links.loading} onChange={event => { setSelected(event.target.value); setSaved(false); setError(''); }}>
          {senders.map(bot => <option key={bot.id} value={bot.id}>{handoffText(bot.name)}</option>)}
        </select></label>} />}
        {state(links)}
        {(!sender || links.data?.links.length === 0) && <Row title={<span className="cfg-chip">No links</span>} />}
        {links.data?.links.map(link => {
          const name = handoffText(bots.find(bot => bot.id === link.toBotId)?.name ?? 'Agent');
          return <Row key={link.id} title={<label className="agents-field">{name}<select aria-label={`Handoff mode for ${name}`} value={link.mode} disabled={busy || links.loading} onChange={event => void changeLink(link, { mode: event.target.value as HandoffLink['mode'] })}>
            <option value="off">Off</option><option value="suggest">Suggest</option><option value="auto">Automatic</option>
          </select></label>}>
            <label className="agents-check"><input type="checkbox" aria-label={`Auto approve loops started by agents with ${name}`} checked={link.autoApproveLoops} disabled={busy || links.loading} onChange={event => void changeLink(link, { autoApproveLoops: event.target.checked })} />Approve loops</label>
          </Row>;
        })}
      </Card>
      {sender && <ButtonGroup><button className="cfg-btn cfg-btn--secondary" aria-label="Add a standing link" onClick={() => navigation.navigate({ kind: 'details', bot: sender.id, tab: 'activity', flow: true, link: 'new' })}>Add link</button></ButtonGroup>}
    </Section>}
    <Section title="Loops" action={<InfoTip label="About loops">Work and review repeat until checks pass or a limit is reached. Choose limits when starting a loop. Agents need approval first unless their exact pair is approved above.</InfoTip>}>
      <Card><details className="settings-disclosure">
        <summary>Defaults and limits</summary>
        <Row title="Passes" trailing={<span>4 (1 to 10)</span>} />
        <Row title="Total minutes" trailing={<span>30 (5 to 240)</span>} />
        <Row title="Step minutes" trailing={<span>10 (1 to 30)</span>} />
        <Row title="Running loops" trailing={<span>3</span>} />
        <Row title="Starts per day" trailing={<span>20</span>} />
        <Row title={<span className="settings-label-info">Cost and tokens<InfoTip label="About usage limits">Optional caps when usage is reported. Some plans do not report cost.</InfoTip></span>} trailing={<span>Optional</span>} />
      </details></Card>
      {settings?.enabled && <ButtonGroup><button className="cfg-btn cfg-btn--primary" onClick={() => navigation.navigate({ kind: 'loops' })}>Open Loops</button></ButtonGroup>}
    </Section>
    {error && <Card role="alert"><span className="cfg-chip">Not saved</span><InfoTip label="Save error">{error}</InfoTip></Card>}
    {saved && <span className="cfg-chip agents-saved" role="status">Saved</span>}
  </div>;
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
  const theme = useConfigUI(s => s.theme);
  const setTheme = useConfigUI(s => s.setTheme);
  const user = useStore(s => s.user);
  const accountId = user?.id;
  const [detailsDefault, setDetailsDefault] = useState(() => readDetailsDefault(accountId));
  useEffect(() => { setDetailsDefault(readDetailsDefault(accountId)); }, [accountId]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const shortcuts = SHORTCUTS.filter(s => !(s.web && isNativeApp));
  return <div className="settings-general">
    <Section className="settings-appearance" aria-label="Appearance" footer={<button type="button" className="link-btn settings-diagnostics" aria-expanded={diagnosticsOpen} onClick={() => setDiagnosticsOpen(!diagnosticsOpen)}>Diagnostics</button>}><Card variant="list" ><SettingRow icon={Settings2} title="Theme">
          <Segmented label="Theme" value={theme} onChange={setTheme} options={(['light', 'dark', 'system'] as const).map(t => ({ value: t, label: t === 'system' ? 'Auto' : THEME_LABEL[t] }))} />
        </SettingRow><SettingRow icon={PanelLeftOpen} title="Show details panel">
          <Switch label="Show details panel" on={detailsDefault} onChange={v => { writeDetailsDefault(accountId, v); setDetailsDefault(v); }} />
        </SettingRow><SettingRow icon={Clock3} title="Time zone" sub={(user as (User & { timezone?: string }) | null)?.timezone || browserTimeZone()}>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openAppSettings('account')}>Change</button>
        </SettingRow><SettingRow icon={TextCursorInput} title="Keyboard shortcuts">
          <button type="button" className="cfg-btn cfg-btn--secondary" aria-expanded={shortcutsOpen} aria-controls="general-shortcuts" onClick={() => setShortcutsOpen(!shortcutsOpen)}>{shortcutsOpen ? 'Hide' : 'View'}</button>
        </SettingRow></Card>
    {shortcutsOpen && <Card variant="list" id="general-shortcuts" className="settings-shortcuts" aria-label="Keyboard shortcuts">{shortcuts.map(shortcut => <SettingRow icon={TextCursorInput} key={shortcut.label} title={shortcut.label}><Keys keys={shortcutKeys(shortcut)} /></SettingRow>)}</Card>}
    </Section>
    {diagnosticsOpen && <InputLatencyDiagnostics />}
  </div>;
}

// ---------------------------------------------------------------------------
// API keys: the server's provider keys, entered in the app and verified before saving.

function KeyCard({ name, title, status, canEdit, onChange }: {
  name: 'voice' | 'direct' | 'composio' | 'openrouter'; title: string;
  status: KeyStatus; canEdit: boolean; onChange: (r: KeysResponse) => void;
}) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="settings-key-row">
    <Row leading={<ProviderMark provider={name === 'voice' ? 'xai' : name} />} title={<span className="settings-provider">{title}<span className="cfg-chip">{status.set ? 'Key saved' : 'Not connected'}</span></span>} trailing={<button type="button" className="cfg-btn cfg-btn--secondary" disabled={!canEdit || busy} aria-expanded={editing} onClick={() => setEditing(v => !v)}>{status.set ? 'Replace' : 'Add key'}</button>} />
    {editing && <form className="settings-inline-form" onSubmit={async e => {
      e.preventDefault(); if (!value.trim() || busy) return;
      setBusy(true); setError('');
      try { const r = await configApi.saveKey(name, value.trim()); onChange(r); setValue(''); setEditing(false); if (r.modelOk === false) setError('Choose an available default model.'); }
      catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>
      <label htmlFor={`key-input-${name}`}>{title} API key</label>
      <input id={`key-input-${name}`} className="text-input" type="password" autoComplete="off" spellCheck={false} value={value} onChange={e => setValue(e.target.value)} autoFocus />
      <ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setValue(''); setEditing(false); }}>Cancel</button><button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || !value.trim()}>Save</button></ButtonGroup>
      {status.source === 'app' && <ConfirmButton disabled={busy} confirmLabel="Remove key" onConfirm={async () => { setBusy(true); try { onChange(await configApi.clearKey(name)); setEditing(false); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Remove key</ConfirmButton>}
    </form>}
    {error && <p role="alert" className="cfg-error">{error}</p>}
  </div>;
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
    {reauth.checking && <p role="status">Verifying your sign-in</p>}
    {reauth.returned && <p role="status">You're signed in again. Review your credentials and retry the change.</p>}
    {reauth.error && <p className="cfg-error" role="alert">{reauth.error}</p>}
    <ServerKeysSection accountId={accountId} onReauth={onReauth} />
  </>;
}

function ServerKeysSection({ accountId, onReauth }: { accountId: string; onReauth: (error: Error) => void }) {
  const [personalRevision, refreshPersonal] = useState(0);
  const [keys, setKeys] = useState<KeysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  useEffect(() => { configApi.keys().then(setKeys).catch((e) => setError((e as Error).message)); }, []);
  // Keep fields the save response may not repeat (e.g. canEdit).
  const changed = (r: KeysResponse) => { setKeys((k) => (k ? { ...k, ...r } : r)); refreshModels(); setPickerKey((n) => n + 1); };
  const save = async (name: 'provider' | 'model' | 'openrouter_model', value: string) => {
    setNote(null);
    try { changed(await configApi.saveKey(name, value)); setNote({ tone: 'ok', text: 'Saved.' }); }
    catch (e) { setNote({ tone: 'error', text: (e as Error).message }); }
  };

  if (error) return <p className="cfg-error" role="alert">{error}</p>;
  if (!keys) return <p role="status">Loading</p>;
  if (keys.isolated) return <><Card variant="list"><OpenRouterSettings onReauth={onReauth} onChanged={() => refreshPersonal(value => value + 1)} /><PrivateKeysSettings accountId={accountId} onReauth={onReauth} /></Card><PersonalDefaultModel onReauth={onReauth} revision={personalRevision} /></>;
  const chosen = keys.provider.chosen ?? keys.provider.value;
  const current = chosen === 'openrouter' ? keys.openrouterModel.value : keys.model.value;
  return <>
    <Section><Card variant="list">
      <OpenRouterSettings onReauth={onReauth} onChanged={() => refreshPersonal(value => value + 1)} />
      <KeyCard name="direct" title="Model API" status={keys.direct} canEdit={keys.canEdit} onChange={changed} />
      <KeyCard name="voice" title="xAI voice" status={keys.voice} canEdit={keys.canEdit} onChange={changed} />
    </Card></Section>
    <PersonalDefaultModel onReauth={onReauth} revision={personalRevision} />
    {note && <p role="status" className={note.tone === 'error' ? 'cfg-error' : ''}>{note.text}</p>}
    <details className="settings-disclosure"><summary>Server defaults</summary><div className="settings-stack">
      <Section title="Default API model"><ModelPicker key={`${chosen}-${pickerKey}`} provider={chosen} label="Default API model" value={current} disabled={!keys.canEdit} onChange={id => { if (id && id !== current) void save(chosen === 'openrouter' ? 'openrouter_model' : 'model', id); }} /></Section>
      <Row title="Provider" trailing={<Segmented label="Model provider" value={chosen} options={[{value:'direct',label:'Model API'},{value:'openrouter',label:'OpenRouter'}]} onChange={value => { if (keys.canEdit) void save('provider',value); }} />} />
      <Card variant="list"><KeyCard name="openrouter" title="Server OpenRouter" status={keys.openrouter} canEdit={keys.canEdit} onChange={changed} /><KeyCard name="composio" title="Connected apps" status={keys.composio} canEdit={keys.canEdit} onChange={changed} /></Card>
    </div></details>
  </>;
}

function PersonalDefaultModel({ onReauth, revision }: { onReauth: (error: Error) => void; revision: number }) {
  const accountId = useStore(s => s.user?.id);
  const current = useAccessPanel(accountId);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof openrouterApi.status>> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { openrouterApi.status().then(r => { if (current()) setStatus(r); }).catch(e => { if (current()) setError(e.message); }); }, [current, revision]);
  return <Section title="Default API model"><ModelPicker provider="openrouter" label="Default API model" value={status?.model ?? null} disabled={!status?.connected} onChange={model => {
    if (!model || !accountId || !current()) return;
    void verifyAccessAccount(accountId).then(async () => { if (current()) { const r = await openrouterApi.update({model}); if (current()) { setStatus(r); refreshModels(); } } }).catch(e => { if (current()) { if (needsReauth(e)) onReauth(e); else setError(e.message); } });
  }} />{error && <p role="alert" className="cfg-error">{error}</p>}</Section>;
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
      <Card variant="list"><Row leading={<SettingIcon icon={Monitor} />} title={<span className="settings-provider">Cloud computer <span className="cfg-chip">{computerStatusText(computer ?? null)}</span></span>} trailing={<SettingsMenu items={[
        {label: 'Watch', disabled: !watchBot, onSelect: watch},
        {label: running ? 'Sleep' : 'Wake', disabled: transitioning || !!busy, onSelect: () => void act(running ? 'sleep' : 'wake')},
      ]} />} />{note && <p role="alert" className="cfg-error">{note}</p>}{computer?.error && <p role="alert" className="cfg-error">{computer.error}</p>}<AskBeforeComputerRow /></Card>
      <details className="settings-disclosure"><summary>Learn more</summary><div className="settings-stack"><p>{details ? `Sleeps after ${details.hibernation.idleMinutes} idle minutes. Wakes when a Bot needs it.` : 'Checking computer status.'}</p>

      <Section  title={<>Screens in use</>}><Card variant="list" >{detailsError ? <div className="cfg-error" role="alert">{detailsError} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={load}>Try again</button></div> : !details ? <div className="cfg-empty cfg-empty--flat" role="status">Loading</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">No Bot screens are open.</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <Row key={s.botId}  leading={<SettingIcon icon={Monitor} />} title={<>{bot?.name ?? 'Removed Bot'}</>} subtitle={<><div className="cfg-row__sub">{screenLabel(s.screenId)} · used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div></>} trailing={<><ConfirmButton
                  className="cfg-btn cfg-btn--secondary"
                  confirmLabel="Reset screen"
                  disabled={!running}
                  title={running ? 'Closes everything open on this screen' : 'Wake the computer first'}
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); load(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Reset
                </ConfirmButton></>} />
            );
          })}</Card><div className="cfg-field__hint">Reset closes every window on that Bot's screen, so it starts clean next time. {(computer ?? details?.computer)?.provider === 'cloudvm' ? 'Every Bot has its own screen; the computer grows as you add Bots.' : 'Up to 4 Bots can have a screen at once.'}</div></Section>
      <DeviceAccessSection />
      </div></details>
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
      .catch(e => { if (alive) setError(`Couldn't load this setting: ${(e as Error).message}`); });
    return () => { alive = false; };
  }, [accountId, attempt]);
  const change = async (next: boolean) => {
    if (busy) return;
    setBusy(true); setError(''); setOn(next);
    try {
      const saved = await api.updatePreferences({ askBeforeComputer: next });
      if (useStore.getState().user?.id === accountId) setOn(typeof saved?.askBeforeComputer === 'boolean' ? saved.askBeforeComputer : next);
    } catch (e) {
      if (useStore.getState().user?.id === accountId) { setOn(!next); setError(`Couldn't save: ${(e as Error).message}`); }
    } finally { setBusy(false); }
  };
  return <>
    <SettingRow icon={ShieldCheck} title="Ask before computer use">
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
    try { await navigator.clipboard.writeText(pairing.command); setCopied(true); } catch { setNote('Couldn\'t copy. Select the command and copy it yourself.'); }
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
    } catch (err) { if (current()) setNote(err instanceof Error ? err.message : 'Couldn\'t change the computer connection.'); }
    finally { if (current()) setBusy(false); }
  };

  return <>
    <Section><Card variant="list"><Row leading={<SettingIcon icon={Monitor} />} title={nativeMac ? 'Your Mac' : 'Your PC'} subtitle={<span className="cfg-chip">{connected ? 'Connected' : 'Not connected'}</span>} trailing={!nativeMac && details && <>
      {!connected && <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={here?.available && !here.active ? useHere : pair}>Connect</button>}
      {(here?.active || paired) && <SettingsMenu disabled={busy} items={[
        ...(here?.active ? [{ label: 'Stop', onSelect: () => setConfirm('stop') }] : []),
        ...(paired ? [{ label: 'Disconnect', danger: true, onSelect: () => setConfirm('disconnect') }] : []),
        { label: 'Connect another PC', onSelect: () => void pair() },
      ]} />}
    </>} /></Card></Section>
    {detailsError && <p className="cfg-error" role="alert">{detailsError} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={reload}>Retry</button></p>}
    {confirm && <Card><p>{confirm === 'stop' ? 'Stop this computer? Its pairing is kept.' : 'Disconnect this PC? Pair again to reconnect.'}</p><ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button type="button" className="cfg-btn cfg-btn--danger" disabled={busy} onClick={() => void changeConnection()}>{confirm === 'stop' ? 'Stop' : 'Disconnect'}</button></ButtonGroup></Card>}
    {pairing && !connected && <Card><p>Run the command on your PC with Node.js.</p><button type="button" className="cfg-btn cfg-btn--primary" onClick={copy}>{copied ? 'Copied' : 'Copy command'}</button><p>Keep it private and leave the program running.</p></Card>}
    {note && <p className="cfg-error" role="alert">{note}</p>}
    <details className="settings-disclosure"><summary>Device access</summary><div className="settings-stack">
      <DeviceAccessSection /><AskBeforeComputerRow />
      <Section title={desktop ? 'Screens' : 'Browsers'}><Card variant="list">
        {!details ? <p role="status">Loading</p> : !details.screens.length ? <Row title="None open" /> : details.screens.map(screen => <Row key={screen.botId} leading={<SettingIcon icon={Monitor} />} title={byId.get(screen.botId)?.name ?? 'Removed Bot'} subtitle={relativeShort(screen.lastUsedAt)} trailing={!desktop && <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Close browser" disabled={!connected} onConfirm={async () => { try { await configApi.resetScreen(screen.botId); setNote(null); reload(); } catch (e) { setNote((e as Error).message); } }}>Close</ConfirmButton>} />)}
      </Card></Section>
      <p>{desktop ? 'Bots can use your desktop, apps and files.' : 'Bots use separate Chrome profiles on this PC.'}</p>
    </div></details>
  </>;
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
    configApi.deletePolicy(tool).then(load).catch((e) => setRowError({ tool, text: `Couldn't reset this permission: ${(e as Error).message}` }));
  };
  return (
    <>
      <ApprovalLevelSettings explain />
      <Section  title="Always allowed"><Card variant="list" >{loadError ? <div className="cfg-error" role="alert">Couldn't load permissions. {loadError} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={load}>Retry</button></div>
            : policies === null ? <div className="cfg-empty cfg-empty--flat">Loading</div> : policies.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">None</div>
          ) : policies.map((p) => {
            const displayTool = p.tool.replace(/^api_max:/, '');
            const h = mcpNames[displayTool.replace(/:bot:.*$/, '')] ?? (displayTool.startsWith('mcp_') ? { app: 'MCP server', action: 'Previous tool permission' } : humanizeTool(displayTool));
            return (
              <Row key={p.tool}  leading={<SettingIcon icon={ShieldCheck} />} title={<>{h.app}{h.action ? ` · ${h.action}` : ''}</>} subtitle={<><div className="cfg-row__sub">{p.tool.startsWith('api_max:') ? 'Ask before every action only · ' : 'Standard and CLI plans · '}{p.mode === 'always_allow' ? 'Always allowed' : p.mode === 'blocked' ? 'Never allowed' : 'Asks first'}{!displayTool.startsWith('mcp_') && <> · <code className="cfg-code">{displayTool}</code></>}</div></>} trailing={<><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => askAgain(p.tool)}>Ask again</button>{rowError?.tool === p.tool && <div className="cfg-error cfg-error--inset" role="alert">{rowError.text}</div>}</>} />
            );
          })}</Card></Section>
      <div className="device-access-link" data-swarm-device-access-link="">

        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openAppSettings('computer')}>Computer <ChevronRight size={14} aria-hidden /></button>
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
  const [query, setQuery] = useState('');
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
  const openApps = () => { setDisconnectId(null); setCatalog(true); };
  if (catalog) return <ConnectAppsCatalog inline onClose={() => setCatalog(false)} />;
  return <div className="settings-stack access-apps-settings">
    <Row title={<input className="text-input" type="search" aria-label="Search connected apps" placeholder="Search apps" value={query} onChange={e => setQuery(e.target.value)} />} trailing={<button type="button" className="cfg-btn cfg-btn--primary" onClick={openApps}>Connect</button>} />
    {(connectionsError || appsError) && <p className="cfg-error" role="alert">{connectionsError || appsError}</p>}
    {error && <p className="cfg-error" role="alert">{error}</p>}
    <Card variant="list">{connections === null ? <Row title="Loading" /> : !visible.length ? <Row title="No connections" /> : visible.filter(c => `${c.toolkit} ${JSON.stringify(c)}`.toLowerCase().includes(query.toLowerCase())).map(c => {
      const status = connectionStatus(c.status, c.isDisabled);
      const name = toolkitDisplayName(c.toolkit, apps?.find(a => a.slug === c.toolkit)?.name);
      return <div key={c.id}><Row leading={<SettingIcon icon={Blocks} />} title={<span className="settings-provider">{name}<span className="cfg-chip">{status === 'active' ? 'Connected' : status === 'needs_reauth' ? 'Sign in needed' : c.isDisabled ? 'Disabled' : 'Not connected'}</span></span>} subtitle={<ConnectedAccountDetails account={c} />} trailing={<SettingsMenu ariaLabel={`Manage ${name}`} disabled={busy} items={[
        {label: 'Refresh status', disabled: refreshing, onSelect: () => void refresh()},
        ...(status === 'needs_reauth' ? [{label: 'Sign in again', onSelect: () => void reconnect(c.toolkit)}] : []),
        ...(status === 'active' ? [{label: 'Use by default', disabled: c.isDefault, onSelect: () => void manage(c.id, 'default')}, {label: 'Disconnect', onSelect: () => setDisconnectId(c.id)}] : []),
        ...(c.status === 'EXPIRED' ? [{label: 'Remove record', onSelect: () => setDisconnectId(c.id)}] : []),
      ]} />} />
      {disconnectId === c.id && <div className="settings-stack"><p>{c.status === 'EXPIRED' ? 'Remove this expired record?' : `Disconnect ${name}?`}</p><ButtonGroup stack><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setDisconnectId(null)}>Cancel</button><button ref={disconnectButton} type="button" className="cfg-btn cfg-btn--danger" disabled={busy} onClick={() => void manage(c.id, c.status === 'EXPIRED' ? 'remove-expired' : 'disconnect')}>Confirm</button></ButtonGroup></div>}
      </div>;
    })}</Card>
    <button type="button" className="link-btn" disabled={busy || refreshing} onClick={() => void refresh()}>Refresh status</button>
  </div>;
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
      if (useStore.getState().user?.id === user.id) { setValue(previous); setError(`Couldn't save the time zone: ${(e as Error).message}`); }
    } finally { setBusy(false); }
  };
  return <>
    <SettingRow icon={Clock3} title="Time zone" >
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

  if (reauth.checking) return <><PageHead title="Your account" /><p role="status">Verifying your sign-in</p></>;
  if (reauth.pending) return <>
    <PageHead title="Delete your Swarm account?" />
    <ReauthPrompt accountEmail={user.email} reason={reauth.pending.reason} resume={{ section: 'account', accountId: user.id, action: 'login' }} retryLabel="Delete my account" terminalActive={false} onCancel={() => { reauth.cancel(); setDeleting(false); }} />
  </>;
  if (deleting) return <div className="account-delete">
    <div className="app-settings__head"><h1 ref={deleteHeading} tabIndex={-1}>Delete your Swarm account?</h1><p>This permanently removes your account, Bots and conversations. Apple access is revoked if linked.</p></div>
    {reauth.returned && <p role="status" className="access-section-note">You're signed in again. Nothing has been deleted.</p>}
    <div className="account-delete__warning"><strong>This can't be undone</strong><p>Deleting your account is different from signing out or clearing local data.</p></div>
    <SettingRow icon={CircleUserRound} title="Account to delete" sub={email} />
    <Section  title={<>Before you continue</>}><p>Cancel to keep your account and return to Account settings.</p>{error && <div className="cfg-error" role="alert">{error}</div>}<ButtonGroup stack ><button type="button" className="cfg-btn cfg-btn--danger" disabled={!!busy} onClick={() => void act('delete')}>{busy ? 'Deleting' : 'Delete my account'}</button><button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => { setDeleting(false); setError(null); }}>Cancel</button></ButtonGroup></Section>
  </div>;

  return <>
    {reauth.error && <p className="cfg-error" role="alert">{reauth.error}</p>}
    <Section><Card variant="list">
      <Row leading={<SettingIcon icon={CircleUserRound} />} title={user.name || 'Your account'} subtitle={email} trailing={<SettingsMenu disabled={!!busy} items={[
        { label: 'Sign out', onSelect: () => void act('signout') },
        { label: 'Delete account', danger: true, onSelect: () => { setError(null); setDeleting(true); } },
      ]} />} />
      <TimeZoneRow user={user} />
    </Card></Section>
    <details className="settings-disclosure"><summary>Sign-in methods</summary><Card variant="list">
      {(appleLogin || appleLinked) && <Row title="Apple" trailing={appleLinked ? <span className="cfg-chip">Connected</span> : <AppleSignIn link />} />}
      {(googleLogin || googleLinked) && <Row title="Google" trailing={googleLinked ? <span className="cfg-chip">Connected</span> : <AuthLink className="cfg-btn cfg-btn--secondary" href="/api/auth/google/start?intent=link">Connect</AuthLink>} />}
    </Card></details>
    <details className="settings-disclosure"><summary>Sessions</summary><AccountSessions accountId={user.id} /></details>
    {error && <p className="cfg-error" role="alert">{error}</p>}
  </>;
}
