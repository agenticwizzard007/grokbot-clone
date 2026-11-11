import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BadgeCheck, ChevronDown, CreditCard, LoaderCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { useModels, type ModelProvider } from '../lib/models';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import '@fontsource-variable/instrument-sans';
import '../styles/usage-mode.css';

function connectionName(provider: ModelProvider | null, plan: string | null) {
  const name = provider === 'claude-cli' ? 'Claude' : provider === 'codex-cli' ? 'ChatGPT' : provider === 'openrouter' ? 'OpenRouter' : 'Direct API';
  if (!plan || !provider?.endsWith('-cli')) return name;
  const label = plan.trim().replaceAll('_', ' ').replace(/\b[a-z]/g, c => c.toUpperCase());
  return label.toLowerCase().startsWith(name.toLowerCase()) ? label : `${name} ${label}`;
}

const dateLabel = (time: number) => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The selected billing connection, never inferred from a model name or a zero-dollar cost. */
export function UsageModeBubble() {
  const catalog = useModels();
  const userId = useStore(s => s.user?.id);
  const mobile = useStore(s => s.mobile);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ left: 12, bottom: 120, maxHeight: 400 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const loading = catalog.status === 'loading' || catalog.status === 'idle';
  const failed = !loading && (catalog.status === 'error' || !!catalog.error);
  const planMode = catalog.billing === 'plan';
  const known = catalog.billing !== null && catalog.provider !== null;
  const name = known ? connectionName(catalog.provider, catalog.plan) : '';
  const label = loading ? 'Checking usage…' : failed ? 'Check connection' : !known ? 'Choose a connection' : planMode ? 'Subscription' : 'API credits';
  const Icon = loading ? LoaderCircle : failed ? TriangleAlert : planMode ? BadgeCheck : CreditCard;
  const windows = catalog.usage?.available ? catalog.usage.windows.filter(w => Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100) : [];
  const { load } = catalog;

  useEffect(() => { setOpen(false); void load(); }, [userId, load]);
  useLayoutEffect(() => {
    if (!open || mobile) return;
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) setPlacement({ left: Math.max(12, Math.min(rect.left, innerWidth - 348)), bottom: innerHeight - rect.top + 6, maxHeight: Math.max(80, rect.top - 16) });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open, mobile]);

  useEffect(() => {
    if (!open) return;
    const returnTo = trigger.current;
    panel.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key !== 'Tab') return;
      const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? [])];
      const first = items[0], last = items.at(-1);
      if (!first || !last) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); returnTo?.focus({ preventScroll: true }); };
  }, [open, close]);

  const manage = () => { close(); useConfigUI.getState().openAppSettings(planMode || !known ? 'subscriptions' : 'keys'); };
  const refresh = () => { if (!loading) void load(true); };
  return <div className="usage-mode">
    <button ref={trigger} type="button" className={`usage-mode__trigger${!loading && !failed && planMode ? ' is-plan' : ''}${failed ? ' is-warning' : ''}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-label={`Usage mode: ${label}${!loading && !failed && name ? `, ${name}` : ''}. View details`}
      onClick={() => { if (open) close(); else { setOpen(true); refresh(); } }}>
      <span className="usage-mode__pill">
        <Icon size={16} strokeWidth={1.7} aria-hidden className={loading ? 'usage-mode__spinner' : undefined} />
        <span className="usage-mode__label">{label}</span>
        {!loading && !failed && name && <span className="usage-mode__name" title={name}>{name}</span>}
        <ChevronDown size={14} strokeWidth={1.7} aria-hidden />
      </span>
    </button>
    {open && createPortal(<div className={`usage-mode-layer${mobile ? ' is-mobile' : ''}`}>
      <div className="usage-mode__backdrop" aria-hidden onMouseDown={close} />
      <div ref={panel} id={id} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        className={`usage-mode__panel${planMode ? ' is-plan' : ''}`} style={mobile ? undefined : placement}>
        <button type="button" className="usage-mode__close" onClick={close} aria-label="Close usage details"><X size={18} aria-hidden /></button>
        <header className="usage-mode__heading">
          <span className="usage-mode__eyebrow">{loading ? 'Usage mode' : failed ? 'Connection needs attention' : planMode ? 'Subscription' : 'API credits'}</span>
          <h2 id={`${id}-title`}>{loading ? 'Checking your connection…' : failed ? 'Check your connection' : !known ? 'Choose how your Bots run' : planMode ? catalog.plan ? `Your ${name} plan` : `${name} subscription` : name}</h2>
          <p>{loading ? 'Getting the latest connection and usage information.' : failed ? 'We couldn’t verify this connection. Refresh or manage it to check its status.' : !known ? 'Connect a subscription or an API key in Settings.' : planMode ? 'Your Bots use this subscription connection. Provider limits and extra usage settings apply.' : 'Model requests use the connected API key and are billed by usage.'}</p>
        </header>
        {!loading && !failed && known && (planMode ? <div className="usage-mode__usage">
          {windows.length ? windows.map((w, i) => <div className="usage-mode__window" key={`${w.label}-${i}`}>
            <div className="usage-mode__window-title"><span>{w.label}</span><strong>{Number(w.usedPercent.toFixed(1))}% used</strong></div>
            <progress aria-label={w.label} max={100} value={w.usedPercent} />
            <span className="usage-mode__muted">{w.resetsAt !== null && Number.isFinite(w.resetsAt) ? `Resets ${dateLabel(w.resetsAt)}` : 'Reset time unavailable'}</span>
          </div>) : <p className="usage-mode__empty">Usage isn’t available from your provider right now. Check your provider account for current limits.</p>}
          {catalog.usage && Number.isFinite(catalog.usage.checkedAt) && <p className="usage-mode__muted">Checked {dateLabel(catalog.usage.checkedAt)} · Reported by {catalog.provider === 'claude-cli' ? 'Claude' : 'Codex'}</p>}
        </div> : <div className="usage-mode__api-note"><strong>Pay per use</strong><p>View recorded spending in Usage. Your provider manages key balances and budgets.</p></div>)}
        <p className="usage-mode__scope">Model usage only. Voice and other services have separate billing.</p>
        <footer className="usage-mode__actions">
          <button type="button" onClick={refresh} disabled={loading}><RefreshCw size={14} aria-hidden />{loading ? 'Checking…' : 'Refresh'}</button>
          {!loading && !failed && known && !planMode && <button type="button" onClick={() => { close(); useConfigUI.getState().openAppSettings('usage'); }}>View usage</button>}
          <button type="button" className="usage-mode__manage" onClick={manage} disabled={loading}>Manage connection <span aria-hidden>→</span></button>
        </footer>
      </div>
    </div>, document.body)}
  </div>;
}
