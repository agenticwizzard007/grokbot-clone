import { lazy, Suspense, useEffect, useId, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { BotAvatar } from '../avatar/BotAvatar';
import { ButtonGroup, Card, Page, Row, Section } from '../components/layout';
import { eligibleAgents, handoffApi, linkInput, type Handoff, type HandoffAgent, type HandoffLink, type HandoffSource, type RunOutput, type LoopSpec } from './api';
import { errorText, handoffText, refreshHandoffs, useHandoffResource } from './useHandoffs';
import { HandoffState } from './HandoffRow';
import './handoffs.css';

/** Optional HO-E module. Vite omits this entry until that workstream merges. */
export interface KeepImprovingProps {
  agents: HandoffAgent[]; senderId: string; toBotId: string; outputId: string; instruction: string;
  title: string; onStarted: (loopId: string) => void; onPending: (pending: boolean) => void;
}
type LoopDraft = LoopSpec & { allowSameBotRoles?: boolean };
interface LoopFieldsModule {
  LoopFields: ComponentType<{ value: LoopDraft; onChange: (value: LoopDraft) => void; bots: HandoffAgent[]; compact: boolean; errors: Record<string, string> }>;
  newLoopSpec: (maker: string, checker: string, outputRef: string) => LoopDraft;
  validateLoop: (value: LoopDraft, bots: HandoffAgent[], compact: boolean) => Record<string, string>;
}
const loopModules = import.meta.glob<LoopFieldsModule>('./loops/LoopSheet.tsx');
const loadLoop = loopModules['./loops/LoopSheet.tsx'];
const LoopFields = loadLoop ? lazy(() => loadLoop().then(module => ({ default: (props: KeepImprovingProps) => <KeepImproving {...props} module={module} /> }))) : null;

function KeepImproving({ module, agents, senderId, toBotId, outputId, title, instruction, onStarted, onPending }: KeepImprovingProps & { module: LoopFieldsModule }) {
  const [value, setValue] = useState(() => module.newLoopSpec(toBotId, senderId, `swarm://output/${outputId}`));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const lock = useRef(false), attempt = useRef({ key: crypto.randomUUID(), signature: '' });
  async function start() {
    if (lock.current) return;
    const spec = { ...value, name: title.slice(0, 80), goal: instruction.trim(), steps: value.steps.map((step, index) => index === 0 ? { ...step, instruction: instruction.trim() } : step) };
    const invalid = module.validateLoop(spec, agents, true); setErrors(invalid); setError('');
    if (Object.keys(invalid).length) return;
    const signature = JSON.stringify(spec);
    if (attempt.current.signature && attempt.current.signature !== signature) attempt.current.key = crypto.randomUUID();
    attempt.current.signature = signature; lock.current = true; onPending(true);
    try { const result = await handoffApi.startLoop(spec, attempt.current.key); refreshHandoffs(); onStarted(result.loop.id); }
    catch (reason) { setError(errorText(reason)); }
    finally { lock.current = false; onPending(false); }
  }
  return <><module.LoopFields value={value} onChange={setValue} bots={agents} compact errors={errors} />
    {Object.keys(errors).length > 0 && <p role="alert">Check the highlighted fields.</p>}
    {error && <p className="ho-error" role="alert">{error}</p>}
    <button className="ho-button ho-button--primary" onClick={() => void start()}>Start loop</button></>;
}

export interface SendSheetProps {
  open: boolean; onClose: () => void; senderId: string;
  output?: RunOutput; source?: HandoffSource; title?: string; initialTargetId?: string;
  roomId?: string; roomMemberIds?: string[];
  onSent: (handoff: Handoff, target: HandoffAgent) => void;
  onLoopStarted?: (loopId: string) => void;
}

/** Mount a new session on each open so deliberate repeat sends get a fresh key. */
export function SendSheet(props: SendSheetProps) { return props.open ? <SendSession {...props} /> : null; }

function SendSession({ onClose, senderId, output, source, title, initialTargetId, roomId, roomMemberIds, onSent, onLoopStarted }: SendSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const headingId = useId(), askId = useId(), searchId = useId(), errorId = useId();
  const [targetId, setTargetId] = useState(initialTargetId ?? '');
  const [instruction, setInstruction] = useState('Review this and improve it.');
  const [search, setSearch] = useState('');
  const [returnResult, setReturnResult] = useState(true);
  const [keepImproving, setKeepImproving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [offered, setOffered] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const appliedTemplate = useRef(false);
  const attempt = useRef({ signature: '', key: crypto.randomUUID() });
  const targets = useHandoffResource(`targets:${senderId}`, async signal => {
    const [agents, links] = await Promise.all([handoffApi.agents(signal), handoffApi.links(senderId, signal)]);
    return { agents: agents.bots, links: links.links };
  });
  const agents = eligibleAgents(targets.data?.agents ?? [], senderId, roomMemberIds);
  const links = targets.data?.links ?? [];
  const target = agents.find(bot => bot.id === targetId);
  const suggested = new Set(links.filter(link => link.mode !== 'off').map(link => link.toBotId));
  const sorted = [...agents].sort((a, b) => Number(suggested.has(b.id)) - Number(suggested.has(a.id)) || b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name));
  const visible = sorted.filter(bot => `${bot.name} ${bot.label}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const selectedSource = source ?? (output ? { outputId: output.id } : undefined);

  useEffect(() => {
    const element = dialog.current!, opener = document.activeElement;
    mounted.current = true;
    element.showModal();
    return () => { mounted.current = false; element.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    if (initialTargetId && targets.data && !appliedTemplate.current) {
      appliedTemplate.current = true;
      const link = targets.data.links.find(link => link.toBotId === initialTargetId);
      if (link?.template) setInstruction(expandTemplate(link, output));
    }
  }, [initialTargetId, targets.data, output]);

  function choose(bot: HandoffAgent) {
    setTargetId(bot.id); setError(''); setOffered(false);
    const link = links.find(link => link.toBotId === bot.id);
    setInstruction(link?.template ? expandTemplate(link, output) : 'Review this and improve it.');
  }
  async function send() {
    if (lock.current || !target || !selectedSource || !instruction.trim()) return;
    lock.current = true; setBusy(true); setError('');
    const body = { source: selectedSource, toBotId: target.id, instruction: instruction.trim(), returnResult, ...(roomId ? { roomId } : {}) };
    const signature = JSON.stringify(body);
    if (attempt.current.signature && attempt.current.signature !== signature) attempt.current.key = crypto.randomUUID();
    attempt.current.signature = signature;
    try {
      const { handoff } = await handoffApi.send({ ...body, idempotencyKey: attempt.current.key });
      refreshHandoffs(); onSent(handoff, target); if (mounted.current) closeRef.current();
    } catch (reason) { setError(errorText(reason)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function offer() {
    if (lock.current || !target) return;
    lock.current = true; setBusy(true); setError('');
    try {
      // Read immediately before replacing so links created since opening are preserved.
      const current = (await handoffApi.links(senderId)).links;
      const existing = current.find(link => link.toBotId === target.id);
      if (!existing && current.length >= 5) throw new Error('Up to 5 links per agent. Remove a link first.');
      const next = current.filter(link => link.toBotId !== target.id).map(linkInput);
      next.push({ ...(existing ? linkInput(existing) : {}), toBotId: target.id, mode: existing?.mode === 'auto' ? 'auto' : 'suggest', trigger: existing?.trigger ?? 'any_run', template: instruction.slice(0, 500), autoApproveLoops: existing?.autoApproveLoops ?? false });
      await handoffApi.saveLinks(senderId, next); setOffered(true); refreshHandoffs();
    } catch (reason) { setError(errorText(reason)); }
    finally { lock.current = false; setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="ho ho-dialog" aria-labelledby={headingId}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]')]
        .filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); event.currentTarget.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
    onCancel={event => { event.preventDefault(); closeRef.current(); }}>
    <Page type="form">
      <header className="ho-dialog-heading"><h1 id={headingId}>Send to agent</h1><button className="ho-button ho-close" aria-label="Close" onClick={onClose} autoFocus><X size={20} aria-hidden="true" /></button></header>
      <Card variant="list"><Row title={handoffText(output?.title ?? title ?? 'Output')} subtitle={output ? `${output.parts.length} ${output.parts.length === 1 ? 'part' : 'parts'}${output.status === 'draft' ? ', incomplete' : ''}` : 'Ready to send'} /></Card>
      <fieldset disabled={busy} className="ho-fields">
        <Section title="To">
          {agents.length > 6 && <label htmlFor={searchId} className="ho-field">Search agents<input id={searchId} type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>}
          <HandoffState loading={!targets.data && targets.loading} error={targets.error} retry={targets.retry} empty={!targets.loading && !visible.length ? 'No available agents' : undefined} />
          <div className="ho-targets" role="group" aria-label="To">
            {visible.map(bot => <button key={bot.id} className={`ho-target${targetId === bot.id ? ' is-selected' : ''}`} aria-pressed={targetId === bot.id} onClick={() => choose(bot)}>
              <Row leading={<span aria-hidden="true"><BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={20} /></span>} title={handoffText(bot.name)} subtitle={handoffText(bot.label)} trailing={suggested.has(bot.id) ? <span className="ho-chip">Suggested</span> : undefined} />
            </button>)}
          </div>
        </Section>
        <div className="ho-field"><label htmlFor={askId}>Ask</label><textarea id={askId} rows={3} maxLength={1000} value={instruction} aria-describedby={error ? errorId : undefined} onChange={event => setInstruction(event.target.value)} /></div>
        {instruction.length >= 900 && <span className="ho-counter">{instruction.length} / 1000</span>}
        <Card variant="list"><Row title={<label className="ho-check"><input type="checkbox" checked={returnResult} onChange={event => setReturnResult(event.target.checked)} />Send result back to me</label>} />
          {LoopFields && output && onLoopStarted && <Row title={<label className="ho-check"><input type="checkbox" checked={keepImproving} onChange={event => setKeepImproving(event.target.checked)} />Keep improving</label>} />}
        </Card>
        {keepImproving && LoopFields && target && output && onLoopStarted ? <Suspense fallback={<HandoffState loading />}><LoopFields key={target.id} agents={(targets.data?.agents ?? []).filter(bot => bot.id === senderId || agents.some(agent => agent.id === bot.id))} senderId={senderId} toBotId={target.id} outputId={output.id} title={output.title} instruction={instruction} onPending={setBusy} onStarted={loopId => { onLoopStarted(loopId); if (mounted.current) closeRef.current(); }} /></Suspense> :
          <ButtonGroup><button className="ho-button ho-button--primary" disabled={!target || !selectedSource || !instruction.trim() || busy} onClick={() => void send()}>{busy ? 'Sending' : 'Send'}</button></ButtonGroup>}
        {target && <button className="ho-button ho-button--quiet" disabled={busy || offered || !instruction.trim()} onClick={() => void offer()}>{offered ? 'Always offered' : 'Always offer this'}</button>}
      </fieldset>
      {error && <p id={errorId} className="ho-error" role="alert">{error}</p>}
    </Page>
  </dialog>, document.body);
}
function expandTemplate(link: HandoffLink, output?: RunOutput) {
  return link.template.replace(/\{title\}/g, () => output?.title ?? 'this output').replace(/\{summary\}/g, () => output?.summary ?? '').slice(0, 1000);
}
