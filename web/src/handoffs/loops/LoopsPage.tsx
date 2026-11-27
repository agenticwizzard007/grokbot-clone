import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus } from 'lucide-react';
import { ButtonGroup, Card, Page, Row, Section } from '../../components/layout';
import { LoopSheet } from './LoopSheet';
import { errorText, loopsApi, statusLabel, type Loop, type LoopApi, type LoopBot, type LoopTask } from './api';
import './loops.css';

export interface LoopsPageProps { api?: LoopApi; onBack?: () => void; onOpen?: (id: string) => void; showBack?: boolean; usageTracked?: boolean }
export function LoopsPage({ api = loopsApi, onBack = () => { location.hash = '#tasks'; }, onOpen = id => { location.hash = `#loop/${encodeURIComponent(id)}`; }, showBack = true, usageTracked = true }: LoopsPageProps) {
  const [loops, setLoops] = useState<Loop[]>([]), [bots, setBots] = useState<LoopBot[]>([]);
  const [tasks, setTasks] = useState<LoopTask[]>([]);
  const [filter, setFilter] = useState('Running'), [sheet, setSheet] = useState(false);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let running = false, queued = false;
    const refresh = async () => {
      if (running) { queued = true; return; } running = true;
      do {
        queued = false;
        try {
          const result: Loop[] = [];
          let cursor: string | undefined;
          const cursors = new Set<string>();
          do {
            const page = await api.list(controller.signal, cursor); result.push(...page.loops);
            cursor = page.next ?? undefined;
            if (cursor && cursors.has(cursor)) throw new Error('Could not read the next loops. Try again.');
            if (cursor) cursors.add(cursor);
          } while (cursor);
          const [agents, availableTasks] = await Promise.all([api.bots(controller.signal), api.tasks?.(controller.signal) ?? Promise.resolve([])]);
          if (controller.signal.aborted) return;
          setLoops([...new Map(result.map(loop => [loop.id, loop])).values()].sort((a, b) => b.updatedAt - a.updatedAt)); setBots(agents); setTasks(availableTasks); setError('');
        } catch (error) { if (!controller.signal.aborted) setError(errorText(error)); }
        finally { if (!controller.signal.aborted) setLoading(false); }
      } while (queued && !controller.signal.aborted);
      running = false;
    };
    reload.current = () => { void refresh(); }; const off = api.subscribe(() => { void refresh(); }); void refresh();
    return () => { controller.abort(); off(); };
  }, [api]);
  const visible = loops.filter(loop => filter === 'Running' ? ['draft', 'running', 'paused', 'awaiting_approval'].includes(loop.status) : filter === 'Done' ? loop.status === 'succeeded' : ['capped', 'stalled', 'failed', 'cancelled'].includes(loop.status));
  return <Page type="list" className="ho-loops">
    <header className="ho-loop-heading">{showBack && <button className="ho-loop-button ho-loop-back" onClick={onBack}><ArrowLeft size={18} aria-hidden />Back</button>}<h1>Loops</h1><button className="ho-loop-button ho-loop-primary" disabled={loading} onClick={() => setSheet(true)}><Plus size={18} aria-hidden />New loop</button></header>
    <ButtonGroup aria-label="Filter loops">{['Running', 'Done', 'Stopped'].map(name => <button className="ho-loop-button" aria-pressed={name === filter} key={name} onClick={() => setFilter(name)}>{name}</button>)}</ButtonGroup>
    <Section>
      {loading && <Card aria-busy="true"><Row title="Loading loops" /><Row title={<span className="ho-loop-skeleton" />} /></Card>}
      {error && <Card><Row title={<span role="alert">{error}</span>} trailing={<button className="ho-loop-button" onClick={() => reload.current()}>Retry</button>} /></Card>}
      {!loading && !error && !visible.length && <Card><Row title="Nothing here yet" subtitle={filter === 'Running' ? 'Start a loop to improve a result together.' : undefined} /></Card>}
      {visible.map(loop => <Card key={loop.id} variant="list"><Row title={<button className="ho-loop-title-link" onClick={() => onOpen(loop.id)}>{loop.spec.name}</button>} subtitle={<span className="ho-loop-inline"><span>{loop.iteration} of {loop.spec.limits.maxIterations} passes</span><time dateTime={new Date(loop.updatedAt).toISOString()}>{new Date(loop.updatedAt).toLocaleString()}</time></span>} trailing={<span className={`ho-loop-chip ho-loop-status-${loop.status}`}>{statusLabel[loop.status]}</span>} /></Card>)}
    </Section>
    {sheet && <LoopSheet bots={bots} tasks={tasks} api={api} usageTracked={usageTracked} onClose={() => setSheet(false)} onCreated={onOpen} />}
  </Page>;
}
export default LoopsPage;
