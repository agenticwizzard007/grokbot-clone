import { useEffect, useState } from 'react';
import { Section, Card, Row } from '../components/layout';
import { FlowChart } from './FlowChart';
import { LinkSheet } from './LinkSheet';
import { useFlow } from './useFlow';
import { flowApi, flowLocation, openFlow } from './api';

export function FlowTab({ botId }: { botId: string }) {
  const { model, error, loading, disabled, reload } = useFlow(botId);
  const [link, setLink] = useState(flowLocation()?.link), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { const sync = () => setLink(flowLocation()?.link); window.addEventListener('swarm:flow-location', sync); return () => window.removeEventListener('swarm:flow-location', sync); }, []);
  const refresh = async () => { if (busy) return; setBusy(true); try { const result = await flowApi.refresh(botId); setMessage(result.accepted ? 'Refresh requested.' : 'A refresh was requested recently.'); } catch { setMessage('Refresh is unavailable. Try again later.'); } finally { setBusy(false); } };
  if (disabled) return null;
  return <div className="flow-tab">
    <Section title="Flow"><div className="flow-toolbar"><button type="button" onClick={() => void refresh()} disabled={busy}>{busy ? 'Requesting...' : 'Refresh flow'}</button><button type="button" onClick={() => openFlow(botId, 'new')}>Add handoff</button></div></Section>
    {message && <p role="status">{message}</p>}
    {loading && <Card><Row title="Loading flow..." /></Card>}
    {error && <Card><Row title={error} trailing={<button type="button" onClick={reload}>Retry</button>} /></Card>}
    {model && <><FlowChart model={model} />{model.warnings.map(w => <p className="flow-hint" key={w}>{w}</p>)}</>}
    {link && <LinkSheet botId={botId} linkId={link} sourceBotId={model?.lanes.flatMap(l => l.nodes).find(n => n.target.hash.endsWith(`?link=${encodeURIComponent(link)}`))?.target.focus?.replace(/^link-source:/, '')} onClose={() => openFlow(botId, undefined, true)} onSaved={reload} />}
  </div>;
}
export default FlowTab;
