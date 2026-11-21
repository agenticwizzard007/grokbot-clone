import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useStore } from '../../store';
import { useVersion } from '../../configStore';
import { teamApi } from '../../lib/teamApi';
import { workApi, type WorkControl, type WorkCriterion, type WorkEvidence, type WorkGoal, type WorkRecords, type WorkTask, type WorkWorkflow } from '../../lib/workApi';
import { openWorkChat, useWorkLifetime, workBotKey } from './workScope';
import './workArea.css';
import './workflows.css';

type Editor = 'goal' | 'workflow';
type WorkItem = { kind: Editor; id: string };
type Heading = { title: string; subtitle: string };
type Worker = { botId: string; name: string };
type DraftTask = { title: string; instructions: string; dependsOn: string[]; worker: string };
type Mutate = <Result>(run: () => Promise<Result>, ownerBotId: string) => Promise<Result | undefined>;
const emptyTask = (): DraftTask => ({ title: '', instructions: '', dependsOn: [], worker: '' });
const terminal = (status: string) => status === 'completed' || status === 'cancelled';
const labelStatus = (status: string) => status === 'active' ? 'In progress' : status === 'cancelled' ? 'Stopped' : status.replace(/^./, first => first.toUpperCase());

function EvidenceForm({ criteria, onSubmit, busy, sourceBotId }: { criteria: WorkCriterion[]; onSubmit: (evidence: WorkEvidence[]) => void; busy: boolean; sourceBotId: string }) {
  const [sources, setSources] = useState<Record<string, string>>({});
  const sourceGeneration = useStore(state => state.bots.find(bot => bot.id === sourceBotId)?.generation);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(criteria.map(criterion => {
      const source = sources[criterion.id]?.trim();
      if (criterion.kind === 'row') return { criterionId: criterion.id, kind: 'row', rowSeq: Number(source), botId: sourceBotId, generation: sourceGeneration };
      if (criterion.kind === 'file') return { criterionId: criterion.id, kind: 'file', path: source, botId: sourceBotId };
      return { criterionId: criterion.id, kind: 'result', taskId: source };
    }));
  };
  return <form className="work-form" onSubmit={submit}>
    {criteria.map(criterion => <label className="work-field" key={criterion.id}>{criterion.description}
      <input required type={criterion.kind === 'row' ? 'number' : 'text'} min={criterion.kind === 'row' ? 1 : undefined} maxLength={1000} value={sources[criterion.id] ?? ''} onChange={event => { const value = event.currentTarget.value; setSources(previous => ({ ...previous, [criterion.id]: value })); }} />
      <small>{criterion.kind === 'row' ? 'Message or tool result number' : criterion.kind === 'file' ? 'File path in this agent’s storage' : 'Validated task result ID'}{criterion.contains ? ` · Must contain “${criterion.contains}”` : ''}</small></label>)}
    <div className="work-actions"><button className="work-button is-primary" disabled={busy || !criteria.length} type="submit">Verify evidence and complete</button></div>
  </form>;
}

interface PanelProps { botId?: string; workspace?: boolean; onHeading?: (heading?: Heading) => void; onTeam?: () => void }

export function WorkflowsPanel(props: PanelProps) {
  const userId = useStore(state => state.user?.id);
  const scopedBot = useStore(state => state.bots.find(bot => bot.id === props.botId));
  return <WorkflowSurface key={`${userId}:${props.botId}:${workBotKey(scopedBot)}`} {...props} userId={userId} />;
}

