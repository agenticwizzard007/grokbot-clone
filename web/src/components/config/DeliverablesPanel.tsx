import { ApiError } from '../../lib/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { deliverablesApi, type ArtifactDelivery, type DeliveryChannel, type SavedDeliverable } from '../../lib/deliverablesApi';
import { deliveryJournalKey, persistDeliveryAction, readDeliveryActions, resolveDeliveryAction, type DeliveryAction, type DeliveryDestination } from '../../lib/deliveryActions';
import { useStore } from '../../store';
import { relativeShort } from '../../lib/time';
import { formatBytes } from './ui';
import { SynopsesPanel } from './SynopsesPanel';
import { useWorkLifetime, workBotKey } from './workScope';
import './workArea.css';

const outcome = (delivery: ArtifactDelivery) => ({ delivered: delivery.channel === 'library' ? 'Saved in Library' : 'Acknowledged', failed: 'Not sent', unknown: 'Unverified outcome', sending: 'Sending', pending: 'Waiting to send' }[delivery.status] ?? delivery.status);
const latestAttempt = (delivery: ArtifactDelivery) => [...delivery.attempts].sort((first, second) => second.number - first.number)[0];
const channelName: Record<DeliveryChannel, string> = { library: 'Library', imessage: 'iMessage', sms: 'SMS', whatsapp: 'WhatsApp' };
function channelBlock(file: SavedDeliverable, channel: DeliveryChannel) {
  const deliveries = file.deliveries.filter(delivery => delivery.channel === channel);
  if (deliveries.some(delivery => delivery.status === 'unknown')) return `Verify the uncertain ${channelName[channel]} attempt before sending again on this channel.`;
  if (deliveries.some(delivery => delivery.status === 'pending' || delivery.status === 'sending')) return `A ${channelName[channel]} delivery is in progress. Refresh to check its status.`;
}
type Preview = { artifactId: string; destination: DeliveryDestination; retry?: { deliveryId: string; expectedAttemptId: string } };
export type DeliveryReviewHeading = { title: string; subtitle: string; detail: true };

export function DeliverablesPanel({ botId, workspace, onReview }: { botId: string; workspace?: boolean; onReview?: (heading?: DeliveryReviewHeading) => void }) {
  const userId = useStore(state => state.user?.id);
  const bot = useStore(state => state.bots.find(item => item.id === botId));
  if (!userId || !bot) return null;
  return <ReportList key={`${userId}:${workBotKey(bot)}`} botId={botId} generation={bot.generation} userId={userId} isPrimary={bot.isPrimary} workspace={workspace} onReview={onReview} />;
}

