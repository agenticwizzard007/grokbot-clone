import type { Widget } from '../model';
import { useStore } from '../../store';
import { prefillComposer } from '../../components/Composer';
import { openConversation } from '../../configStore';

/** Empty data has one next step. Drafts are never sent automatically. */
export function Empty({ text = 'No data yet.', widget }: { text?: string; widget?: Widget }) {
  const bots = useStore(state => state.bots), bot = bots.find(item => item.isPrimary) ?? bots[0];
  return <div className="dashboard-empty-data"><p>{text}</p>{bot ? <button type="button" className="btn btn--secondary" onClick={() => {
    prefillComposer(bot.id, `Help me get started with ${widget?.title || widget?.type || 'this dashboard widget'}.`); openConversation(bot.id);
  }}>Ask your agent</button> : <a className="btn btn--secondary" href="#new-bot">Create a Bot</a>}</div>;
}