function WorkflowSurface({ botId, workspace, onHeading, onTeam, userId }: PanelProps & { userId?: string }) {
  const bots = useStore(state => state.bots);
  const connected = useStore(state => state.sseConnected);
  const version = useVersion(botId ? `tasks:${botId}` : 'tasks');
  const [state, setState] = useState<WorkRecords | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]), [workerError, setWorkerError] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [readError, setReadError] = useState(''), [actionError, setActionError] = useState(''), [receipt, setReceipt] = useState('');
  const [create, setCreate] = useState<Editor | null>(null), [selected, setSelected] = useState<WorkItem | null>(null);
  const [activate, setActivate] = useState<string[]>([]);
  const pending = useRef(false);
  const lifetime = useWorkLifetime();
  const agents = bots.filter(bot => bot.kind !== 'room');
  const primary = agents.find(bot => bot.isPrimary);
  const selection = selected && (selected.kind === 'goal' ? state?.goals : state?.workflows)?.find(item => item.id === selected.id);
  const name = (id: string) => bots.find(bot => bot.id === id)?.name ?? 'Unavailable agent';
  useEffect(() => {
    if (!userId || pending.current) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && !pending.current && useStore.getState().user?.id === userId;
    setLoading(true);
    workApi.list(botId, controller.signal).then(value => {
      if (!current()) return;
      if (!Array.isArray(value.goals) || !Array.isArray(value.workflows)) throw new Error('The server returned incomplete work records.');
      setState({ goals: value.goals.filter(item => (!item.userId || item.userId === userId) && (!botId || item.botId === botId)), workflows: value.workflows.filter(item => (!item.userId || item.userId === userId) && (!botId || item.botId === botId)) });
      setReadError('');
    }).catch(err => { if (current()) setReadError(err.message); }).finally(() => { if (current()) setLoading(false); });
    return () => controller.abort();
  }, [userId, botId, version, revision, connected, busy]);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    teamApi.state(controller.signal).then(({ state: snapshot }) => {
      if (controller.signal.aborted || snapshot.userId !== userId) return;
      setWorkers(snapshot.agents.filter(agent => agent.setupStatus === 'active' && !agent.parentBotId)); setWorkerError('');
    }).catch(() => { if (!controller.signal.aborted) { setWorkers([]); setWorkerError('Activated agents could not be loaded. Refresh to try again.'); } });
    return () => controller.abort();
  }, [userId, revision, connected]);
  const availableWorkers = workers.filter(worker => agents.some(agent => agent.id === worker.botId));
  const headingTitle = create === 'goal' ? 'New persistent goal' : create === 'workflow' ? 'New workflow' : selection ? `${selection.title} · ${labelStatus(selection.status)}` : undefined;
  const headingSubtitle = create === 'goal' ? 'Create and start work on a measurable outcome.' : create === 'workflow' ? 'Create a draft. Start it when the tasks are ready.' : selection ? `${name(selection.botId)} ${selected?.kind === 'workflow' ? 'is coordinating this workflow.' : 'owns this goal.'}` : '';
  useEffect(() => { onHeading?.(headingTitle ? { title: headingTitle, subtitle: headingSubtitle } : undefined); }, [headingTitle, headingSubtitle, onHeading]);

  const mutate: Mutate = async (run, ownerBotId) => {
    if (pending.current || !userId || useStore.getState().user?.id !== userId) return;
    const generation = bots.find(bot => bot.id === ownerBotId)?.generation;
    const current = () => lifetime.current && useStore.getState().user?.id === userId && generation !== undefined && useStore.getState().bots.find(bot => bot.id === ownerBotId)?.generation === generation;
    if (!current()) { setActionError('This agent is no longer available. Refresh before making changes.'); return; }
    pending.current = true; setBusy(true); setActionError(''); setReceipt('');
    try { const result = await run(); if (current()) return result; }
    catch (err) { if (current()) setActionError((err as Error).message); }
    finally {
      pending.current = false;
      if (lifetime.current && useStore.getState().user?.id === userId) { setBusy(false); setLoading(true); setRevision(count => count + 1); }
    }
  };
  const newItem = (kind: Editor) => { setCreate(kind); setSelected(null); setActionError(''); setReceipt(''); };
  const back = () => { setCreate(null); setSelected(null); setActionError(''); };
  const refresh = () => { setActionError(''); setRevision(count => count + 1); };
  const board = primary ? `${primary.name}’s board` : 'Team board';
  return <section className={`work-ui workflows-panel${workspace ? ' is-workspace' : ''}`} aria-label="Goals and workflows">
    {!workspace && <h2 className="work-title">{headingTitle ?? 'Goals and workflows'}</h2>}
    {readError && <p className="work-error" role="alert">{state ? 'Could not refresh. Showing the last loaded records. ' : ''}{readError} <button className="work-button" type="button" onClick={refresh}>Refresh</button></p>}
    {actionError && <p className="work-error" role="alert">{actionError}</p>}
    {receipt && <p role="status">{receipt}</p>}
    {!state && !readError && <p role="status">Loading goals and workflows…</p>}
    {create && <CreateWork kind={create} botId={botId} workers={availableWorkers} workerError={workerError} busy={busy} cancel={back} onRefresh={refresh} mutate={mutate} onCreated={(item, start) => {
      setCreate(null); setSelected(item);
      if (item.kind === 'goal' && start === false) {
        setActivate(current => [...current, item.id]);
        setReceipt('Goal saved as active without an immediate run. Use Resume to explicitly queue execution; this is not a draft.');
      }
    }} />}
    {!create && selected && !selection && <p role="status">{loading ? 'Loading saved record…' : 'This record is not available in this scope.'} {!loading && <button className="work-button" type="button" onClick={back}>Back to goals and workflows</button>}</p>}
    {!create && selection && selected?.kind === 'goal' && 'turnsUsed' in selection && <GoalDetail goal={selection} busy={busy || loading || !!readError} mutate={mutate} back={back} deferred={activate.includes(selection.id)} onResumed={() => setActivate(current => current.filter(id => id !== selection.id))} />}
    {!create && selection && selected?.kind === 'workflow' && 'tasks' in selection && <WorkflowDetail workflow={selection} workers={availableWorkers} workerError={workerError} busy={busy || loading || !!readError} mutate={mutate} back={back} name={name} />}
    {!create && !selected && state && <>
      <div className="work-row"><div className="work-row__body"><div><h3>Persistent goals</h3><p className="work-meta">{state.goals.length ? `${state.goals.length} saved ${state.goals.length === 1 ? 'goal' : 'goals'}` : 'No goals yet. Start with an outcome and one acceptance check per line.'}</p></div><button className="work-button" type="button" onClick={() => newItem('goal')}>New goal</button></div></div>
      {state.goals.map(goal => <div className="work-row work-goal-row" key={goal.id}><div className="work-row__body"><div><h3>{goal.title}</h3><p className="work-meta">{name(goal.botId)} · {goal.status === 'active' ? 'Active' : labelStatus(goal.status)} · {goalTurnUsage(goal)}</p></div><button className="work-button" type="button" onClick={() => setSelected({ kind: 'goal', id: goal.id })}>Open goal</button></div></div>)}
      <div className="work-row"><div className="work-row__body"><div><h3>Workflows</h3><p className="work-meta">{state.workflows.length ? `${state.workflows.length} saved ${state.workflows.length === 1 ? 'workflow' : 'workflows'}` : 'No workflows yet. Draft a workflow and add tasks before you start it.'}</p></div><button className="work-button" type="button" onClick={() => newItem('workflow')}>New workflow</button></div></div>
      {state.workflows.map(workflow => <div className="work-row" key={workflow.id}><div className="work-row__body"><div><h3>{workflow.title}</h3><p className="work-meta">{name(workflow.botId)} · {labelStatus(workflow.status)} · {workflow.tasks.length} {workflow.tasks.length === 1 ? 'task' : 'tasks'}</p></div><button className="work-button" type="button" onClick={() => setSelected({ kind: 'workflow', id: workflow.id })}>Open workflow</button></div></div>)}
      {onTeam && <div className="work-row"><div className="work-row__body"><div><h3>{board}</h3><p className="work-meta">See who’s working and which tasks need attention.</p></div><button className="work-button" type="button" onClick={onTeam}>{board}</button></div></div>}
      <div className="work-actions is-stack"><button className="work-button" type="button" onClick={refresh} disabled={loading}>Refresh</button>
        {(botId || primary) && <button className="work-button" type="button" onClick={() => openWorkChat(botId ?? primary!.id)}>Manage work in chat</button>}
      </div>
    </>}
  </section>;
}

