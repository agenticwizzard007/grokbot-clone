import { useState } from 'react';
import { widgetSchema } from '@shared/ui-config/schema';
import { WIDGETS } from '@shared/ui-config/registry-widgets';
import { SOURCES } from '@shared/ui-config/registry-sources';
import { Card, Section, ButtonGroup } from '../components/layout';
import { useStore } from '../store';
import { useEffectiveConfig } from '../customization';
import { DashboardDialog } from './Dialog';
import { fieldLabel, type Widget } from './model';

export function sourceDefaults(id: string) {
  return { ...(['tasks.series', 'usage.summary', 'usage.series', 'runs.counts', 'runs.series'].includes(id) ? { range: '7d' } : {}),
    ...(id === 'usage.series' ? { metric: 'cost' } : {}), ...(id === 'runs.series' ? { group: 'day' } : {}), ...(id === 'routines.upcoming' ? { days: 7 } : {}) };
}
export function WidgetSettings({ widget, save, close, error: serverError }: { widget: Widget; save(widget: Widget): Promise<boolean>; close(): void; error?: string }) {
  const [draft, setDraft] = useState(() => structuredClone(widget)), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const bots = useStore(state => state.bots), dashboards = useEffectiveConfig().dashboards;
  const metadata = WIDGETS.find(item => item.id === draft.type)!, source = SOURCES.find(item => item.id === draft.source?.id);
  const option = (key: string, value: unknown) => setDraft(current => ({ ...current, options: { ...current.options, [key]: value } }));
  const param = (key: string, value: unknown) => setDraft(current => {
    if (!current.source) return current; const params = { ...current.source.params }; if (value === '') delete params[key]; else params[key] = value;
    return { ...current, source: { ...current.source, params } };
  });
  const numeric = (label: string, key: string, minimum: number, maximum: number, fallback: number, params = false) => <label className="dashboard-field" key={key}>{label}<input type="number" min={minimum} max={maximum} value={Number((params ? draft.source?.params : draft.options)?.[key] ?? fallback)} onChange={event => params ? param(key, Number(event.target.value)) : option(key, Number(event.target.value))} /></label>;
  const selectOption = (label: string, key: string, values: string[], fallback: string) => <label className="dashboard-field">{label}<select value={String(draft.options[key] ?? fallback)} onChange={event => option(key, event.target.value)}>{values.map(value => <option key={value} value={value}>{fieldLabel(value)}</option>)}</select></label>;
  const scoped = source && ['tasks.counts', 'tasks.list', 'tasks.series', 'routines.list', 'runs.recent', 'runs.counts'].includes(source.id);
  const items = (draft.options.items ?? []) as { label: string; target: string }[];
  const setItem = (index: number, patch: Partial<{ label: string; target: string }>) => option('items', items.map((item, n) => n === index ? { ...item, ...patch } : item));
  return <DashboardDialog title="Widget settings" close={close}><form className="dashboard-settings" onSubmit={async event => {
    event.preventDefault(); const parsed = widgetSchema.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the widget settings.'); return; }
    setError(''); setBusy(true); try { if (await save(parsed.data)) close(); } finally { setBusy(false); }
  }}><Section><Card><label className="dashboard-field">Title<input value={draft.title ?? ''} maxLength={60} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
    {source && <label className="dashboard-field">Data<select value={source.id} onChange={event => {
      const id = event.target.value as NonNullable<Widget['source']>['id'];
      setDraft(current => ({ ...current, source: { id, params: sourceDefaults(id) }, options: current.type === 'stat' ? { field: id === 'tasks.counts' ? 'total' : 'count', format: 'number' }
        : current.type === 'table' ? { columns: SOURCES.find(item => item.id === id)!.fields.filter(field => field !== 'count').slice(0, 3), limit: 5 } : current.type === 'list' ? { limit: 5, onClick: 'open' } : current.options }));
    }}>{metadata.sources.map(id => <option key={id} value={id}>{SOURCES.find(item => item.id === id)?.label}</option>)}</select></label>}
    {scoped && <label className="dashboard-field">Bot<select value={String(draft.source?.params.botId ?? '')} onChange={event => param('botId', event.target.value)}><option value="">All Bots</option>{bots.map(bot => <option value={bot.id} key={bot.id}>{bot.name}</option>)}</select></label>}
    {source && 'range' in sourceDefaults(source.id) && <label className="dashboard-field">Period<select value={String(draft.source?.params.range ?? '7d')} onChange={event => param('range', event.target.value)}>{[['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month']].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}
    {source?.id === 'usage.series' && <label className="dashboard-field">Measure<select value={String(draft.source?.params.metric ?? 'cost')} onChange={event => param('metric', event.target.value)}>{['cost', 'requests', 'tokens'].map(value => <option value={value} key={value}>{fieldLabel(value)}</option>)}</select></label>}
    {source?.id === 'runs.series' && <label className="dashboard-field">Group<select value={String(draft.source?.params.group ?? 'day')} onChange={event => param('group', event.target.value)}><option value="day">Day</option><option value="state">State</option></select></label>}
    {source?.id === 'tasks.list' && draft.type !== 'taskBoard' && <label className="dashboard-field">State<select value={String(draft.source?.params.state ?? '')} onChange={event => param('state', event.target.value)}><option value="">All states</option>{['working', 'needs_input', 'done'].map(value => <option value={value} key={value}>{fieldLabel(value)}</option>)}</select></label>}
    {draft.type === 'stat' && <>{selectOption('Value', 'field', source?.id === 'tasks.counts' || source?.id === 'usage.summary' || source?.id === 'runs.counts' ? source.fields : ['count'], 'count')}{selectOption('Format', 'format', ['number', 'usd', 'percent'], 'number')}</>}
    {['list', 'table', 'botStatus'].includes(draft.type) && numeric('Items', 'limit', 1, draft.type === 'botStatus' ? 12 : 10, 5)}
    {draft.type === 'list' && selectOption('On click', 'onClick', ['open', 'none'], 'open')}
    {(draft.type === 'table' || draft.type === 'list') && <fieldset><legend>{draft.type === 'table' ? 'Columns' : 'Fields'}</legend><div className="dashboard-field-checks">{source?.fields.filter(field => field !== 'count').map(field => {
      const key = draft.type === 'table' ? 'columns' : 'fields', selected = (draft.options[key] ?? []) as string[];
      return <label key={field}><input type="checkbox" checked={selected.includes(field)} onChange={event => option(key, event.target.checked ? [...selected, field] : selected.filter(value => value !== field))} />{fieldLabel(field)}</label>;
    })}</div></fieldset>}
    {draft.type === 'chart' && selectOption('Chart', 'kind', ['bar', 'line', 'area'], 'bar')}
    {draft.type === 'meter' && numeric('Window', 'window', 0, 24, 0)}
    {draft.type === 'routineSchedule' && <label className="dashboard-field">Days<input type="number" min="1" max="14" value={Number(draft.options.days ?? 7)} onChange={event => setDraft({ ...draft, options: { ...draft.options, days: Number(event.target.value) }, source: { id: 'routines.upcoming', params: { days: Number(event.target.value) } } })} /></label>}
    {draft.type === 'note' && <label className="dashboard-field">Note<textarea rows={7} maxLength={2000} value={String(draft.options.text ?? '')} onChange={event => option('text', event.target.value)} /></label>}
    {draft.source && <label className="dashboard-field">Refresh<select value={draft.refreshSec ?? 60} onChange={event => setDraft({ ...draft, refreshSec: Number(event.target.value) as Widget['refreshSec'] })}>{[[0, 'Manual'], [30, 'Every 30 seconds'], [60, 'Every minute'], [300, 'Every 5 minutes']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
  </Card></Section>
    {draft.type === 'shortcuts' && <Section>{items.map((item, index) => {
      const ask = /^ask:([^:]+):(.*)$/.exec(item.target), selection = ask ? `ask:${ask[1]}` : item.target;
      return <Card key={index}><label className="dashboard-field">Label<input maxLength={40} value={item.label} onChange={event => setItem(index, { label: event.target.value })} /></label>
        <label className="dashboard-field">Destination<select value={selection} onChange={event => setItem(index, { target: event.target.value.startsWith('ask:') ? `${event.target.value}:Please help me with ` : event.target.value })}>
          <option value="bots">Bots</option><option value="tasks">Tasks</option><option value="settings">Settings</option>{dashboards.map(dashboard => <option key={dashboard.id} value={`dashboard:${dashboard.id}`}>{dashboard.name}</option>)}
          {bots.flatMap(bot => [<option key={bot.id} value={`bot:${bot.id}`}>{bot.name}</option>, <option key={`ask-${bot.id}`} value={`ask:${bot.id}`}>Ask {bot.name}</option>])}</select></label>
        {ask && <label className="dashboard-field">Draft message<textarea maxLength={200} value={ask[2]} onChange={event => setItem(index, { target: `ask:${ask[1]}:${event.target.value}` })} /></label>}
        <button type="button" className="btn" onClick={() => option('items', items.filter((_, n) => n !== index))}>Remove shortcut</button>
      </Card>;
    })}<button type="button" className="btn" disabled={items.length >= 6} onClick={() => option('items', [...items, { label: 'Tasks', target: 'tasks' }])}>Add shortcut</button></Section>}
    {(error || serverError) && <p role="alert">{error || serverError}</p>}
    <ButtonGroup><button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button><button type="submit" className="btn btn--primary" disabled={busy}>Save</button></ButtonGroup>
  </form></DashboardDialog>;
}
