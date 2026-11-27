import { useEffect, useRef, useState } from 'react';
import type { HandoffLink } from '@shared/handoffs/contracts';
import { useStore } from '../store';
import { Modal } from '../components/modals/Modal';
import { Page, Section, Card, Row, ButtonGroup } from '../components/layout';
import { flowApi, type LinkInput } from './api';

const toInput = (link: HandoffLink): LinkInput => ({ toBotId: link.toBotId, mode: link.mode, trigger: link.trigger, template: link.template, autoApproveLoops: link.autoApproveLoops });
export function LinkSheet({ botId, linkId, sourceBotId, onClose, onSaved }: { botId: string; linkId: string; sourceBotId?: string; onClose: () => void; onSaved: () => void }) {
  const bots = useStore(s => s.bots), account = useStore(s => s.user?.id);
  const [links, setLinks] = useState<HandoffLink[]>([]), [owner, setOwner] = useState(botId), [selected, setSelected] = useState(linkId);
  const [target, setTarget] = useState(''), [mode, setMode] = useState<LinkInput['mode']>('suggest'), [trigger, setTrigger] = useState<LinkInput['trigger']>('any_run'), [template, setTemplate] = useState(''), [approve, setApprove] = useState(false);
  const [loaded, setLoaded] = useState(false), [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const writing = useRef(false), mounted = useRef(true);
  const current = () => mounted.current && useStore.getState().user?.id === account;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setLoading(true); setLoaded(false); setSelected(linkId); setError('');
    flowApi.links(sourceBotId ?? botId).then(async result => {
      const incoming = result.links.find(l => l.id === linkId && l.fromBotId !== botId);
      const source = incoming?.fromBotId ?? sourceBotId ?? botId;
      const ownLinks = incoming ? (await flowApi.links(source)).links : result.links;
      if (active && current()) { setLoaded(true); setOwner(source); setLinks(ownLinks.filter(l => l.fromBotId === source)); }
    }).catch(e => { if (active && current()) setError(e.message); }).finally(() => { if (active && current()) setLoading(false); });
    return () => { active = false; };
  }, [botId, linkId, sourceBotId, account, attempt]);
  useEffect(() => { const link = links.find(l => l.id === selected); setTarget(link?.toBotId ?? ''); setMode(link?.mode ?? 'suggest'); setTrigger(link?.trigger ?? 'any_run'); setTemplate(link?.template ?? ''); setApprove(link?.autoApproveLoops ?? false); }, [selected, links]);
  const existing = links.find(l => l.id === selected), full = !existing && links.length >= 5;
  const choices = bots.filter(b => b.id !== owner && b.kind !== 'room' && (!b.onboarding || b.onboarding.status === 'active') && (!links.some(l => l.toBotId === b.id && l.id !== selected)));
  const save = async (remove = false) => {
    if (!loaded || writing.current || !current() || (!remove && (!target || full))) return;
    writing.current = true; setBusy(true); setError('');
    const next = links.filter(l => l.id !== selected).map(toInput);
    if (!remove) next.push({ toBotId: target, mode, trigger, template, autoApproveLoops: approve });
    try { await flowApi.saveLinks(owner, next); if (current()) { onSaved(); onClose(); } }
    catch (e) { if (current()) setError(e instanceof Error ? e.message : 'Could not save the handoff.'); }
    finally { writing.current = false; if (current()) setBusy(false); }
  };
  return <Modal className="flow-sheet" label="Handoff links" onClose={() => { if (!busy) onClose(); }}><Page title="Handoff links">
    <Section title={`From ${bots.find(b => b.id === owner)?.name ?? 'this agent'}`}>
      {loading ? <Card><Row title="Loading links..." /></Card> : !loaded ? <Card><Row title="Could not load links" trailing={<button type="button" onClick={() => setAttempt(n => n + 1)}>Retry</button>} /></Card> : <>
        {!!links.length && <Card>{links.map(link => <Row key={link.id} title={bots.find(b => b.id === link.toBotId)?.name ?? 'Agent'} subtitle={link.mode === 'auto' ? 'Auto' : link.mode === 'off' ? 'Off' : 'Suggest'} trailing={<button type="button" aria-label={`Edit handoff to ${bots.find(b => b.id === link.toBotId)?.name ?? 'agent'}`} onClick={() => setSelected(link.id)}>Edit</button>} />)}</Card>}
        <form onSubmit={e => { e.preventDefault(); void save(); }}>
          <label>Agent<select aria-label="Agent" value={target} onChange={e => setTarget(e.target.value)} required disabled={busy || full}><option value="">Choose an agent</option>{choices.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
          <label>Mode<select aria-label="Mode" value={mode} onChange={e => setMode(e.target.value as LinkInput['mode'])} disabled={busy}><option value="suggest">Suggest</option><option value="auto">Auto</option><option value="off">Off</option></select></label>
          <label>When<select aria-label="When" value={trigger} onChange={e => setTrigger(e.target.value as LinkInput['trigger'])} disabled={busy}><option value="any_run">Any finished run</option><option value="task_done">Task completed</option>{trigger.startsWith('routine:') && <option value={trigger}>Selected routine</option>}</select></label>
          <label>Instruction<textarea maxLength={500} value={template} onChange={e => setTemplate(e.target.value)} placeholder="Review {title} and suggest improvements" rows={3} disabled={busy} /></label>
          <label className="flow-check"><input type="checkbox" checked={approve} onChange={e => setApprove(e.target.checked)} disabled={busy} />Auto approve loops for this pair</label>
          {full && <p role="status">Five links maximum. Edit or remove a link to add another.</p>}
          <ButtonGroup><button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || full || !target}>{busy ? 'Saving...' : existing ? 'Save link' : 'Add link'}</button>{existing && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void save(true)} disabled={busy}>Remove link</button>}</ButtonGroup>
          {existing && links.length < 5 && <button type="button" onClick={() => setSelected('new')} disabled={busy}>Add another link</button>}
        </form>
      </>}
      {error && <p role="alert">{error}</p>}
    </Section>
  </Page></Modal>;
}
