import { useRef, useState } from 'react';
import { ButtonGroup, Card, Row, Section } from '../components/layout';
import { handoffApi, linkInput, type HandoffLink, type HandoffSettings } from './api';
import { HandoffRow, HandoffState } from './HandoffRow';
import { errorText, handoffText, refreshHandoffs, useHandoffResource } from './useHandoffs';
import './handoffs.css';

/** Embeddable Activity section; its host owns Page and Back. Each page contains 20 rows. */
export function HandoffList({ botId }: { botId: string }) {
  const [direction, setDirection] = useState<'all' | 'sent' | 'received'>('all');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const after = cursors[cursors.length - 1];
  const resource = useHandoffResource(`list:${botId}:${direction}:${after ?? ''}`, signal => handoffApi.list({ botId, direction: direction === 'all' ? undefined : direction, after, limit: 20 }, signal));
  const agents = useHandoffResource('list-agents', signal => handoffApi.agents(signal));
  const name = (id: string) => agents.data?.bots.find(bot => bot.id === id)?.name ?? 'Agent';
  return <Section className="ho" title="Handoffs">
    <ButtonGroup role="group" aria-label="Handoff direction">
      {(['all', 'sent', 'received'] as const).map(value => <button key={value} className={`ho-button${value === direction ? ' is-selected' : ''}`} aria-pressed={value === direction} onClick={() => { setDirection(value); setCursors([undefined]); }}>{value === 'all' ? 'All' : value === 'sent' ? 'Sent' : 'Received'}</button>)}
    </ButtonGroup>
    <Card variant="list"><HandoffState loading={!resource.data && resource.loading} error={resource.error} retry={resource.retry} empty={resource.data?.handoffs.length === 0 ? 'No handoffs yet' : undefined} />
      {resource.data?.handoffs.map(handoff => {
        const sent = handoff.fromBotId === botId;
        const otherBotId = sent ? handoff.toBotId : handoff.fromBotId;
        return <HandoffRow key={handoff.id} otherBotName={name(otherBotId)} body={{ handoffId: handoff.id, direction: sent ? 'sent' : 'received', otherBotId, status: handoff.status, title: handoff.instruction, loopId: handoff.loopId ?? undefined, iteration: handoff.iteration ?? undefined }} />;
      })}
    </Card>
    {(cursors.length > 1 || resource.data?.next) && <ButtonGroup>
      <button className="ho-button" disabled={cursors.length === 1 || resource.loading} onClick={() => setCursors(values => values.slice(0, -1))}>Previous</button>
      <button className="ho-button" disabled={!resource.data?.next || resource.loading} onClick={() => setCursors(values => [...values, resource.data!.next!])}>Next</button>
    </ButtonGroup>}
  </Section>;
}

/** Exported here to stay within HO-D's exclusive files. HO-I mounts in Settings, Agents. */
export function HandoffSettingsControls({ botId }: { botId?: string } = {}) {
  const [selectedBotId, setSelectedBotId] = useState('');
  const resource = useHandoffResource(`settings:${botId ?? selectedBotId}`, async signal => {
    const [policy, agents] = await Promise.all([handoffApi.settings(signal), handoffApi.agents(signal)]);
    const senders = agents.bots.filter(bot => bot.kind !== 'room' && !bot.hidden);
    const senderId = botId || selectedBotId || senders[0]?.id;
    const links = senderId ? (await handoffApi.links(senderId, signal)).links : [];
    return { settings: policy.settings, links, agents: agents.bots, senders, senderId };
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const lock = useRef(false);
  async function save(change: { settings: HandoffSettings } | { link: HandoffLink; patch: Partial<HandoffLink> }) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); setSaved(false);
    try {
      if ('settings' in change) await handoffApi.saveSettings(change.settings);
      else {
        if (!resource.data?.senderId) return;
        const senderId = resource.data.senderId;
        const current = (await handoffApi.links(senderId)).links;
        await handoffApi.saveLinks(senderId, current.map(link => linkInput(link.id === change.link.id ? { ...link, ...change.patch } : link)));
      }
      setSaved(true); refreshHandoffs();
    } catch (reason) { setError(errorText(reason)); }
    finally { lock.current = false; setBusy(false); }
  }
  const data = resource.data;
  const disabled = busy || resource.loading;
  return <div className="ho ho-settings">
    <HandoffState loading={!data && resource.loading} error={resource.error} retry={resource.retry} />
    {data && <>
      <Section title="Agent policy"><Card variant="list">
        <Row title={<label className="ho-check"><input type="checkbox" checked={data.settings.enabled} disabled={disabled} onChange={event => void save({ settings: { ...data.settings, enabled: event.target.checked } })} />Enable handoffs</label>} />
        <Row title={<label className="ho-field">Agents can send to<select value={data.settings.agentHandoffs} disabled={disabled} onChange={event => void save({ settings: { ...data.settings, agentHandoffs: event.target.value as HandoffSettings['agentHandoffs'] } })}>
          <option value="team">Any agent on my team</option><option value="links_only">Linked agents only</option><option value="off">No agents</option>
        </select></label>} subtitle="20 per agent per hour, 100 per day" />
      </Card></Section>
      <Section title="Standing links">
        {!botId && data.senders.length > 0 && <label className="ho-field">Links from<select value={data.senderId} disabled={disabled} onChange={event => setSelectedBotId(event.target.value)}>{data.senders.map(bot => <option key={bot.id} value={bot.id}>{handoffText(bot.name)}</option>)}</select></label>}
        <Card variant="list">
        {!data.links.length && <HandoffState empty="No links yet" />}
        {data.links.map(link => {
          const name = handoffText(data.agents.find(bot => bot.id === link.toBotId)?.name ?? 'Agent');
          return <Row key={link.id} title={name}>
            <label className="ho-field">Mode for {name}<select disabled={disabled} value={link.mode} onChange={event => void save({ link, patch: { mode: event.target.value as HandoffLink['mode'] } })}><option value="off">Off</option><option value="suggest">Suggest</option><option value="auto">Auto</option></select></label>
            <label className="ho-check"><input type="checkbox" disabled={disabled} checked={link.autoApproveLoops} onChange={event => void save({ link, patch: { autoApproveLoops: event.target.checked } })} />Auto approve loops started by agents with {name}</label>
          </Row>;
        })}
      </Card></Section>
    </>}
    {error && <p className="ho-error" role="alert">{error}</p>}
    {saved && <p role="status">Saved</p>}
  </div>;
}
