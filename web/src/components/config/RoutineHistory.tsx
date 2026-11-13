import { useCallback, useEffect, useRef, useState } from 'react';
import { deliverablesApi, type Artifact, type RoutineRun } from '../../lib/deliverablesApi';
import { relativeShort } from '../../lib/time';

const statusText = (status: string) => ({ queued: 'Queued', running: 'Running', waiting: 'Waiting for reply', completed: 'Completed', failed: 'Failed', unknown: 'Needs verification', cancelled: 'Cancelled' }[status] ?? status);

export function RoutineHistory({ botId, routineId }: { botId: string; routineId?: string }) {
  const [runs, setRuns] = useState<RoutineRun[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null), [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<Artifact[]>([]);
  const identity = `${botId}:${routineId ?? ''}`, current = useRef(identity);
  current.current = identity;
  const load = useCallback(async () => {
    setLoading(true);
    try { const result = await deliverablesApi.runs(botId, routineId); if (current.current === identity) { setRuns(result.runs); setError(null); } }
    catch (e) { if (current.current === identity) setError((e as Error).message); }
    finally { if (current.current === identity) setLoading(false); }
  }, [botId, routineId, identity]);
  useEffect(() => { setRuns([]); setSelected(null); setFiles([]); void load(); }, [load]);
  useEffect(() => {
    let active = true; setFiles([]);
    if (selected) void deliverablesApi.run(selected).then((result) => { if (active) setFiles(result.artifacts); }, (e) => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [selected]);

  return <section aria-label="Routine run history">
    <div className="section-label section-label--row"><span>Run history</span>
      <button type="button" className="link-btn link-btn--small" disabled={loading} onClick={() => void load()}>Refresh</button>
    </div>
    {error && <p role="alert" className="lib-err">{error}</p>}
    <div className="panel-card">
      {!runs.length && <div className="panel-empty">{loading ? 'Loading run history…' : 'This routine has no recorded runs yet.'}</div>}
      {runs.map((run) => <div key={run.id} className="panel-row" style={{ display: 'block' }}>
        <button type="button" className="link-btn" aria-expanded={selected === run.id} onClick={() => setSelected(selected === run.id ? null : run.id)}>{run.routineName}</button>
        <div className="panel-row__meta">{statusText(run.status)} · {relativeShort(run.createdAt)} · {run.kind === 'manual' ? 'Run now' : run.kind}</div>
        {run.error && <div className="panel-row__meta">{run.error}</div>}
        {selected === run.id && <div style={{ marginTop: 8 }}>
          {files.length ? files.map((f) => <div key={f.id}><a href={f.downloadUrl} download={f.filename}>{f.filename}</a></div>) : <div className="panel-row__meta">No saved report files for this run.</div>}
        </div>}
      </div>)}
    </div>
  </section>;
}
