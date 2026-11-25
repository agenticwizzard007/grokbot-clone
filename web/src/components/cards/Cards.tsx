import { PreviewBody, plainBodyText } from './PreviewBody';
import { ConnectedAccountDetails, type DisplayAccount } from '../ConnectedAccountDetails';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { CardBody, Row } from '@shared/types';
import { api, openPopup } from '../../lib/api';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';
import { useRefocusOnResolve } from '../../lib/composerFocus';
import { useDisplayText } from '../../lib/useDisplayText';

// HTML parsing is loaded only for action cards, never on the initial chat path.
const ActionPreview = lazy(() => import('./ToolPreview').then(m => ({ default: m.ActionPreview })));

type Card<K extends CardBody['card']> = Extract<CardBody, { card: K }>;

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message || 'Something went wrong'); } finally { setBusy(null); }
  };
  return { busy, error, run };
}

const prettyTool = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const KNOWN: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', hubspot: 'HubSpot', linkedin: 'LinkedIn', youtube: 'YouTube', clickup: 'ClickUp', googledocs: 'Google Docs', googledrive: 'Google Drive', googlesheets: 'Google Sheets', googlecalendar: 'Google Calendar', googletasks: 'Google Tasks', googlemeet: 'Google Meet' };
/** "googlecalendar" → "Google Calendar", "slack" → "Slack". */
export const humanizeToolkit = (slug: string) => KNOWN[slug.toLowerCase()] ?? slug.replace(/^(google|microsoft)(?=\w)/i, '$1 ').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ---------------- approval ----------------

const APPROVAL_OUTCOME: Record<string, string> = { allowed: 'Allowed once', always: 'Always allowed', denied: 'Not allowed', expired: 'Expired' };

export function ApprovalCard({ body }: { body: Card<'approval'> }) {
  const { busy, error, run } = useBusy();
  const clean = useDisplayText();
  const pending = body.status === 'pending';
  const decide = (d: 'allow' | 'always' | 'deny') => run(d, () => api.approve(body.approvalId, d));
  const name = clean(body.toolkitName ?? (body.toolkit ? humanizeToolkit(body.toolkit) : prettyTool(clean(body.tool))));
  // Older persisted approvals stored their verified account label ahead of JSON.
  const accountLabel = body.accountLabel ?? body.detail?.match(/^Account: ([^\n]*)$/m)?.[1];
  const ref = useRef<HTMLDivElement>(null);
  useRefocusOnResolve(pending, ref);
  return (
    <div ref={ref} className={`card approval-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo slug={body.toolkit} name={name} size={44} />
        <div className="card__titles">
          <div className="card__title">{clean(body.title)}</div>
          <div className="card__sub">{name}</div>
        </div>
      </div>
      {accountLabel && <div className="card__body">Account: {accountLabel}</div>}
      <Suspense fallback={<div className="card__body" role="status">Loading preview…</div>}><ActionPreview tool={body.tool} args={body.args} /></Suspense>
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('deny')}>Don't allow</button>
            {body.tool !== 'update_profile:timezone' && <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('always')}>Always allow</button>}
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => decide('allow')}>Allow</button>
          </div>
          {error && <div className="card__error">{clean(error)}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'denied' || body.status === 'expired' ? 'close' : 'check'} size={12} opacity={0.7} />
          {APPROVAL_OUTCOME[body.status] ?? body.status}
        </div>
      )}
    </div>
  );
}

// ---------------- question ----------------

export function QuestionCard({ row, body }: { row: Row; body: Card<'question'> }) {
  const { busy, error, run } = useBusy();
  const clean = useDisplayText();
  const pending = body.status === 'pending';
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const ref = useRef<HTMLDivElement>(null);
  useRefocusOnResolve(pending, ref);
  return (
    <div ref={ref} className={`card question-card${pending ? '' : ' is-resolved'}`}>
      <div className="question-card__head">
        <div className="question-card__q">{clean(body.question)}</div>
        <div className="question-card__hint">{pending ? 'Pick an option or reply in your own words' : body.status === 'dismissed' ? 'Skipped' : 'Answered'}</div>
      </div>
      <div className="question-card__options">
        {body.options.map((opt, i) => {
          const chosen = body.answer === opt;
          return (
            <button
              key={i}
              type="button"
              className={`question-option${chosen ? ' is-chosen' : ''}`}
              disabled={!pending || !!busy}
              onClick={() => run(String(i), () => api.answer(row.botId, row.seq, opt))}
            >
              <span className="question-option__key">{letters[i] ?? i + 1}</span>
              <span className="question-option__label">{clean(opt)}</span>
              {chosen && <Icon name="check" size={12} opacity={0.6} style={{ marginLeft: 'auto', marginTop: 6 }} />}
            </button>
          );
        })}
      </div>
      {pending && (
        <div className="question-card__foot">
          <button type="button" className="link-btn" disabled={!!busy} onClick={() => run('dismiss', () => api.dismiss(row.botId, row.seq))}>Skip</button>
        </div>
      )}
      {error && <div className="card__error">{clean(error)}</div>}
    </div>
  );
}

// ---------------- connect ----------------

export function ConnectCard({ row, body }: { row: Row; body: Card<'connect'> }) {
  const { busy, error, run } = useBusy();
  const clean = useDisplayText();
  const [waiting, setWaiting] = useState(false);
  const connectionsVersion = useStore((s) => s.connectionsVersion);
  const pending = body.status === 'pending';
  const userId = useStore(s => s.user?.id);
  const [account, setAccount] = useState<DisplayAccount | null>(null);
  useEffect(() => {
    setAccount(null);
    if (!userId || !['connected', 'expired'].includes(body.status) || !body.connectedAccountId) return;
    const controller = new AbortController();
    void fetch('/api/apps/connections', { credentials: 'include', signal: controller.signal })
      .then(async r => { if (!r.ok) return; const data = await r.json();
        if (!controller.signal.aborted) setAccount(data.connections?.find((a: DisplayAccount) => a.id === body.connectedAccountId) ?? null);
      }).catch(() => {});
    return () => controller.abort();
  }, [userId, body.status, body.connectedAccountId, connectionsVersion]);

  // Leave the "waiting" state once the server reports a connection change or the card resolves.
  useEffect(() => { setWaiting(false); }, [connectionsVersion, body.status]);

  const connect = () => run('connect', async () => {
    const popup = openPopup('about:blank');
    try {
      const { redirectUrl } = await api.connect(body.toolkit, row.botId, row.seq);
      if (popup) popup.location.href = redirectUrl; else window.open(redirectUrl, '_blank');
      setWaiting(true);
    } catch (e) { popup?.close(); throw e; }
  });

  return (
    <div className={`card connect-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo slug={body.toolkit} name={clean(body.toolkitName)} logo={body.logo} size={44} />
        <div className="card__titles">
          <div className="card__title">{body.status === 'connected' ? '' : 'Connect '}{clean(body.toolkitName)}</div>
          {(body.status === 'connected' || body.status === 'expired' && body.connectedAccountId) && <ConnectedAccountDetails account={account ?? { id: body.connectedAccountId ?? 'unavailable', status: body.status === 'expired' ? 'EXPIRED' : 'ACTIVE', ...body.accountDetails }} />}
          <div className="card__sub">{clean(body.reason)}</div>
        </div>
      </div>
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('skip', () => api.dismiss(row.botId, row.seq))}>Skip</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={connect}>{waiting ? 'Waiting for sign-in…' : 'Connect'}</button>
          </div>
          {error && <div className="card__error">{clean(error)}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'connected' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'connected' ? `${clean(body.toolkitName)} connected` : body.status === 'expired' ? 'This connection request has expired. Connect again from Settings.' : 'Skipped'}
        </div>
      )}
    </div>
  );
}

