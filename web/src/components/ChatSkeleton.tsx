import { Page, Card } from './layout';
import { useSelectedBot } from '../store';

export function MessageSkeleton() {
  return <Card className="message-skeleton" role="status" aria-label="Loading messages"><p>Loading your chat</p>
    <span /><span /><span />
  </Card>;
}

/** Eager fallback so route chunks never hide the conversation frame. */
export function ChatSkeleton() {
  const bot = useSelectedBot();
  return <main className="chat" aria-busy="true">
    <header className="chat__header"><span className="chat__pill-name">{bot?.name || 'Chat'}</span></header>
    <div className="transcript-wrap"><div className="transcript"><Page type="chat"><MessageSkeleton /></Page></div></div>
    <div className="composer-area"><div className="composer">
      <textarea className="composer__input" aria-label="Loading composer" placeholder="Message" disabled />
    </div></div>
  </main>;
}
