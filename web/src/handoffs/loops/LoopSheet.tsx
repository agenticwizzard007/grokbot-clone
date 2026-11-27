import { useId, useRef, useState } from 'react';
import { Modal } from '../../components/modals/Modal';
import { ButtonGroup, Card, Page, Row, Section } from '../../components/layout';
import { eligibleBot, errorText, loopsApi, type LoopApi, type LoopBot, type LoopSpec } from './api';
import './loops.css';

/** Controlled value shared with HO-D's Keep improving section. */
export type LoopDraft = LoopSpec & { allowSameBotRoles?: boolean };
export type LoopFieldErrors = Record<string, string>;
export function newLoopSpec(maker = '', checker = '', outputRef?: string): LoopDraft {
  return {
    name: '', goal: '', kind: 'maker_checker',
    steps: [{ id: 'maker', role: 'maker', botId: maker, instruction: 'Create the result and improve it from feedback.' }, { id: 'checker', role: 'checker', botId: checker, instruction: 'Check the result against the goal.' }],
    seed: outputRef ? { outputRef } : { text: '' }, exit: { mode: 'verdict' },
    limits: { maxIterations: 4, maxMinutes: 30, stepTimeoutMinutes: 10 }, gate: { before: 'none', onCap: 'stop' },
  };
}

