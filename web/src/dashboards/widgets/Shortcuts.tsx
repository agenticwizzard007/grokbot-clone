import { prefillComposer } from '../../components/Composer';
import { openConversation } from '../../configStore';
import { useStore } from '../../store';
import { noteLink } from '../note-parser';
import { Empty, type WidgetProps } from './shared';
export default function Shortcuts({ widget }: WidgetProps) {
  const bots = useStore(state => state.bots);
  const items = (Array.isArray(widget.options.items) ? widget.options.items : []).slice(0, 6) as { label: string; target: string }[];
  if (!items.length) return <Empty widget={widget} text="Add a shortcut." />;
  if (!bots.length && items.length === 1 && items[0].target === 'tasks') return <div className="dashboard-empty-data"><p>Start with your tasks.</p><a className="btn" href="#tasks">{items[0].label}</a></div>;
  return <div className="dashboard-shortcuts">{items.map((item, index) => {
    if (item.target.startsWith('ask:')) {
      const match = /^ask:([a-zA-Z0-9_-]+):([^<>]{1,200})$/.exec(item.target);
      return match && bots.some(bot => bot.id === match[1]) ? <button className="btn" type="button" key={index} onClick={() => { prefillComposer(match[1], match[2]); openConversation(match[1]); }}>{item.label}</button> : null;
    }
    const link = noteLink(item.target);
    return link && !link.domain ? <a className="btn" key={index} href={link.href}>{item.label}</a> : null;
  })}</div>;
}