function CreateWork({ kind, botId, workers, workerError, busy, cancel, onRefresh, mutate, onCreated }: { kind: Editor; botId?: string; workers: Worker[]; workerError: string; busy: boolean; cancel: () => void; onRefresh: () => void; mutate: Mutate; onCreated: (item: WorkItem, start?: boolean) => void }) {
  const bots = useStore(state => state.bots).filter(bot => bot.kind !== 'room');
  const [owner, setOwner] = useState(botId ?? bots.find(bot => bot.isPrimary)?.id ?? bots[0]?.id ?? '');
  const [title, setTitle] = useState(''), [criteria, setCriteria] = useState(''), [turns, setTurns] = useState('');
  const [tokens, setTokens] = useState(''), [spend, setSpend] = useState(''), [start, setStart] = useState(true);
  const [steps, setSteps] = useState([emptyTask()]);
  const [error, setError] = useState('');
  const goal = kind === 'goal';
  const updateTask = (index: number, patch: Partial<DraftTask>) => setSteps(previous => previous.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (!bots.some(bot => bot.id === owner) || !title.trim()) { setError('Choose an available agent and enter a name.'); return; }
    if (goal) {
      const checks = criteria.split('\n').map(line => line.trim()).filter(Boolean);
      if (!checks.length || checks.length > 30 || checks.some(line => line.length > 1000)) { setError('Enter 1–30 acceptance checks of at most 1,000 characters each.'); return; }
      const result = await mutate(() => workApi.createGoal({ botId: owner, title: title.trim(), start, maxTurns: turns ? Number(turns) : 0, maxTokens: tokens ? Number(tokens) : undefined, maxSpendUsd: spend ? Number(spend) : undefined, criteria: checks.map((check, index) => ({ id: `criterion-${index + 1}`, description: check, kind: 'row', contains: check })) }), owner);
      if (result) onCreated({ kind, id: result.goal.id }, start);
    } else {
      if (steps.some(step => !step.title.trim() || !step.instructions.trim() || (step.worker && step.worker !== 'temporary' && !workers.some(worker => worker.botId === step.worker)))) { setError('Each task needs a title, instructions and an eligible worker selection.'); return; }
      const result = await mutate(() => workApi.createWorkflow({ botId: owner, title: title.trim(), tasks: steps.map((step, index) => ({ key: `step-${index + 1}`, title: step.title.trim(), instructions: step.instructions.trim(), dependsOn: step.dependsOn, delegate: !!step.worker, workerBotId: step.worker && step.worker !== 'temporary' ? step.worker : undefined, criteria: [{ id: 'result', description: 'A nonempty, schema-validated summary of the completed work', kind: 'result' }], outputSchema: { type: 'object', properties: { summary: { type: 'string', minLength: 1 } }, required: ['summary'], additionalProperties: false } })) }), owner);
      if (result) onCreated({ kind, id: result.workflow.id });
    }
  };
  return <form className="work-form workflow-create" onSubmit={submit}>
    {botId ? <p className="work-meta">{goal ? 'Goal owner' : 'Workflow coordinator'}: {bots.find(bot => bot.id === botId)?.name ?? 'Unavailable agent'}</p> : <label className="work-field">Agent<select value={owner} onChange={event => setOwner(event.currentTarget.value)} disabled={busy} required><option value="" disabled>Choose an agent</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select><small>{goal ? 'Choose the agent that will own this goal.' : 'Choose the workflow coordinator.'}</small></label>}
    <label className="work-field">{goal ? 'Goal' : 'Workflow name'}<input required aria-label={goal ? 'Goal' : 'Workflow name'} maxLength={500} value={title} onChange={event => setTitle(event.currentTarget.value)} /><small>{goal ? 'Required; use a clear outcome.' : 'Required.'}</small></label>
    {goal ? <>
      <label className="work-field">Acceptance checks<textarea required aria-label="Acceptance checks" value={criteria} onChange={event => setCriteria(event.currentTarget.value)} /><small>One required check per line. Completion requires saved evidence that matches each check.</small></label>
      <label className="work-field">Maximum turns (optional)<input type="number" aria-label="Maximum turns (optional)" placeholder="No limit" min={1} max={1000} value={turns} onChange={event => setTurns(event.currentTarget.value)} /><small>Leave blank for no limit. Enter 1 to 1,000 to cap the goal.</small></label>
      <details className="workflow-advanced"><summary>Advanced budgets and start</summary><div className="work-stack">
        <label className="work-field">Maximum tokens (optional)<input type="number" min={1} max={1000000000} value={tokens} onChange={event => setTokens(event.currentTarget.value)} /></label>
        <label className="work-field">Maximum spend in USD (optional)<input type="number" min="0" max="1000000" step="any" value={spend} onChange={event => { const input = event.currentTarget; input.setCustomValidity(input.value && !(Number(input.value) > 0) ? 'Enter a positive amount or leave this blank.' : ''); setSpend(input.value); }} /></label>
        <p className="work-meta">Blank budgets have no cap. The server can block finite-budget goals when it cannot verify usage.</p>
        <label className="workflow-checkbox"><input type="checkbox" checked={start} onChange={event => setStart(event.currentTarget.checked)} /> Start immediately</label>
        {!start && <p className="work-meta">The goal is saved as active, not as a draft. This request will not queue an immediate run. Use Resume to explicitly start execution.</p>}
      </div></details>
    </> : <>
      {workerError && <p className="work-error" role="alert">{workerError} <button className="work-button" type="button" onClick={onRefresh}>Refresh workers</button></p>}
      {steps.map((step, index) => <fieldset key={index}><legend>Task {index + 1}</legend>
        <label className="work-field">Task {index + 1} title<input required maxLength={500} value={step.title} onChange={event => updateTask(index, { title: event.currentTarget.value })} /></label>
        <label className="work-field">Task {index + 1} instructions<textarea required maxLength={16000} value={step.instructions} onChange={event => updateTask(index, { instructions: event.currentTarget.value })} /></label>
        {index > 0 && <fieldset><legend>Task {index + 1} waits for</legend>{steps.slice(0, index).map((earlier, earlierIndex) => {
          const key = `step-${earlierIndex + 1}`;
          return <label className="workflow-checkbox" key={key}><input type="checkbox" checked={step.dependsOn.includes(key)} onChange={event => updateTask(index, { dependsOn: event.currentTarget.checked ? [...step.dependsOn, key] : step.dependsOn.filter(id => id !== key) })} /> {earlier.title || `Task ${earlierIndex + 1}`}</label>;
        })}</fieldset>}
        <label className="work-field">Task {index + 1} worker<select value={step.worker} onChange={event => updateTask(index, { worker: event.currentTarget.value })}><option value="">Workflow coordinator</option><option value="temporary">Temporary helper</option>{workers.filter(worker => worker.botId !== owner).map(worker => <option key={worker.botId} value={worker.botId}>{worker.name}</option>)}</select><small>Choose the coordinator, a temporary helper or an activated permanent agent.</small></label>
      </fieldset>)}
    </>}
    {error && <p className="work-error" role="alert">{error}</p>}
    <div className="work-actions is-stack"><button className="work-button is-primary" disabled={busy || !owner} type="submit">{busy ? 'Saving…' : goal ? (start ? 'Create and start' : 'Create without starting') : 'Create workflow'}</button>
      {!goal && <button className="work-button" type="button" disabled={busy || steps.length >= 100} onClick={() => setSteps(previous => [...previous, emptyTask()])}>Add task</button>}
      <button className="work-button" type="button" disabled={busy} onClick={cancel}>Cancel</button></div>
  </form>;
}

