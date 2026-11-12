import { useCallback, useEffect, useRef, useState } from 'react';
import { deliverablesApi, type DeliveryChannel, type SavedDeliverable } from '../../lib/deliverablesApi';
import { relativeShort } from '../../lib/time';
import { formatBytes } from './ui';

const outcome = (status: string) => ({ delivered: 'Delivered', failed: 'Not sent', unknown: 'Needs verification', sending: 'Sending', pending: 'Waiting to send' }[status] ?? status);

/** Immutable, server-backed reports remain available when the Bot's computer is asleep. */
export function DeliverablesPanel({ botId }: { botId: string }) {
  const [files, setFiles] = useState<SavedDeliverable[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [channels, setChannels] = useState<Record<string, DeliveryChannel>>({});
  const currentBot = useRef(botId), action = useRef(false);
  currentBot.current = botId;
  const load = useCallback(async () => {
    setLoading(true);
    try { const result = await deliverablesApi.list(botId); if (currentBot.current === botId) { setFiles(result.artifacts); setError(null); } }
    catch (e) { if (currentBot.current === botId) setError((e as Error).message); }
    finally { if (currentBot.current === botId) setLoading(false); }
  }, [botId]);
  useEffect(() => { setFiles([]); setChannels({}); setError(null); void load(); }, [load]);

  const send = async (file: SavedDeliverable, retryId?: string) => {
    if (action.current) return;
    action.current = true; setBusy(file.id); setError(null);
    try {
      if (retryId) await deliverablesApi.retry(retryId);
      else await deliverablesApi.deliver(file.id, channels[file.id] ?? 'library', crypto.randomUUID());
      if (currentBot.current === botId) await load();
    } catch (e) { if (currentBot.current === botId) setError((e as Error).message); }
    finally { action.current = false; if (currentBot.current === botId) setBusy(null); }
  };

  return <section aria-label="Saved reports">
    <div className="section-label section-label--row"><span>Saved reports</span>
      <button type="button" className="link-btn link-btn--small" disabled={loading} onClick={() => void load()}>Refresh</button>
    </div>
    {error && <p className="lib-err" role="alert">{error}</p>}
    <div className="panel-card">
      {!files.length && <div className="panel-empty">{loading ? 'Loading reports…' : 'Reports saved by this Bot appear here.'}</div>}
      {files.map((file) => <div key={file.id} className="panel-row" style={{ display: 'block' }}>
        <a href={file.downloadUrl} download={file.filename} className="panel-row__title">{file.filename}</a>
        <div className="panel-row__meta">{formatBytes(file.size)} · {relativeShort(file.createdAt)} · Saved in Library</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <select aria-label={`Delivery destination for ${file.filename}`} value={channels[file.id] ?? 'library'}
            disabled={busy !== null} onChange={(e) => setChannels((old) => ({ ...old, [file.id]: e.target.value as DeliveryChannel }))}>
            <option value="library">Library</option><option value="imessage">iMessage</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option>
          </select>
          <button type="button" className="link-btn link-btn--small" disabled={busy !== null} onClick={() => void send(file)}>
            {busy === file.id ? 'Sending…' : 'Deliver saved report'}
          </button>
        </div>
        {file.deliveries.map((delivery) => <div key={delivery.id} className="panel-row__meta" style={{ marginTop: 8 }}>
          <span>{delivery.channel === 'library' ? 'Library' : delivery.channel === 'imessage' ? 'iMessage' : delivery.channel.toUpperCase()}: {outcome(delivery.status)}</span>
          {delivery.status === 'failed' && <button type="button" className="link-btn link-btn--small" style={{ marginLeft: 8 }} disabled={busy !== null} onClick={() => void send(file, delivery.id)}>Retry delivery</button>}
          {delivery.status === 'unknown' && <div>The send may have completed. Verify with the recipient before taking further action.</div>}
          {delivery.status === 'failed' && delivery.error && <div>{delivery.error}</div>}
        </div>)}
      </div>)}
    </div>
  </section>;
}
