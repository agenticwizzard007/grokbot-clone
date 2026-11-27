import { Card } from '../layout';
import { useEffect, useRef, useState } from 'react';
import type { Bot, Routine } from '@shared/types';
import { api } from '../../lib/api';
import { configApi } from '../../lib/configApi';
import { confirmDialog } from '../../lib/confirmDialog';
import { useStore } from '../../store';
import { RoutineHistory } from './RoutineHistory';
import { openWorkChat, useWorkLifetime, workBotKey } from './workScope';

export function WorkRoutines({ bot, onReports }: { bot: Bot; onReports: () => void }) {
  const userId = useStore(state => state.user?.id);
  const connected = useStore(state => state.sseConnected);
  const stored = useStore(state => state.routines[bot.id]);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [readError, setReadError] = useState('');
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [receipt, setReceipt] = useState('');
  const [busy, setBusy] = useState(''), [revision, setRevision] = useState(0);
  const [remove, setRemove] = useState<string>(), [history, setHistory] = useState<string>();
  const pending = useRef(false);
  const lifetime = useWorkLifetime();
  const current = () => lifetime.current && !!userId && useStore.getState().user?.id === userId && workBotKey(useStore.getState().bots.find(item => item.id === bot.id)) === workBotKey(bot);
  useEffect(() => {
    if (!userId || pending.current) return;
    let live = true;
    setLoading(true);
    api.routines(bot.id).then(result => {
      if (live && current() && !pending.current) { setRoutines(result.routines.filter(routine => routine.botId === bot.id)); setReadError(''); }
    }).catch(err => { if (live && current()) setReadError(err.message); }).finally(() => { if (live && current() && !pending.current) setLoading(false); });
    return () => { live = false; };
  }, [bot.id, bot.generation, userId, connected, stored, revision, busy]);
  const mutate = async (routine: Routine, action: 'pause' | 'resume' | 'run' | 'delete') => {
    if (!current() || pending.current || loading || !routines?.find(item => item.id === routine.id)) return;
    pending.current = true; setBusy(routine.id); setReceipt(''); setError('');
    try {
      if (action === 'run') {
        await configApi.runRoutine(routine.id);
        if (current()) setReceipt('Run requested. Open run history to check the recorded status.');
      } else if (action === 'delete') {
        await configApi.deleteRoutine(routine.id);
        if (current()) { setRoutines(previous => previous?.filter(item => item.id !== routine.id) ?? null); setRemove(undefined); setReceipt('Routine deleted. Previous runs remain in history.'); }
      } else {
        const result = await configApi.setRoutine(routine.id, action === 'resume');
        if (current()) setRoutines(previous => previous?.map(item => item.id === routine.id ? result.routine : item) ?? null);
      }
    } catch (err) { if (current()) setError((err as Error).message); }
    finally { pending.current = false; if (current()) setBusy(''); }
  };
  const disabled = loading || !!busy;
  const runNow = async (routine: Routine) => {
    if (disabled || !current() || !await confirmDialog({ title: `Run ${routine.name} now?`, body: 'It runs once now. Its schedule does not change.', confirmLabel: 'Run now' })) return;
    await mutate(routine, 'run');
  };
  return <section aria-label="Routines">
    {readError && <p role="alert" className="work-error">{readError}</p>}
    {error && <p role="alert" className="work-error">{error}</p>}
    {receipt && <p role="status">{receipt}</p>}
    {!routines && loading && <p role="status">Loading routines…</p>}
    {history === undefined && <>
      {routines?.length === 0 && <p className="work-meta">No routines yet. Ask {bot.name} in chat to set one up.</p>}
      {routines?.map(routine => <article key={routine.id} className="work-row">
        <div className="work-row__body"><div><h3>{routine.name}</h3><p className="work-meta">{routine.enabled ? `${routine.description || routine.schedule}${routine.nextRunAt ? ` · Next run ${new Date(routine.nextRunAt).toLocaleString(undefined, { timeZone: routine.timezone })} ${routine.timezone}` : ' · No next run recorded'}` : 'Paused · No next run until you resume.'}</p></div>
          <label className="work-routine-toggle"><input type="checkbox" role="switch" aria-label={`${routine.name} schedule`} checked={routine.enabled} disabled={disabled || routine.activationPending} onChange={event => void mutate(routine, event.currentTarget.checked ? 'resume' : 'pause')} /> Schedule on</label>
        </div>
        {routine.activationPending && <p role="status">Updating event subscription...</p>}
        {routine.activationError && <p role="alert">{routine.activationError} <button type="button" disabled={disabled} onClick={() => void mutate(routine, (routine.activationTarget ?? !routine.enabled) ? 'resume' : 'pause')}>Retry</button></p>}
        <div className="work-actions is-stack"><button className="work-button" type="button" disabled={disabled} onClick={() => void runNow(routine)} aria-label={`Run ${routine.name} now`}>Run now</button><button className="work-button" type="button" disabled={disabled} onClick={() => setRemove(routine.id)}>Delete {routine.name}…</button><button className="work-button" type="button" onClick={() => setHistory(routine.id)}>Run history for {routine.name}</button></div>
        {remove === routine.id && <Card className="work-row"><h4>Delete {routine.name}?</h4><p className="work-meta">Future scheduled runs will stop. Existing runs and saved reports stay available.</p><div className="work-actions"><button className="work-button is-primary" type="button" disabled={disabled} onClick={() => void mutate(routine, 'delete')}>Delete routine</button><button className="work-button" type="button" disabled={!!busy} onClick={() => setRemove(undefined)}>Cancel</button></div></Card>}
      </article>)}
      <Card className="work-row"><div className="work-row__body"><div><h3>Run history</h3><p className="work-meta">Recent runs, errors and saved reports.</p></div><button className="work-button" type="button" onClick={() => setHistory('')}>Run history</button></div></Card>
      <div className="work-actions is-stack"><button className="work-button" type="button" disabled={disabled} onClick={() => setRevision(count => count + 1)}>Refresh routines</button><button className="work-button" type="button" onClick={() => openWorkChat(bot.id)}>Manage routine instructions in chat</button><button className="work-button" type="button" onClick={onReports}>Close</button></div>
    </>}
    {history !== undefined && <><RoutineHistory botId={bot.id} routineId={history || undefined} /><div className="work-actions"><button className="work-button" type="button" onClick={() => setHistory(undefined)}>Close</button></div></>}
  </section>;
}
