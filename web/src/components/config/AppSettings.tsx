import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Toolkit } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type ComputerDetails, type KeysResponse, type KeyStatus, type Pairing } from '../../lib/configApi';
import { ModelPicker, refreshModels } from './ModelPicker';
import { relativeShort } from '../../lib/time';
import { useConfigUI, type AppSection, type Theme } from '../../configStore';
import { useStore } from '../../store';
import { computerStatusText } from '../DetailsPanel';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';
import { Glyph } from './glyphs';
import { ConfirmButton } from './ui';

const SECTIONS: { id: AppSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'keys', label: 'API keys' },
  { id: 'computer', label: 'Computer' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'apps', label: 'Connected apps' },
  { id: 'account', label: 'Account' },
];

/** Full-window settings page, opened from the account menu. */
export function AppSettings() {
  const section = useConfigUI((s) => s.appSettings);
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-root')) { e.preventDefault(); close(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);
  if (!section) return null;
  return createPortal(
    <div className="app-settings" role="dialog" aria-modal="true" aria-label="Settings">
      <aside className="app-settings__nav">
        <button type="button" className="app-settings__back" onClick={close}><Glyph name="arrow_left" size={14} /> Back to Bots</button>
        <div className="app-settings__heading">Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className={`cfg-nav__item${section === s.id ? ' is-active' : ''}`} onClick={() => open(s.id)} aria-current={section === s.id || undefined}>
            {s.label}
          </button>
        ))}
      </aside>
      <div className="app-settings__main">
        <button type="button" className="app-settings__close icon-btn" onClick={close} aria-label="Close settings" title="Close (Esc)"><Icon name="close" opacity={0.8} /></button>
        <div className="app-settings__page">
          {section === 'general' && <GeneralSection />}
          {section === 'keys' && <KeysSection />}
          {section === 'computer' && <ComputerSection />}
          {section === 'permissions' && <PermissionsSection />}
          {section === 'apps' && <AppsSection />}
          {section === 'account' && <AccountSection />}
        </div>
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

// ---------------------------------------------------------------------------

function ThemeTile({ value, label, current, onPick }: { value: Theme; label: string; current: Theme; onPick: (t: Theme) => void }) {
  return (
    <button type="button" role="radio" aria-checked={current === value} className={`theme-tile${current === value ? ' is-active' : ''}`} onClick={() => onPick(value)}>
      <span className={`theme-tile__art is-${value}`} aria-hidden>
        <span className="theme-tile__side" />
        <span className="theme-tile__pane"><i /><i /><b /></span>
      </span>
      <span className="theme-tile__label">{label}</span>
    </button>
  );
}

function GeneralSection() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
  return (
    <>
      <PageHead title="General" />
      <section className="cfg-section">
        <div className="cfg-section__label">Theme</div>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          <ThemeTile value="system" label="System" current={theme} onPick={setTheme} />
          <ThemeTile value="light" label="Light" current={theme} onPick={setTheme} />
          <ThemeTile value="dark" label="Dark" current={theme} onPick={setTheme} />
        </div>
        <div className="cfg-field__hint">System follows your device’s light or dark setting.</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// API keys: the server's provider keys, entered in the app and verified before saving.

const sourceText = (s: KeyStatus) => (s.source === 'app' ? 'saved in the app' : s.source === 'env' ? 'from the server’s .env file' : '');

function KeyCard({ name, title, what, link, status, canEdit, required, onChange }: {
  name: 'xai' | 'composio' | 'openrouter'; title: string; what: string; link: { href: string; label: string };
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
          <div className="cfg-row__sub">{what}{status.set ? ` Key ${status.hint}, ${sourceText(status)}.` : ''}</div>
        </div>
        {status.source === 'app' && canEdit && (
          <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Remove key" onConfirm={clear}>{busy === 'clear' ? 'Removing…' : 'Remove'}</ConfirmButton>
        )}
      </div>
      {canEdit ? (
        <form className="cfg-key__form" onSubmit={(e) => { e.preventDefault(); if (value.trim()) void save(); }}>
          <input className="text-input cfg-key__input" type="password" autoComplete="off" spellCheck={false} placeholder={status.set ? 'Paste a new key to replace it' : 'Paste your key'} value={value} onChange={(e) => setValue(e.target.value)} aria-label={`${title} API key`} />
          <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!value.trim() || !!busy}>{busy === 'save' ? 'Verifying…' : 'Save & verify'}</button>
        </form>
      ) : null}
      <div className="cfg-key__foot">
        {note ? <span className={note.tone === 'error' ? 'cfg-key__err' : 'cfg-key__ok'} role="status">{note.text}</span> : <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>}
      </div>
    </div>
  );
}

