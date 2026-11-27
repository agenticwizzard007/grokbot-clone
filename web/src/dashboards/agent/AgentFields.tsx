import type { AgentWidgetOptions } from '@shared/ui-config';
import { useStore } from '../../store';
import { ButtonGroup } from '../../components/layout';
export function AgentFields({ options, change }: { options: AgentWidgetOptions; change(options: AgentWidgetOptions): void }) {
  const bots = useStore(state => state.bots);
  return <>
    <label className="dashboard-field">Prompt<textarea aria-label="Prompt" rows={4} maxLength={400} required value={options.prompt} onChange={event => change({ ...options, prompt: event.target.value })} aria-describedby="agent-prompt-count" /><span id="agent-prompt-count" className="dashboard-caption">{options.prompt.length}/400</span></label>
    <label className="dashboard-field">Bot<select value={options.botId ?? ''} onChange={event => { const { botId: _, ...rest } = options; change({ ...rest, ...(event.target.value ? { botId: event.target.value } : {}) }); }}><option value="">Default Bot</option>{bots.filter(bot => bot.kind !== 'room').map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
    <fieldset className="dashboard-agent-fieldset"><legend>Display</legend><ButtonGroup>{([['text', 'Text'], ['list', 'List'], ['stat', 'Number']] as const).map(([display, label]) => <button type="button" className="btn btn--secondary" aria-pressed={options.display === display} key={display} onClick={() => change({ ...options, display })}>{label}</button>)}</ButtonGroup></fieldset>
    <fieldset className="dashboard-agent-fieldset"><legend>Schedule</legend><ButtonGroup>{(['manual', 'hourly', 'daily'] as const).map(schedule => <button type="button" className="btn btn--secondary" aria-pressed={options.schedule === schedule} key={schedule} onClick={() => change({ ...options, schedule })}>{schedule[0].toUpperCase() + schedule.slice(1)}</button>)}</ButtonGroup></fieldset>
  </>;
}
