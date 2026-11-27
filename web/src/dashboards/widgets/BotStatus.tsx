import { BotAvatarFor } from '../../avatar/BotAvatar';
import { Row } from '../../components/layout';
import { useStore } from '../../store';
import { Empty, Status, numberOption, type WidgetProps } from './shared';
export default function BotStatus({ widget, data }: WidgetProps) {
  const bots = useStore(state => state.bots);
  const rows = data?.rows?.slice(0, numberOption(widget, 'limit', 6, 12)) ?? [];
  if (!rows.length) return <Empty widget={widget} text="No Bots yet." />;
  return <ul className="dashboard-bot-list">{rows.map(row => {
    const name = String(row.name ?? 'Bot'), count = Number(row.openTasks) || 0;
    const bot = bots.find(bot => bot.id === row.id) ?? { name, avatarShape: String(row.avatarShape ?? 'bird'), avatarColor: String(row.avatarColor ?? 'blue') };
    return <li key={String(row.id)}><a href={`#bot/${encodeURIComponent(String(row.id))}`} aria-label={`${name}, ${count} open tasks`}>
      <Row leading={<BotAvatarFor bot={bot} size={32} />} title={<span className="dashboard-bot-name" title={name}>{name}</span>} subtitle={<span className="dashboard-bot-meta"><Status value={row.status} /><span>{count} open tasks</span></span>} />
    </a></li>;
  })}</ul>;
}
