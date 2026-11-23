import { useSelectedBot } from '../store';

export function MessageSkeleton() {
  return <div className="message-skeleton" role="status" aria-label="Loading messages">
    <span /><span /><span />
  </div>;
}

/** Eager fallback so route chunks never hide the conversation frame. */
export function ChatSkeleton() {
  const bot = useSelectedBot();
  return <main className="chat" aria-busy="true">
    <header className="chat__header"><span className="chat__pill-name">{bot?.name || 'Chat'}</span></header>
    <div className="transcript-wrap"><div className="transcript"><div className="transcript__col"><MessageSkeleton /></div></div></div>
    <div className="composer-area"><div className="composer">
      <textarea className="composer__input" aria-label="Loading composer" placeholder="Message" disabled />
    </div></div>
  </main>;
}