export function validateLoop(value: LoopDraft, bots: LoopBot[], compact = false): LoopFieldErrors {
  const errors: LoopFieldErrors = {};
  if (!value.name.trim() || value.name.length > 80) errors.name = 'Use a name from 1 to 80 characters.';
  if (!value.goal.trim() || value.goal.length > 2000) errors.goal = 'Add a goal, up to 2000 characters.';
  if (!value.seed.text?.trim() && !value.seed.outputRef) errors.seed = 'Add a starting brief or output reference.';
  if (value.seed.outputRef && !/^swarm:\/\/output\/out_[A-Za-z0-9_-]+(?:#[A-Za-z0-9_-]+)?$/.test(value.seed.outputRef)) errors.seed = 'Use a Swarm output reference.';
  const valid = new Set(bots.filter(eligibleBot).map(bot => bot.id));
  for (const [index, step] of value.steps.entries()) {
    if (!valid.has(step.botId)) errors[`bot${index}`] = 'Choose an available agent.';
    if (!step.instruction.trim() || step.instruction.length > 1500) errors[`instruction${index}`] = 'Add instructions, up to 1500 characters.';
  }
  if (value.kind === 'maker_checker' && value.steps[0]?.botId && value.steps[0]?.botId === value.steps[1]?.botId && !value.allowSameBotRoles) errors.bot1 = 'Choose a different checker or allow self review.';
  if (value.steps.length < 2 || value.steps.length > 6 || (value.kind === 'maker_checker' && value.steps.length !== 2)) errors.steps = 'Use two agents, or 2 to 6 pipeline steps.';
  const bounds = { maxIterations: [compact ? 2 : 1, 10], maxMinutes: [5, 240], stepTimeoutMinutes: [1, 30] } as const;
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const number = value.limits[key as keyof typeof bounds];
    if (!Number.isInteger(number) || number < min || number > max) errors[key] = `Choose a number from ${min} to ${max}.`;
  }
  for (const key of ['maxCostUsd', 'maxTokens'] as const) {
    const number = value.limits[key];
    if (number !== undefined && (!Number.isFinite(number) || number <= 0 || (key === 'maxTokens' && !Number.isInteger(number)))) errors[key] = 'Use a positive number.';
  }
  if (value.exit.mode === 'checklist') {
    if (!value.exit.items.length || value.exit.items.length > 8 || value.exit.items.some(item => !item.text.trim() || item.text.length > 400)) errors.checklist = 'Add 1 to 8 checks, up to 400 characters each.';
    if (value.exit.minScore !== undefined && (!Number.isFinite(value.exit.minScore) || value.exit.minScore < 0 || value.exit.minScore > 1)) errors.minScore = 'Choose a score from 0 to 1.';
  }
  if (value.exit.mode === 'judge') {
    if (!value.exit.rubric.trim()) errors.rubric = 'Add a rubric for the judge.';
    if (value.exit.judgeBotId && !valid.has(value.exit.judgeBotId)) errors.judgeBotId = 'Choose an available judge.';
  }
  return errors;
}

export interface LoopFieldsProps {
  value: LoopDraft; onChange: (value: LoopDraft) => void; bots: LoopBot[];
  errors?: LoopFieldErrors; compact?: boolean; usageTracked?: boolean;
}
/** No form or modal wrapper: safe to embed inside the Send sheet. */
export function LoopFields({ value, onChange, bots, errors = {}, compact = false, usageTracked = true }: LoopFieldsProps) {
  const prefix = useId();
  const available = bots.filter(eligibleBot);
  const patch = (change: Partial<LoopDraft>) => onChange({ ...value, ...change });
  const limit = (key: keyof LoopSpec['limits'], number: number | undefined) => patch({ limits: { ...value.limits, [key]: number } });
  const field = (key: string) => ({ id: `${prefix}-${key}`, 'aria-invalid': !!errors[key], 'aria-describedby': errors[key] ? `${prefix}-${key}-error` : undefined });
  const error = (key: string) => errors[key] && <span className="ho-loop-error" id={`${prefix}-${key}-error`}>{errors[key]}</span>;
  const picker = (key: string, label: string, selected: string, set: (id: string) => void, optional = false) => <div className="ho-loop-field">
    <label htmlFor={`${prefix}-${key}`}>{label}</label>
    <select {...field(key)} value={selected} onChange={event => set(event.target.value)}><option value="">{optional ? 'Use the checker' : 'Choose an agent'}</option>{available.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>
    {selected && <span className="ho-loop-muted">{available.find(bot => bot.id === selected)?.name}</span>}{error(key)}
  </div>;
  const number = (key: keyof LoopSpec['limits'], label: string, min: number, max?: number, disabled = false) => <div className="ho-loop-field">
    <label htmlFor={`${prefix}-${key}`}>{label}</label><input {...field(key)} type="number" min={min} max={max} step={key === 'maxCostUsd' ? '0.01' : '1'} disabled={disabled} value={value.limits[key] ?? ''} onChange={event => limit(key, event.target.value === '' ? undefined : event.target.valueAsNumber)} />{error(key)}
  </div>;
  const changeMode = (mode: LoopSpec['exit']['mode']) => patch({ exit: mode === 'checklist' ? { mode, items: [{ id: 'check-1', text: '', required: true }] } : mode === 'judge' ? { mode, rubric: '' } : { mode } });
  return <div className="ho-loops ho-loop-fields">
    {!compact && <>
      <div className="ho-loop-field"><label htmlFor={`${prefix}-name`}>Name</label><input {...field('name')} maxLength={80} value={value.name} onChange={event => patch({ name: event.target.value })} />{error('name')}</div>
      <div className="ho-loop-field"><label htmlFor={`${prefix}-goal`}>Goal</label><textarea {...field('goal')} maxLength={2000} value={value.goal} onChange={event => patch({ goal: event.target.value })} />{error('goal')}</div>
      <div className="ho-loop-field"><label htmlFor={`${prefix}-seed`}>{value.seed.outputRef ? 'Starting output' : 'Starting brief'}</label>{value.seed.outputRef ? <input {...field('seed')} value={value.seed.outputRef} onChange={event => patch({ seed: { outputRef: event.target.value } })} /> : <textarea {...field('seed')} value={value.seed.text ?? ''} maxLength={20000} onChange={event => patch({ seed: { text: event.target.value } })} />}{error('seed')}</div>
      <div className="ho-loop-field"><label htmlFor={`${prefix}-kind`}>Process</label><select id={`${prefix}-kind`} value={value.kind} onChange={event => {
        const kind = event.target.value as LoopSpec['kind'];
        patch({ kind, steps: value.steps.slice(0, 2).map((step, index) => ({ ...step, role: index === 1 ? 'checker' : kind === 'maker_checker' ? 'maker' : 'step' })) });
      }}><option value="maker_checker">Maker and checker</option><option value="pipeline">Pipeline</option></select></div>
    </>}
    {value.steps.map((step, index) => (compact && index === 0 ? null : <fieldset key={step.id} className="ho-loop-step-fields">
      <legend>{value.kind === 'maker_checker' ? index === 0 ? 'Maker' : 'Checker' : `Step ${index + 1}`}</legend>
      {picker(`bot${index}`, value.kind === 'maker_checker' ? index === 0 ? 'Maker agent' : 'Checker agent' : `Agent for step ${index + 1}`, step.botId, botId => patch({ steps: value.steps.map((item, n) => n === index ? { ...item, botId } : item) }))}
      {!compact && <div className="ho-loop-field"><label htmlFor={`${prefix}-instruction${index}`}>Instructions for {value.kind === 'pipeline' ? `step ${index + 1}` : step.role}</label><textarea {...field(`instruction${index}`)} maxLength={1500} value={step.instruction} onChange={event => patch({ steps: value.steps.map((item, n) => n === index ? { ...item, instruction: event.target.value } : item) })} />{error(`instruction${index}`)}</div>}
      {value.kind === 'pipeline' && value.steps.length > 2 && <button type="button" className="ho-loop-button" onClick={() => patch({ steps: value.steps.filter((_, n) => index !== n).map((item, n, items) => ({ ...item, role: n === items.length - 1 ? 'checker' : 'step' })) })}>Remove step {index + 1}</button>}
    </fieldset>))}
    {value.kind === 'pipeline' && <button type="button" className="ho-loop-button" disabled={value.steps.length >= 6} onClick={() => patch({ steps: [...value.steps.map(step => ({ ...step, role: 'step' as const })), { id: crypto.randomUUID(), role: 'checker', botId: '', instruction: 'Check the result against the goal.' }] })}>Add step</button>}{error('steps')}
    {value.kind === 'maker_checker' && <label className="ho-loop-check"><input type="checkbox" checked={!!value.allowSameBotRoles} onChange={event => patch({ allowSameBotRoles: event.target.checked || undefined })} /><span>Use the same agent to check its own work</span></label>}
    <div className="ho-loop-field"><label htmlFor={`${prefix}-exit`}>Stop when</label><select id={`${prefix}-exit`} value={value.exit.mode} onChange={event => changeMode(event.target.value as LoopSpec['exit']['mode'])}><option value="verdict">Checker decides</option><option value="checklist">Checklist</option><option value="manual">I decide</option>{value.exit.mode === 'judge' && <option value="judge">Judge rubric</option>}</select></div>
    {value.exit.mode === 'checklist' && <fieldset className="ho-loop-step-fields"><legend>Checklist</legend>{value.exit.items.map((item, index) => <div key={item.id} className="ho-loop-field">
      <label htmlFor={`${prefix}-check-${index}`}>Check {index + 1}</label><input id={`${prefix}-check-${index}`} maxLength={400} value={item.text} onChange={event => { if (value.exit.mode === 'checklist') patch({ exit: { ...value.exit, items: value.exit.items.map(check => check.id === item.id ? { ...check, text: event.target.value } : check) } }); }} />
      <div className="ho-loop-inline"><label className="ho-loop-check"><input type="checkbox" checked={item.required} onChange={event => { if (value.exit.mode === 'checklist') patch({ exit: { ...value.exit, items: value.exit.items.map(check => check.id === item.id ? { ...check, required: event.target.checked } : check) } }); }} /><span>Required</span></label><button type="button" className="ho-loop-button" aria-label={`Remove check ${index + 1}`} onClick={() => { if (value.exit.mode === 'checklist') patch({ exit: { ...value.exit, items: value.exit.items.filter(check => check.id !== item.id) } }); }}>Remove</button></div>
    </div>)}{error('checklist')}<button type="button" className="ho-loop-button" disabled={value.exit.items.length >= 8} onClick={() => { if (value.exit.mode === 'checklist') patch({ exit: { ...value.exit, items: [...value.exit.items, { id: crypto.randomUUID(), text: '', required: true }] } }); }}>Add check</button></fieldset>}
    <div className="ho-loop-field"><label htmlFor={`${prefix}-maxIterations`}>Up to passes</label><div className="ho-loop-stepper"><button type="button" aria-label="Fewer passes" disabled={value.limits.maxIterations <= (compact ? 2 : 1)} onClick={() => limit('maxIterations', value.limits.maxIterations - 1)}>-</button><input {...field('maxIterations')} type="number" min={compact ? 2 : 1} max={10} value={Number.isFinite(value.limits.maxIterations) ? value.limits.maxIterations : ''} onChange={event => limit('maxIterations', event.target.valueAsNumber)} /><button type="button" aria-label="More passes" disabled={value.limits.maxIterations >= 10} onClick={() => limit('maxIterations', value.limits.maxIterations + 1)}>+</button></div>{error('maxIterations')}</div>
    <details className="ho-loop-advanced"><summary>Advanced</summary><div className="ho-loop-fields">
      {number('maxMinutes', 'Minutes', 5, 240)}{number('stepTimeoutMinutes', 'Step timeout in minutes', 1, 30)}
      {number('maxCostUsd', 'Budget in USD', 0.01, undefined, !usageTracked)}{number('maxTokens', 'Token budget', 1, undefined, !usageTracked)}
      {!usageTracked && <p className="ho-loop-muted">Cost not tracked on this plan</p>}
      <div className="ho-loop-field"><label htmlFor={`${prefix}-gate`}>Approval before</label><select id={`${prefix}-gate`} value={value.gate.before} onChange={event => patch({ gate: { ...value.gate, before: event.target.value as LoopSpec['gate']['before'] } })}><option value="none">No approval</option><option value="first">First pass</option><option value="each">Each pass</option></select></div>
      <div className="ho-loop-field"><label htmlFor={`${prefix}-onCap`}>At the limit</label><select id={`${prefix}-onCap`} value={value.gate.onCap} onChange={event => patch({ gate: { ...value.gate, onCap: event.target.value as LoopSpec['gate']['onCap'] } })}><option value="stop">Stop</option><option value="ask">Ask me</option></select></div>
      <label className="ho-loop-check"><input type="checkbox" checked={value.exit.mode === 'judge'} onChange={event => changeMode(event.target.checked ? 'judge' : 'verdict')} /><span>Use a judge rubric</span></label>
      {value.exit.mode === 'judge' && <>{picker('judgeBotId', 'Judge', value.exit.judgeBotId ?? '', judgeBotId => { if (value.exit.mode === 'judge') patch({ exit: { ...value.exit, judgeBotId: judgeBotId || undefined } }); }, true)}<div className="ho-loop-field"><label htmlFor={`${prefix}-rubric`}>Rubric</label><textarea {...field('rubric')} value={value.exit.rubric} maxLength={2000} onChange={event => { if (value.exit.mode === 'judge') patch({ exit: { ...value.exit, rubric: event.target.value } }); }} />{error('rubric')}</div></>}
      {value.exit.mode === 'checklist' && <div className="ho-loop-field"><label htmlFor={`${prefix}-minScore`}>Minimum score</label><input {...field('minScore')} type="number" min={0} max={1} step={0.05} value={value.exit.minScore ?? ''} onChange={event => { if (value.exit.mode === 'checklist') patch({ exit: { ...value.exit, minScore: event.target.value === '' ? undefined : event.target.valueAsNumber } }); }} />{error('minScore')}</div>}
      {!compact && <><div className="ho-loop-field"><label htmlFor={`${prefix}-room`}>Post progress in room</label><select id={`${prefix}-room`} value={value.roomId ?? ''} onChange={event => patch({ roomId: event.target.value || undefined })}><option value="">No room</option>{bots.filter(bot => bot.kind === 'room').map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></div><div className="ho-loop-field"><label htmlFor={`${prefix}-task`}>Task reference</label><input id={`${prefix}-task`} value={value.taskId ?? ''} onChange={event => patch({ taskId: event.target.value || undefined })} /></div></>}
    </div></details>
  </div>;
}

export function LoopSheet({ bots, onClose, onCreated, initial, api = loopsApi, usageTracked = true }: {
  bots: LoopBot[]; onClose: () => void; onCreated: (id: string) => void;
  initial?: LoopDraft; api?: LoopApi; usageTracked?: boolean;
}) {
  const [value, setValue] = useState(() => initial ?? newLoopSpec());
  const [errors, setErrors] = useState<LoopFieldErrors>({});
  const [serverError, setServerError] = useState('');
  const [pending, setPending] = useState(false);
  const busy = useRef(false), key = useRef(crypto.randomUUID());
  const submitted = useRef('');
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy.current) return;
    const checked = validateLoop(value, bots); setErrors(checked); setServerError('');
    if (Object.keys(checked).length) {
      requestAnimationFrame(() => { const invalid = document.querySelector<HTMLElement>('.ho-loop-sheet [aria-invalid="true"]'); invalid?.closest('details')?.setAttribute('open', ''); invalid?.focus(); }); return;
    }
    const spec = { ...value, name: value.name.trim(), goal: value.goal.trim(), limits: { ...value.limits, ...(!usageTracked ? { maxCostUsd: undefined, maxTokens: undefined } : {}) } };
    const fingerprint = JSON.stringify(spec);
    if (submitted.current && submitted.current !== fingerprint) key.current = crypto.randomUUID();
    submitted.current = fingerprint; busy.current = true; setPending(true);
    try { const result = await api.create(spec, key.current); onCreated(result.loop.id); onClose(); }
    catch (error) { setServerError(errorText(error)); }
    finally { busy.current = false; setPending(false); }
  };
  return <Modal label="New loop" className="ho-loop-sheet" onClose={onClose}>
    <Page title="New loop" className="ho-loops"><form onSubmit={submit} noValidate>
      <Section><Card><LoopFields value={value} onChange={setValue} bots={bots} errors={errors} usageTracked={usageTracked} /></Card></Section>
      {Object.keys(errors).length > 0 && <p role="alert" className="ho-loop-error">Check the highlighted fields.</p>}
      {serverError && <p role="alert" className="ho-loop-error">{serverError}</p>}
      <Row title="Limits apply to every pass" subtitle="Up to 10 passes. You can stop at any time." />
      <ButtonGroup><button type="button" className="ho-loop-button" onClick={onClose}>Cancel</button><button type="submit" className="ho-loop-button ho-loop-primary" disabled={pending}>{pending ? 'Starting' : 'Start loop'}</button></ButtonGroup>
    </form></Page>
  </Modal>;
}
export default LoopSheet;
