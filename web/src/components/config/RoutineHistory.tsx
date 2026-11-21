import { useEffect, useState } from 'react';
import { deliverablesApi, type Artifact, type RoutineRun } from '../../lib/deliverablesApi';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { workBotKey } from './workScope';
import './workArea.css';

const statusText = (status: RoutineRun['status']) => ({ queued: 'Queued', running: 'Running', waiting: 'Waiting for reply', completed: 'Completed', failed: 'Failed', unknown: 'Needs verification', cancelled: 'Cancelled' })[status];

export function RoutineHistory({ botId, routineId }: { botId: string; routineId?: string }) {
  const user = useStore(state => state.user?.id);
  const bot = useStore(state => state.bots.find(item => item.id === botId));
  return <RunHistory key={`${user}:${workBotKey(bot)}:${routineId ?? ''}`} botId={botId} routineId={routineId} user={user} />;
}

function RunHistory({ botId, routineId, user }: { botId: string; routineId?: string; user?: string }) {
  const [runs, setRuns] = useState<RoutineRun[] | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [selected, setSelected] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && useStore.getState().user?.id === user;
    setLoading(true); setError('');
    deliverablesApi.runs(botId, routineId, controller.signal).then(result => {
      if (current()) setRuns(result.runs.filter(run => run.botId === botId && (!routineId || run.routineId === routineId)));
    }).catch(err => { if (current()) setError(err.message); }).finally(() => { if (current()) setLoading(false); });
    return () => controller.abort();
  }, [botId, routineId, revision, user]);
  return <section className="work-ui routine-history" aria-label="Routine run history">
    <h2 className="work-title">Run history</h2>
    {error && <p role="alert" className="work-error">{runs ? 'Could not refresh. Showing the last loaded runs. ' : ''}{error}</p>}
    {!runs && loading && <p role="status">Loading run history…</p>}
    {runs?.length === 0 && <p className="work-meta">No recorded runs yet.</p>}
    {runs?.map(run => <article key={run.id} className="work-row">
      <div className="work-row__body"><div><h3>{run.routineName}</h3><p className="work-meta">{statusText(run.status)} · {relativeShort(run.createdAt)} · {run.kind === 'manual' ? 'Run now' : run.kind}</p>{run.error && <p className="work-meta">{run.error}</p>}</div><button type="button" className="work-button" aria-expanded={selected === run.id} onClick={() => setSelected(selected === run.id ? undefined : run.id)}>Run details</button></div>
      {selected === run.id && <RunFiles botId={botId} id={run.id} />}
    </article>)}
    <div className="work-actions"><button className="work-button" type="button" disabled={loading} onClick={() => setRevision(count => count + 1)}>Refresh run history</button></div>
  </section>;
}

function RunFiles({ botId, id }: { botId: string; id: string }) {
  const [files, setFiles] = useState<Artifact[] | null>(null), [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    deliverablesApi.run(id, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.run.id !== id || result.run.botId !== botId) throw new Error('The run does not belong to this bot.');
      setFiles(result.artifacts.filter(file => file.botId === botId));
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [id, botId, revision]);
  return <div className="work-actions">{error && <p role="alert" className="work-error">{error} <button type="button" className="work-button" onClick={() => setRevision(count => count + 1)}>Retry run details</button></p>}
    {!files && !error && <p role="status">Loading saved run files…</p>}
    {files?.length === 0 && <p className="work-meta">No saved report files for this run.</p>}
    {files?.map(file => <a key={file.id} href={file.downloadUrl} className="work-button" download={file.filename}>{file.filename}</a>)}
  </div>;
}