function ReportList({ botId, generation, userId, isPrimary, workspace, onReview }: { botId: string; generation: number; userId: string; isPrimary: boolean; workspace?: boolean; onReview?: (heading?: DeliveryReviewHeading) => void }) {
  const [files, setFiles] = useState<SavedDeliverable[] | null>(null), [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(''), [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<string | null>(null), [channels, setChannels] = useState<Record<string, DeliveryChannel>>({});
  const [preview, setPreview] = useState<Preview | null>(null), [pending, setPending] = useState<DeliveryAction[]>([]), [storageError, setStorageError] = useState('');
  const [verification, setVerification] = useState<{ artifactId: string; deliveryId: string }>();
  const [expanded, setExpanded] = useState<string[]>([]);
  const journal = deliveryJournalKey(userId, botId);
  const action = useRef(false), activeRead = useRef<AbortController>();
  const lifetime = useWorkLifetime();
  const current = useCallback(() => lifetime.current && useStore.getState().user?.id === userId && useStore.getState().bots.find(bot => bot.id === botId)?.generation === generation, [botId, generation, userId, lifetime]);
  const load = useCallback(async () => {
    if (!current()) return;
    const controller = new AbortController(); activeRead.current?.abort(); activeRead.current = controller;
    setLoading(true); setReadError('');
    try {
      const result = await deliverablesApi.list(botId, controller.signal);
      if (!controller.signal.aborted && current()) setFiles(result.artifacts.filter(file => file.botId === botId));
    } catch (err) { if (!controller.signal.aborted && current()) setReadError((err as Error).message); }
    finally { if (!controller.signal.aborted && current()) setLoading(false); }
  }, [botId, current]);
  const loadJournal = useCallback(() => {
    if (!current()) return;
    try { setPending(readDeliveryActions(journal)); setStorageError(''); }
    catch (err) { setStorageError((err as Error).message); }
  }, [current, journal]);
  useEffect(() => {
    loadJournal(); void load();
    const sync = (event: StorageEvent) => { if (event.key === journal) loadJournal(); };
    window.addEventListener('storage', sync);
    return () => { activeRead.current?.abort(); window.removeEventListener('storage', sync); };
  }, [load, loadJournal, journal]);
  const execute = async (request: DeliveryAction) => {
    if (action.current || storageError || !current()) return;
    action.current = true; setBusy(request.artifactId); setActionError('');
    try {
      persistDeliveryAction(journal, request);
      loadJournal();
      await deliverablesApi.execute(request);
      resolveDeliveryAction(journal, request.key);
      if (current()) { loadJournal(); setPreview(null); setVerification(undefined); await load(); }
    } catch (err) {
      const definitive = err instanceof ApiError && [400, 404, 409, 422].includes(err.status);
      if (definitive) {
        try { resolveDeliveryAction(journal, request.key); if (current()) { loadJournal(); setPreview(null); } }
        catch (storage) { if (current()) setStorageError((storage as Error).message); }
      }
      if (current()) {
        setPreview(null); setVerification(undefined); loadJournal();
        setActionError(`${(err as Error).message} ${definitive ? 'The server rejected this request. Refresh before reviewing a new destination.' : 'If an unresolved request is listed, resume it to reuse the approved body and send identity.'}`);
      }
    } finally { action.current = false; if (current()) setBusy(null); }
  };
  const inspect = async (file: SavedDeliverable, retry?: ArtifactDelivery) => {
    const channel = retry?.channel ?? channels[file.id] ?? 'library';
    if (action.current || !current() || channelBlock(file, channel)) return;
    action.current = true; setBusy(file.id); setPreview(null); setActionError('');
    try {
      const attempt = retry && latestAttempt(retry);
      if (retry && !attempt) throw new Error('No previous attempt is available. Refresh this report.');
      const result = retry ? await deliverablesApi.retryPreview(retry.id) : await deliverablesApi.preview(file.id, channel);
      if (!current()) return;
      if (result.destination.target.channel !== channel) throw new Error('The delivery preview does not match the requested channel.');
      if (result.destination.artifact_sha256 !== file.sha256) throw new Error('The file has changed since this list was loaded. Refresh before approving it.');
      setPreview({ artifactId: file.id, destination: result.destination, ...(retry && attempt ? { retry: { deliveryId: retry.id, expectedAttemptId: attempt.id } } : {}) });
    } catch (err) { if (current()) setActionError((err as Error).message); }
    finally { action.current = false; if (current()) setBusy(null); }
  };
  const confirm = (file: SavedDeliverable, approval: Preview) => {
    if (channelBlock(file, approval.destination.target.channel)) return;
    const base = { key: crypto.randomUUID(), artifactId: file.id, createdAt: Date.now() };
    void execute(approval.retry ? { ...base, kind: 'retry', deliveryId: approval.retry.deliveryId, body: { destination: approval.destination, expectedAttemptId: approval.retry.expectedAttemptId } } : { ...base, kind: 'send', body: { channel: approval.destination.target.channel, destination: approval.destination } });
  };
  const reviewFile = files?.find(item => item.id === (preview?.artifactId ?? verification?.artifactId));
  const uncertain = reviewFile?.deliveries.find(item => item.id === verification?.deliveryId && item.status === 'unknown');
  const reviewTitle = preview ? (preview.retry ? 'Confirm retry' : preview.destination.target.channel === 'library' ? 'Save in Library' : 'Confirm delivery') : uncertain ? 'Verify an uncertain outcome' : '';
  const reviewSubtitle = reviewFile ? `${reviewFile.filename} · Saved ${new Date(reviewFile.createdAt).toLocaleString()}` : '';
  useEffect(() => {
    onReview?.(reviewTitle && reviewSubtitle ? { title: reviewTitle, subtitle: reviewSubtitle, detail: true } : undefined);
    return () => onReview?.(undefined);
  }, [onReview, reviewTitle, reviewSubtitle]);
  const reviewDisabled = busy !== null || !!storageError || !!readError || loading || pending.some(request => request.artifactId === reviewFile?.id);
  const previewBlock = preview && reviewFile && channelBlock(reviewFile, preview.destination.target.channel);
  const cancelVerification = () => setVerification(undefined);
  return <>
    {isPrimary && !workspace && !reviewTitle && <SynopsesPanel onUpdated={() => void load()} />}
    <section aria-label="Saved reports" className="work-ui work-deliverables">
      {!workspace && <h2 className="work-title">Saved reports</h2>}
      {readError && <p className="work-error" role="alert">{files ? 'Could not refresh. Showing the last loaded reports. ' : ''}{readError}</p>}
      {actionError && <p className="work-error" role="alert">{actionError}</p>}
      {storageError && <p className="work-error" role="alert">Delivery paused on this device. {storageError}</p>}
      {reviewTitle && reviewFile && (preview || uncertain) ? <div className="work-delivery-review">
        {!workspace && <><h3 className="work-title">{reviewTitle}</h3><p className="work-meta">{reviewSubtitle}</p></>}
        {preview ? <>
          <div className="work-row"><h3>Approved destination</h3><p className="work-meta">{preview.destination.recipient} · {preview.destination.target.channel === 'library' ? 'Saves this version without sending it.' : `Delivery uses the bound ${channelName[preview.destination.target.channel]} connection.`}</p></div>
          <div className="work-delivery-callout"><h3>{preview.destination.target.channel === 'library' ? 'Confirm delivery to Library' : 'Confirm this exact version and recipient'}</h3><p>Review the saved version and recipient. If either changes, confirm the current details before proceeding.</p></div>
          <div className="work-row"><h3>Acknowledgement</h3><p className="work-meta">{preview.destination.target.channel === 'library' ? 'Saving records a receipt in Library.' : 'Provider acceptance does not mean the recipient read the report.'}</p></div>
          <details className="work-row"><summary>Delivery details</summary><dl><dt>Exact destination</dt><dd>{preview.destination.recipient}</dd><dt>File fingerprint</dt><dd><code>{preview.destination.artifact_sha256}</code></dd></dl></details>
          {previewBlock && <p className="work-meta" role="status">{previewBlock}</p>}
          <div className="work-actions is-stack"><button type="button" className="work-button is-primary" disabled={reviewDisabled || !!previewBlock} onClick={() => confirm(reviewFile, preview)}>Confirm {preview.retry ? 'retry' : 'delivery'}</button><button type="button" className="work-button" disabled={busy !== null} onClick={() => setPreview(null)}>Cancel</button></div>
        </> : uncertain && <UnknownDelivery key={uncertain.id} filename={reviewFile.filename} delivery={uncertain} disabled={reviewDisabled} onBack={cancelVerification} onReconcile={(result, evidence, attemptId) => void execute({ key: crypto.randomUUID(), artifactId: reviewFile.id, createdAt: Date.now(), kind: 'reconcile', deliveryId: uncertain.id, body: { outcome: result, evidence, expectedAttemptId: attemptId } })} />}
      </div> : <>
      {!!pending.length && <div className="work-row" role="status"><h3>Unresolved delivery requests</h3><p className="work-meta">Resuming reuses the approved destination, exact request and idempotency key.</p>{pending.map(request => <div className="work-row__body" key={request.key}><p className="work-meta">{request.kind} · {files?.find(file => file.id === request.artifactId)?.filename ?? 'Saved artifact'}</p><button type="button" className="work-button" disabled={busy !== null || !!storageError} onClick={() => void execute(request)}>Resume saved request</button></div>)}</div>}
      {!files && loading && <p role="status">Loading reports…</p>}
      {files?.length === 0 && <p className="work-meta">Reports saved by this bot appear here.</p>}
      {files?.map(file => {
        const unresolved = pending.some(request => request.artifactId === file.id);
        const disabled = busy !== null || unresolved || !!storageError || !!readError || loading;
        const history = expanded.includes(file.id);
        const unverified = file.deliveries.filter(delivery => delivery.status === 'unknown');
        const channel = channels[file.id] ?? 'library';
        const blocked = channelBlock(file, channel);
        return <article key={file.id} className="work-row">
          <div className="work-row__body"><div><h3>{file.filename}</h3><p className="work-meta">{formatBytes(file.size)} · Saved {relativeShort(file.createdAt)} · Download does not send this file.</p>
            {file.deliveries.map(delivery => <p key={delivery.id} className="work-meta">{channelName[delivery.channel]}: {outcome(delivery)}</p>)}
          </div><a href={file.downloadUrl} download={file.filename} className="work-button">Download report</a></div>
          <div className="work-form"><label className="work-field">Delivery destination for {file.filename}<select aria-label={`Delivery destination for ${file.filename}`} value={channel} disabled={busy !== null || loading} onChange={event => { const value = event.currentTarget.value as DeliveryChannel; setChannels(previous => ({ ...previous, [file.id]: value })); setPreview(null); }}>{Object.entries(channelName).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>Choose Library to save without sending.</small></label>
            {blocked && <p className="work-meta" role="status">{blocked}</p>}
            <div className="work-actions"><button type="button" className="work-button" disabled={disabled || !!blocked} onClick={() => void inspect(file)}>{busy === file.id ? 'Updating…' : 'Review delivery destination'}</button></div>
          </div>
          {!!file.deliveries.length && <div className="work-actions">
            {unverified.length === 1 && <button className="work-button" type="button" disabled={disabled} onClick={() => { setActionError(''); setVerification({ artifactId: file.id, deliveryId: unverified[0].id }); }}>Verify uncertain outcome</button>}
            <button className="work-button" type="button" aria-expanded={history} onClick={() => setExpanded(previous => history ? previous.filter(id => id !== file.id) : [...previous, file.id])}>Delivery attempts and verification</button>
          </div>}
          {history && file.deliveries.map(delivery => <div key={delivery.id} className="work-row">
            <h4>{channelName[delivery.channel]} · {outcome(delivery)}</h4>
            {delivery.status === 'failed' && <><p className="work-meta">{delivery.error}</p><button type="button" className="work-button" disabled={disabled || !!channelBlock(file, delivery.channel)} onClick={() => void inspect(file, delivery)}>Review retry destination</button></>}
            {delivery.status === 'unknown' && unverified.length > 1 && <button type="button" className="work-button" disabled={disabled} onClick={() => { setActionError(''); setVerification({ artifactId: file.id, deliveryId: delivery.id }); }}>Verify {channelName[delivery.channel]} outcome</button>}
            {delivery.attempts.map(attempt => <p className="work-meta" key={attempt.id}>Attempt {attempt.number}: {attempt.status} · {new Date(attempt.startedAt).toLocaleString()}{attempt.externalId ? ` · Provider reference ${attempt.externalId}` : ''}{attempt.error ? ` · ${attempt.error}` : ''}</p>)}
            {delivery.reconciliations?.map(record => <p className="work-meta" key={record.id}>Owner verification: {record.outcome} · {record.evidence}{record.createdAt ? ` · ${new Date(record.createdAt).toLocaleString()}` : ''}</p>)}
          </div>)}
        </article>;
      })}
      <div className="work-actions"><button type="button" className="work-button" disabled={loading || busy !== null} onClick={() => { setActionError(''); setPreview(null); loadJournal(); void load(); }}>Refresh</button></div>
      </>}
    </section>
  </>;
}

function UnknownDelivery({ filename, delivery, disabled, onBack, onReconcile }: { filename: string; delivery: ArtifactDelivery; disabled: boolean; onBack: () => void; onReconcile: (outcome: 'delivered' | 'not_sent', evidence: string, attemptId: string) => void }) {
  const [outcome, setOutcome] = useState<'' | 'delivered' | 'not_sent'>(''), [evidence, setEvidence] = useState('');
  const attempt = latestAttempt(delivery);
  return <form className="work-form work-verify-form" onSubmit={event => { event.preventDefault(); if (outcome && attempt && evidence.trim()) onReconcile(outcome, evidence.trim(), attempt.id); }}>
    <div className="work-delivery-callout is-warning"><h3>Do not resend yet</h3><p>The provider may already have accepted {filename}. Verification does not send anything.</p></div>
    <div className="work-row"><h3>Original attempt</h3><p className="work-meta">{channelName[delivery.channel]}{attempt ? ` · Attempt ${attempt.number} at ${new Date(attempt.startedAt).toLocaleString()}` : ' · No attempt details are available.'}</p></div>
    <label className="work-field">Verified outcome<select aria-label="Verified outcome" required value={outcome} disabled={disabled} onChange={event => setOutcome(event.currentTarget.value as typeof outcome)}><option value="">Choose after checking</option><option value="delivered">Acknowledged by provider or recipient</option><option value="not_sent">Confirmed not sent</option></select></label>
    <label className="work-field">Verification evidence<textarea required value={evidence} maxLength={4000} disabled={disabled} onChange={event => setEvidence(event.currentTarget.value)} placeholder="Provider reference or recipient confirmation" /></label>
    <div className="work-row"><h3>What happens next</h3><p className="work-meta">An acknowledgement is recorded in history. Confirmed not sent makes a new retry review available.</p></div>
    <div className="work-actions is-stack"><button className="work-button is-primary" type="submit" disabled={disabled || !outcome || !evidence.trim() || !attempt}>Record verification (does not send)</button><button type="button" className="work-button" onClick={onBack}>Back</button></div>
  </form>;
}
