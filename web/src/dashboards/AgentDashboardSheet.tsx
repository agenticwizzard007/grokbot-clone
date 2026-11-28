import { useEffect, useRef, useState } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { ButtonGroup, Section } from '../components/layout';
import { openConversation } from '../configStore';
import { api } from '../lib/api';
import { useStore } from '../store';
import { DashboardDialog } from './Dialog';

export function AgentDashboardSheet({ close }: { close(): void }) {
  const bots = useStore(state => state.bots).filter(bot => bot.kind !== 'room');
  const [botId, setBotId] = useState(() => (bots.find(bot => bot.isPrimary) ?? bots[0])?.id);
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), submission = useRef<{ botId: string; text: string; id: string }>();
  const bot = bots.find(item => item.id === botId);
  useEffect(() => {
    if (!bot) setBotId((bots.find(item => item.isPrimary) ?? bots[0])?.id);
  }, [bot, bots]);
  const hint = busy ? 'Sending your request...' : !bot ? 'Create a Bot to send a request.' : !text.trim() ? 'Describe the dashboard you want to create.' : '';
  return <DashboardDialog title="Create with your agent" fullScreen close={() => { if (!pending.current) close(); }}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (pending.current || !bot || !text.trim()) return;
      pending.current = true; setBusy(true); setError('');
      const accountId = useStore.getState().user?.id, message = text.trim();
      if (submission.current?.botId !== bot.id || submission.current.text !== message) submission.current = { botId: bot.id, text: message, id: crypto.randomUUID() };
      try {
        await api.send(bot.id, message, submission.current.id);
        if (useStore.getState().user?.id === accountId) { close(); openConversation(bot.id); }
      } catch { setError('Could not send your request. Try again.'); }
      finally { pending.current = false; setBusy(false); }
    }}><Section>
      <label className="dashboard-field">Request<textarea rows={3} maxLength={4000} placeholder="Make me a dashboard for..." value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label>
      <div role="radiogroup" aria-label="Bot" className="dashboard-agent-picker" onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key) || busy) return;
        event.preventDefault();
        const next = (bots.findIndex(item => item.id === botId) + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : bots.length - 1)) % bots.length;
        if (bots[next]) { setBotId(bots[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus(); }
      }}>{bots.map(item => <button key={item.id} type="button" role="radio" aria-checked={item.id === botId} aria-label={item.name} tabIndex={item.id === botId ? 0 : -1} disabled={busy} onClick={() => setBotId(item.id)}>
        <span aria-hidden="true"><BotAvatarFor bot={item} size={32} /></span><span>{item.name}</span>
      </button>)}</div>
      {hint && <p id="dashboard-agent-hint" role="status">{hint}</p>}
      {error && <p role="alert">{error}</p>}
      <ButtonGroup><button type="submit" className="btn btn--primary" disabled={busy || !bot || !text.trim()} aria-describedby={hint ? 'dashboard-agent-hint' : undefined}>{bot ? `Send to ${bot.name}` : 'Send request'}</button></ButtonGroup>
    </Section></form>
  </DashboardDialog>;
}
