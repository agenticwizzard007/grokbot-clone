import { ApiError } from '../../lib/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { deliverablesApi, type ArtifactDelivery, type DeliveryChannel, type SavedDeliverable } from '../../lib/deliverablesApi';
import { deliveryJournalKey, persistDeliveryAction, readDeliveryActions, resolveDeliveryAction, type DeliveryAction, type DeliveryDestination } from '../../lib/deliveryActions';
import { useStore } from '../../store';
import { relativeShort } from '../../lib/time';
import { formatBytes } from './ui';
import './native-learning.css';

const outcome = (delivery: ArtifactDelivery) => ({ delivered: delivery.channel === 'library' ? 'Saved in Library' : 'Acknowledged', failed: 'Not sent', unknown: 'Unverified outcome', sending: 'Sending', pending: 'Waiting to send' }[delivery.status] ?? delivery.status);
const latestAttempt = (d: ArtifactDelivery) => [...d.attempts].sort((a, b) => b.number - a.number)[0];
type Preview = { artifactId: string; destination: DeliveryDestination; retry?: { deliveryId: string; expectedAttemptId: string } };

/** Immutable reports with destination approval, stable sends and explicit verification. */
export function DeliverablesPanel({ botId }: { botId: string }) {
  const [files, setFiles] = useState<SavedDeliverable[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [channels, setChannels] = useState<Record<string, DeliveryChannel>>({});
  const [preview, setPreview] = useState<Preview | null>(null), [pending, setPending] = useState<DeliveryAction[]>([]), [storageError, setStorageError] = useState('');
  const userId = useStore(s => s.user?.id), journal = deliveryJournalKey(userId ?? 'signed-out', botId);
  const currentBot = useRef(botId), action = useRef(false);
  currentBot.current = botId;
  const load = useCallback(async () => {
    setLoading(true);
    try { const result = await deliverablesApi.list(botId); if (currentBot.current === botId) setFiles(result.artifacts); }
    catch (e) { if (currentBot.current === botId) setError((e as Error).message); }
    finally { if (currentBot.current === botId) setLoading(false); }
  }, [botId]);
  useEffect(() => { setFiles([]); setChannels({}); setPreview(null); setError(null); setStorageError(''); setPending([]); try { setPending(readDeliveryActions(journal)); } catch (e) { setStorageError((e as Error).message); } void load(); }, [load, journal]);
  const execute = async (request: DeliveryAction) => {
    if (action.current || storageError || !userId) return;
    action.current = true; setBusy(request.artifactId); setError(null);
    try {
      persistDeliveryAction(journal, request);
      if (currentBot.current === botId) setPending(readDeliveryActions(journal));
      await deliverablesApi.execute(request);
      resolveDeliveryAction(journal, request.key);
      if (currentBot.current === botId) { setPending(readDeliveryActions(journal)); setPreview(null); await load(); }
    } catch (e) {
      const definitive = e instanceof ApiError && [400, 404, 409, 422].includes(e.status);
      if (definitive) {
        try { resolveDeliveryAction(journal, request.key); if (currentBot.current === botId) { setPending(readDeliveryActions(journal)); setPreview(null); } }
        catch (storage) { if (currentBot.current === botId) setStorageError((storage as Error).message); }
      }
      if (currentBot.current === botId) setError(`${(e as Error).message} ${definitive ? 'The server rejected this request. Review the current state and approve a fresh destination if needed.' : 'The saved request retains its approved body and send identity. Resume it to resolve the outcome.'}`);
    }
    finally { action.current = false; if (currentBot.current === botId) setBusy(null); }
  };
  const inspect = async (file: SavedDeliverable, retry?: ArtifactDelivery) => {
    if (action.current) return;
    action.current = true; setBusy(file.id); setPreview(null); setError(null);
    try {
      const result = retry ? await deliverablesApi.retryPreview(retry.id) : await deliverablesApi.preview(file.id, channels[file.id] ?? 'library');
      const attempt = retry ? latestAttempt(retry) : null;
      if (retry && !attempt) throw new Error('No previous attempt is available. Refresh this report.');
      if (currentBot.current === botId) setPreview({ artifactId: file.id, destination: result.destination, ...(retry && attempt ? { retry: { deliveryId: retry.id, expectedAttemptId: attempt.id } } : {}) });
    } catch (e) { if (currentBot.current === botId) setError((e as Error).message); }
    finally { action.current = false; if (currentBot.current === botId) setBusy(null); }
  };
  return <section aria-label="Saved reports">
    <div className="section-label section-label--row"><span>Saved reports</span><button type="button" className="link-btn link-btn--small" disabled={loading} onClick={() => { setError(null); void load(); }}>Refresh</button></div>
    {error && <p className="lib-err" role="alert">{error}</p>}{storageError && <p className="lib-err" role="alert">{storageError}</p>}
    {!!pending.length && <div className="panel-card" role="status"><p>Unresolved delivery requests</p><p className="panel-row__meta">Resuming reuses the saved destination, exact request and idempotency key. It does not create a new send identity.</p>{pending.map(p => <div className="panel-row" key={p.key}><span>{p.kind} · {files.find(f => f.id === p.artifactId)?.filename ?? 'Saved artifact'}</span><button type="button" className="link-btn link-btn--small" disabled={busy !== null || !!storageError} onClick={() => void execute(p)}>Resume saved request</button></div>)}</div>}
    <div className="panel-card">
      {!files.length && <div className="panel-empty">{loading ? 'Loading reports…' : 'Reports saved by this Bot appear here.'}</div>}
      {files.map(file => {
        const unresolved = pending.some(p => p.artifactId === file.id), disabled = busy !== null || unresolved || !!storageError || !userId;
        const approval = preview?.artifactId === file.id ? preview : null;
        return <div key={file.id} className="panel-row" style={{ display: 'block' }}>
          <a href={file.downloadUrl} download={file.filename} className="panel-row__title">{file.filename}</a><div className="panel-row__meta">{formatBytes(file.size)} · {relativeShort(file.createdAt)} · Saved in Library</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <select aria-label={`Delivery destination for ${file.filename}`} value={channels[file.id] ?? 'library'} disabled={disabled} onChange={e => { setChannels(old => ({ ...old, [file.id]: e.target.value as DeliveryChannel })); setPreview(null); }}><option value="library">Library</option><option value="imessage">iMessage</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></select>
            <button type="button" className="link-btn link-btn--small" disabled={disabled} onClick={() => void inspect(file)}>{busy === file.id ? 'Updating…' : 'Review delivery destination'}</button>
          </div>
          {approval && <div className="cfg-editor"><strong>Confirm {approval.retry ? 'retry' : 'delivery'} to {approval.destination.recipient}</strong><div className="panel-row__meta">{approval.destination.target.channel} · Immutable file {approval.destination.artifact_sha256.slice(0, 12)}…</div><p className="panel-row__meta">Acknowledgement records provider acceptance; it does not prove the recipient read the report.</p><div className="cfg-editor__actions"><button type="button" className="cfg-btn cfg-btn--secondary" disabled={disabled} onClick={() => setPreview(null)}>Cancel</button><button type="button" className="cfg-btn cfg-btn--primary" disabled={disabled} onClick={() => void execute({ key: crypto.randomUUID(), artifactId: file.id, createdAt: Date.now(), ...(approval.retry ? { kind: 'retry' as const, deliveryId: approval.retry.deliveryId, body: { destination: approval.destination, expectedAttemptId: approval.retry.expectedAttemptId } } : { kind: 'send' as const, body: { channel: approval.destination.target.channel, destination: approval.destination } }) })}>Confirm {approval.retry ? 'retry' : 'delivery'}</button></div></div>}
          {file.deliveries.map(delivery => <div key={delivery.id} className="panel-row__meta" style={{ marginTop: 8 }}>
            <span>{delivery.channel === 'library' ? 'Library' : delivery.channel === 'imessage' ? 'iMessage' : delivery.channel.toUpperCase()}: {outcome(delivery)}</span>
            {delivery.status === 'failed' && <button type="button" className="link-btn link-btn--small" style={{ marginLeft: 8 }} disabled={disabled} onClick={() => void inspect(file, delivery)}>Review retry destination</button>}
            {delivery.status === 'unknown' && <UnknownDelivery delivery={delivery} disabled={disabled} onReconcile={(result, evidence, attemptId) => void execute({ key: crypto.randomUUID(), artifactId: file.id, createdAt: Date.now(), kind: 'reconcile', deliveryId: delivery.id, body: { outcome: result, evidence, expectedAttemptId: attemptId } })} />}
            {delivery.status === 'failed' && delivery.error && <div>{delivery.error}</div>}
            <details><summary>Delivery attempts and verification</summary>{delivery.attempts.map(a => <div key={a.id}>Attempt {a.number}: {a.status} · {new Date(a.startedAt).toLocaleString()}{a.externalId ? ` · Provider reference ${a.externalId}` : ''}{a.error ? ` · ${a.error}` : ''}</div>)}{(delivery as ArtifactDelivery & { reconciliations?: { id: string; outcome: string; evidence: string; createdAt: number }[] }).reconciliations?.map(r => <div key={r.id}>Owner verification: {r.outcome} · {r.evidence} · {new Date(r.createdAt).toLocaleString()}</div>)}</details>
          </div>)}
        </div>;
      })}
    </div>
  </section>;
}
function UnknownDelivery({ delivery, disabled, onReconcile }: { delivery: ArtifactDelivery; disabled: boolean; onReconcile: (outcome: 'delivered' | 'not_sent', evidence: string, attemptId: string) => void }) {
  const [outcome, setOutcome] = useState<'' | 'delivered' | 'not_sent'>(''), [evidence, setEvidence] = useState('');
  const attempt = latestAttempt(delivery);
  return <details><summary>Verify uncertain outcome</summary><p>The send may have completed. Check provider or recipient evidence before recording an outcome. This action does not send anything.</p><form className="delivery-verification" onSubmit={e => { e.preventDefault(); if (outcome && attempt) onReconcile(outcome, evidence.trim(), attempt.id); }}><label>Verified outcome<select aria-label="Verified outcome" required value={outcome} disabled={disabled} onChange={e => setOutcome(e.currentTarget.value as typeof outcome)}><option value="">Choose after checking</option><option value="delivered">Acknowledged by provider or recipient</option><option value="not_sent">Confirmed not sent</option></select></label><label>Verification evidence<textarea required value={evidence} disabled={disabled} onChange={e => setEvidence(e.currentTarget.value)} placeholder="Provider reference or recipient confirmation" /></label><button className="link-btn link-btn--small" type="submit" disabled={disabled || !outcome || !evidence.trim() || !attempt}>Record verification (does not send)</button></form></details>;
}