// ---------------- draft (screen 02) ----------------

const CHANNEL_LABEL: Record<string, string> = { email: 'Email', slack: 'Slack', message: 'Chat' };

export function DraftCard({ row, body }: { row: Row; body: Card<'draft'> }) {
  const { busy, error, run } = useBusy();
  const clean = useDisplayText();
  // R2F-006: present_draft shows a draft the user sends themselves. Nothing is ever sent from this card:
  // Copy draft stays on this device, Discard dismisses the card row (never an approval).
  const approvalId: string | undefined = body.approvalId || undefined;
  const pending = body.status === 'pending';
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(body.subject ? `Subject: ${body.subject}\n\n${body.text}` : body.text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ } };
  const discard = () => run('discard', () => approvalId ? api.approve(approvalId, 'deny') : api.dismiss(row.botId, row.seq));
  const ref = useRef<HTMLDivElement>(null);
  useRefocusOnResolve(pending, ref);
  return (
    <div ref={ref} className={`card draft-card${pending ? '' : ' is-resolved'}`}>
      <div className="draft-card__head">
        <span className="draft-card__tile"><Icon name="chat_filled" size={18} color="#FFFFFF" /></span>
        <div className="draft-card__titles">
          <div className="draft-card__channel">{CHANNEL_LABEL[body.channel] ?? 'Message'}</div>
          <div className="draft-card__from">{body.status === 'sent' ? 'Sent' : 'Draft only. Nothing was sent.'}</div>
        </div>
      </div>
      <div className="draft-card__content">
        <div className="draft-card__to">
          <span className="draft-card__to-label">To</span>
          <span className="draft-card__to-avatar">{(body.to.trim()[0] ?? '?').toUpperCase()}</span>
          <span className="draft-card__to-name">{body.to}</span>
        </div>
        {body.subject && <div className="draft-card__subject">{body.subject}</div>}
        <PreviewBody text={plainBodyText(body.text)} className="draft-card__text" slack={body.channel === 'slack'} />
      </div>
      {pending ? (
        <div className="draft-card__actions">
          <button type="button" className="btn btn--secondary btn--grow" disabled={!!busy} onClick={discard}>{busy === 'discard' ? 'Discarding…' : 'Discard'}</button>
          <button type="button" className="btn btn--primary btn--grow" onClick={copy}>{copied ? 'Copied' : 'Copy draft'}</button>
        </div>
      ) : (
        <div className={`card__outcome is-${body.status}`} style={{ padding: '0 16px 16px' }}>
          <Icon name={body.status === 'sent' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'sent' ? 'Sent' : 'Discarded. Nothing was sent.'}
        </div>
      )}
      {error && <div className="card__error" style={{ padding: '0 16px 12px' }}>{clean(error)}</div>}
    </div>
  );
}

export function CardRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type !== 'card') return null;
  switch (b.card) {
    case 'approval': return <ApprovalCard body={b} />;
    case 'question': return <QuestionCard row={row} body={b} />;
    case 'connect': return <ConnectCard row={row} body={b} />;
    case 'draft': return <DraftCard row={row} body={b} />;
    default: return null;
  }
}