function KeysSection() {
  const [keys, setKeys] = useState<KeysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  useEffect(() => { configApi.keys().then(setKeys).catch((e) => setError((e as Error).message)); }, []);
  const changed = (r: KeysResponse) => { setKeys(r); refreshModels(); setPickerKey((n) => n + 1); };
  const save = async (name: 'provider' | 'model' | 'openrouter_model', value: string) => {
    setNote(null);
    try { changed(await configApi.saveKey(name, value)); setNote({ tone: 'ok', text: 'Saved. Bots use it from their next message.' }); }
    catch (e) { setNote({ tone: 'error', text: (e as Error).message }); }
  };

  if (error) return <><PageHead title="API keys" /><div className="cfg-error">{error}</div></>;
  if (!keys) return <><PageHead title="API keys" /><div className="cfg-empty cfg-empty--flat">Loading…</div></>;
  const provider = keys.provider.value;
  const hasModels = provider === 'openrouter' ? keys.openrouter.set : keys.xai.set;
  const current = provider === 'openrouter' ? keys.openrouterModel.value : keys.model.value;
  return (
    <>
      <PageHead title="API keys" sub="Grokbot runs on your own provider accounts. Keys are checked with the provider, stored encrypted on this server, and never shown again." />
      {!keys.canEdit && <div className="cfg-field__hint" style={{ marginBottom: 12 }}>Only the owner of this server can change its keys.</div>}

      <section className="cfg-section">
        <div className="cfg-section__label">Models</div>
        <div className="cfg-card cfg-key">
          <div className="cfg-key__form">
            <div className="cfg-row__text"><div className="cfg-row__title">Run Bots on</div><div className="cfg-row__sub">OpenRouter gives one key for Grok, Claude, GPT, Gemini and hundreds more.</div></div>
            <div className="cfg-seg" role="radiogroup" aria-label="Model provider">
              {(['openrouter', 'xai'] as const).map((p) => {
                const ok = p === 'openrouter' ? keys.openrouter.set : keys.xai.set;
                return (
                  <button key={p} type="button" role="radio" aria-checked={provider === p} className={provider === p ? 'is-active' : ''}
                    disabled={!keys.canEdit || (!ok && provider !== p)} title={ok ? '' : `Add ${p === 'openrouter' ? 'an OpenRouter' : 'an xAI'} key below first`}
                    onClick={() => { if (provider !== p) void save('provider', p); }}>
                    {p === 'openrouter' ? 'OpenRouter' : 'xAI direct'}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="cfg-key__form">
            <div className="cfg-row__text"><div className="cfg-row__title">Default model</div><div className="cfg-row__sub">Used by every Bot unless you pick one in its settings.</div></div>
            <ModelPicker key={`${provider}-${pickerKey}`} label="Default model" value={current} disabled={!keys.canEdit || !hasModels}
              onChange={(id) => { if (id && id !== current) void save(provider === 'openrouter' ? 'openrouter_model' : 'model', id); }} />
          </div>
          <div className="cfg-key__foot">
            {note ? <span className={note.tone === 'error' ? 'cfg-key__err' : 'cfg-key__ok'} role="status">{note.text}</span>
              : hasModels ? `Bots use ${current} through ${provider === 'openrouter' ? 'OpenRouter' : 'xAI'}.` : `Add ${provider === 'openrouter' ? 'an OpenRouter' : 'an OpenRouter or xAI'} key below to choose a model.`}
          </div>
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Keys</div>
        <KeyCard name="openrouter" title="OpenRouter" what="Recommended: one key for 290+ models that can use tools, with per-token pricing." link={{ href: 'https://openrouter.ai/keys', label: 'Get a key at openrouter.ai/keys' }} status={keys.openrouter} canEdit={keys.canEdit} onChange={changed} />
        <KeyCard name="xai" title="xAI · Grok direct" what="Grok straight from xAI. Also needed for voice calls." link={{ href: 'https://console.x.ai', label: 'Get a key at console.x.ai' }} status={keys.xai} canEdit={keys.canEdit} onChange={changed} />
        <KeyCard name="composio" title="Composio · Connected apps" what="Optional: lets Bots use Gmail, Slack, Notion, GitHub and 1,000+ apps, and enables Sign in with Google." link={{ href: 'https://platform.composio.dev', label: 'Get a key at platform.composio.dev' }} status={keys.composio} canEdit={keys.canEdit} onChange={changed} />
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
  useEffect(() => { load(); }, [load, computer?.status, computer?.screens.length]);

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
        <div className="cfg-section__label">Screens in use</div>
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
        <div className="cfg-field__hint">Reset closes every window on that Bot’s screen, so it starts clean next time. Up to 4 Bots can have a screen at once.</div>
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
  const paired = !!details?.pairing?.paired;
  const here = details?.thisComputer;
  const useHere = async () => {
    setBusy(true); setNote(null);
    try { await configApi.useThisComputer(); setPairing(null); reload(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  };
  const byId = new Map(bots.map((b) => [b.id, b]));

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
      <PageHead title="Computer" sub="Your Bots use a Chrome browser on your own PC. Each Bot gets its own browser profile there, separate from yours." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className={`computer-status-dot is-${connected ? 'on' : 'off'}`} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Your PC · {computerStatusText(computer)}</div>
              <div className="cfg-row__sub">
                {connected
                  ? `${computer?.device?.name ?? 'PC'}${computer?.device?.platform ? ` · ${computer.device.platform}` : ''} · Your Bots can browse now.`
                  : paired ? 'Paired, but the companion isn’t running. Start it again on your PC, or connect a new one.' : 'Connect a PC so your Bots can use a browser.'}
              </div>
            </div>
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
          </div>
          {pairing && !connected && (
            <div className="cfg-pair">
              <div className="cfg-pair__step">On your PC (needs <b>Node.js 22+</b> and <b>Google Chrome</b>), run this in a terminal and keep it running:</div>
              <div className="cfg-pair__cmd">
                <code className="cfg-pair__code" aria-label="Connect command">{pairing.command}</code>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <div className="cfg-field__hint">It contains a private token: anyone who has it can connect their PC as your Bots’ browser. Add <code className="cfg-code">--headed</code> to see the browser windows on your PC. Waiting for your PC to connect…</div>
            </div>
          )}
          {note && <div className="cfg-error cfg-error--inset">{note}</div>}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Browsers in use</div>
        <div className="cfg-card">
          {!details ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">{connected ? 'No Bot has opened a browser yet.' : 'None while your PC is disconnected.'}</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row">
                {bot ? <BotAvatarFor bot={bot} size={28} /> : <span className="cfg-row__ph" />}
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot?.name ?? 'Removed Bot'}</div>
                  <div className="cfg-row__sub">Browser · used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div>
                </div>
                <ConfirmButton
                  className="cfg-btn cfg-btn--secondary"
                  confirmLabel="Close browser"
                  disabled={!connected}
                  title="Closes this Bot’s browser on your PC. Its logins are kept."
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); reload(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Close
                </ConfirmButton>
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">Bots only get a browser on your PC: no files and no shell. Local-network addresses are blocked unless you start the companion with <code className="cfg-code">--allow-private-network</code>.</div>
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
  const load = useCallback(() => { configApi.policies().then((r) => setPolicies(r.policies)).catch(() => setPolicies([])); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHead title="Permissions" sub="Actions your Bots can take without asking first. Remove one and they’ll ask again next time." />
      <section className="cfg-section">
        <div className="cfg-card">
          {policies === null ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : policies.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">Nothing here yet. When you choose “Always allow” on an approval, it shows up here.</div>
          ) : policies.map((p) => {
            const h = humanizeTool(p.tool);
            return (
              <div key={p.tool} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{h.app}{h.action ? ` · ${h.action}` : ''}</div>
                  <div className="cfg-row__sub">{p.mode === 'always_allow' ? 'Always allowed' : p.mode === 'blocked' ? 'Never allowed' : 'Asks first'} · <code className="cfg-code">{p.tool}</code></div>
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
              <ToolkitLogo name={a.name} logo={a.logo} size={28} radius={7} />
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
  const [busy, setBusy] = useState(false);
  const initials = (user?.name ?? user?.email ?? '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <PageHead title="Account" />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className="account__initials">{initials}</span>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{user?.name}</div>
              <div className="cfg-row__sub">{user?.email}</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={async () => { setBusy(true); await configApi.logout().catch(() => {}); location.reload(); }}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