function goalTurnUsage(goal: WorkGoal) {
  return goal.maxTurns > 0 ? `${goal.turnsUsed} / ${goal.maxTurns} turns` : `${goal.turnsUsed} turns · No turn limit`;
}

function GoalDetail({ goal, busy, mutate, back, deferred, onResumed }: { goal: WorkGoal; busy: boolean; mutate: Mutate; back: () => void; deferred: boolean; onResumed: () => void }) {
  const [evidence, setEvidence] = useState(false);
  const action = async (control: WorkControl) => { const result = await mutate(() => workApi.controlGoal(goal.id, control), goal.botId); if (result && control === 'resume') onResumed(); };
  return <>
    <div className="work-row"><h3>Goal status · {goal.status === 'active' ? 'Active' : labelStatus(goal.status)}</h3><p className="work-meta">{goalTurnUsage(goal)}</p>
      {goal.maxTokens != null && <p className="work-meta">{goal.tokensUsed.toLocaleString()} of {goal.maxTokens.toLocaleString()} tokens</p>}
      {goal.maxSpendUsd != null && <p className="work-meta">${goal.spendUsd} of ${goal.maxSpendUsd} USD recorded</p>}
      {deferred && goal.status === 'active' && <p className="work-meta">No immediate run was requested on creation.</p>}
      {goal.reason && <p className="work-meta">{goal.reason}</p>}
      {!!(goal.unknownTokenTurns || goal.unknownSpendTurns) && <p className="work-meta">Some usage measurements are unavailable. Recorded amounts do not include unknown usage.</p>}
    </div>
    <div className="work-row"><h3>Acceptance checks</h3><ul>{goal.criteria.map(criterion => <li key={criterion.id}>{criterion.description}</li>)}</ul>
      {terminal(goal.status) ? (!!goal.evidence?.length && <details><summary>Completion evidence</summary><pre>{JSON.stringify(goal.evidence, null, 2)}</pre></details>) : <>
        <button className="work-button" type="button" aria-expanded={evidence} onClick={() => setEvidence(!evidence)}>Add completion evidence</button>
        {evidence && <EvidenceForm criteria={goal.criteria} sourceBotId={goal.botId} busy={busy} onSubmit={async refs => { if (await mutate(() => workApi.verifyGoal(goal.id, refs), goal.botId)) setEvidence(false); }} />}
      </>}
    </div>
    <div className="work-actions is-stack">{!terminal(goal.status) && <>
      {(goal.status !== 'active' || deferred) ? <button className="work-button is-primary" type="button" disabled={busy} onClick={() => void action('resume')}>Resume</button> : <>
        <button className="work-button is-primary" type="button" disabled={busy} onClick={() => void action('pause')}>Pause</button>
        <button className="work-button" type="button" disabled={busy} onClick={() => void action('resume')}>Resume execution</button>
      </>}
      <button className="work-button" type="button" disabled={busy} onClick={() => void action('stop')}>Stop</button>
    </>}<button className="work-button" type="button" disabled={busy} onClick={back}>Back to goals</button></div>
  </>;
}

function WorkflowDetail({ workflow, workers, workerError, busy, mutate, back, name }: { workflow: WorkWorkflow; workers: Worker[]; workerError: string; busy: boolean; mutate: Mutate; back: () => void; name: (id: string) => string }) {
  const [block, setBlock] = useState(false), [reason, setReason] = useState('');
  const control = (action: WorkControl, why?: string) => mutate(() => workApi.controlWorkflow(workflow.id, action, why), workflow.botId);
  const open = !terminal(workflow.status);
  return <>
    {workflow.reason && <p className="work-meta">{workflow.reason}</p>}
    {workflow.tasks.map(task => <SavedTask key={task.id} task={task} workflow={workflow} workers={workers} workerError={workerError} name={name} busy={busy} mutate={mutate} />)}
    {block && open && <form className="work-form" onSubmit={async event => { event.preventDefault(); if (reason.trim() && await control('block', reason.trim())) { setBlock(false); setReason(''); } }}>
      <label className="work-field">Blocking reason<textarea required maxLength={2000} value={reason} onChange={event => setReason(event.currentTarget.value)} /><small>This blocks the workflow. Completed tasks stay complete; resume manually when it’s safe to continue.</small></label>
      <div className="work-actions"><button className="work-button is-primary" type="submit" disabled={busy || !reason.trim()}>Mark workflow blocked</button><button className="work-button" type="button" onClick={() => setBlock(false)}>Cancel</button></div>
    </form>}
    <div className="work-actions is-stack">{open && <>
      {workflow.status === 'draft' ? <button className="work-button is-primary" type="button" disabled={busy} onClick={() => void mutate(() => workApi.startWorkflow(workflow.id), workflow.botId)}>Start</button> : <button className="work-button is-primary" type="button" disabled={busy} onClick={() => void control(workflow.status === 'active' ? 'pause' : 'resume')}>{workflow.status === 'active' ? 'Pause' : 'Resume'}</button>}
      {!block && workflow.status !== 'blocked' && <button className="work-button" type="button" disabled={busy} onClick={() => setBlock(true)}>Block workflow</button>}
      <button className="work-button" type="button" disabled={busy} onClick={() => void control('stop')}>Stop</button>
    </>}<button className="work-button" type="button" disabled={busy} onClick={back}>Back to workflows</button></div>
  </>;
}

function SavedTask({ task, workflow, workers, workerError, name, busy, mutate }: { task: WorkTask; workflow: WorkWorkflow; workers: Worker[]; workerError: string; name: (id: string) => string; busy: boolean; mutate: Mutate }) {
  const [evidence, setEvidence] = useState(false), [dependency, setDependency] = useState(''), [worker, setWorker] = useState('');
  const sourceBotId = task.assignedBotId ?? workflow.botId;
  const editable = !terminal(workflow.status);
  const prerequisites = workflow.tasks.filter(other => other.id !== task.id && !task.dependsOn.includes(other.id));
  const canAdd = editable && ['waiting', 'ready', 'blocked'].includes(task.status) && prerequisites.length > 0;
  const canDelegate = editable && ['ready', 'blocked'].includes(task.status) && !task.activeJobId;
  return <article className="work-row"><div className="work-row__body"><div><h3>{task.title}</h3><p className="work-meta">{name(sourceBotId)} · {task.dependsOn.length ? `Waits for ${task.dependsOn.map(id => workflow.tasks.find(other => other.id === id)?.title ?? id).join(', ')}` : 'No prerequisites'}</p>
    <p className={`workflow-status is-${task.status}`}>{labelStatus(task.status)}{task.resultValidated ? ' · Result validated' : ''}</p></div>
    {editable && !terminal(task.status) && <button className="work-button" type="button" aria-expanded={evidence} onClick={() => setEvidence(!evidence)}>Verify task evidence</button>}
  </div>
    {task.reason && <p className="work-meta">{task.reason}</p>}
    {task.correctionCount > 0 && <p className="work-meta">One output correction requested.</p>}
    {task.result != null && <details><summary>Result</summary><pre>{JSON.stringify(task.result, null, 2)}</pre></details>}
    {!!task.evidence?.length && <details><summary>Recorded evidence</summary><pre>{JSON.stringify(task.evidence, null, 2)}</pre></details>}
    {evidence && !terminal(task.status) && <EvidenceForm criteria={task.criteria} sourceBotId={sourceBotId} busy={busy} onSubmit={async refs => { if (await mutate(() => workApi.completeTask(workflow.id, task.id, refs), workflow.botId)) setEvidence(false); }} />}
    {(canAdd || canDelegate) && <details className="saved-task-editor"><summary>Edit saved task</summary>
      {canAdd && <form className="work-form" onSubmit={async event => { event.preventDefault(); if (dependency && await mutate(() => workApi.addDependency(workflow.id, task.id, dependency), workflow.botId)) setDependency(''); }}>
        <label className="work-field">Add prerequisite for {task.title}<select required value={dependency} onChange={event => setDependency(event.currentTarget.value)}><option value="">Choose a task</option>{prerequisites.map(other => <option value={other.id} key={other.id}>{other.title}</option>)}</select><small>Only before admission. The server rejects dependency cycles.</small></label>
        <div className="work-actions"><button className="work-button" type="submit" disabled={busy || !dependency}>Add prerequisite</button></div>
      </form>}
      {canDelegate && <form className="work-form" onSubmit={async event => { event.preventDefault(); if (worker && await mutate(() => workApi.delegateTask(workflow.id, task.id, worker === 'temporary' ? undefined : worker), workflow.botId)) setWorker(''); }}>
        <label className="work-field">Assign worker for {task.title}<select required value={worker} onChange={event => setWorker(event.currentTarget.value)}><option value="">Choose a worker</option>{(!task.assignedBotId || task.assignedBotId === workflow.botId) && <option value="temporary">Temporary helper</option>}{workers.filter(candidate => candidate.botId !== task.assignedBotId).map(candidate => <option value={candidate.botId} key={candidate.botId}>{candidate.name}</option>)}</select><small>Assignment does not start the task. Only eligible, unadmitted work can change workers.</small></label>
        {workerError && <p className="work-error">{workerError}</p>}
        <div className="work-actions"><button className="work-button" type="submit" disabled={busy || !worker}>Assign worker</button></div>
      </form>}
    </details>}
  </article>;
}
