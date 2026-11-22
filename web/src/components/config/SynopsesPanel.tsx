import { useEffect, useRef, useState, type FormEvent } from 'react';
import { synopsisApi, type SynopsisDetail, type SynopsisRecord, type SynopsisSettings, type SynopsisSource } from '../../lib/workApi';
import { useStore } from '../../store';
import { useWorkLifetime, workBotKey } from './workScope';
import './workArea.css';
import './SynopsesPanel.css';

interface Props { onUpdated?: () => void; onReports?: () => void; workspace?: boolean }
const savedFile = (id: string) => `/api/deliverables/artifacts/${encodeURIComponent(id)}/download`;
const correctTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
/** R2F-036: plain names for the team records a synopsis reads (SynopsisSource.kind). */
const SOURCE_NAMES: Record<string, string> = {
  routine: 'routines', run: 'routine runs', coworker: 'Bot setups', workflow: 'workflows', task: 'workflow tasks', goal: 'goals', job: 'jobs',
  artifact: 'saved reports', delivery: 'deliveries', request: 'team requests', decision: 'decisions waiting on you', learning: 'learning',
};
export function synopsisSourceText(sources: Pick<SynopsisSource, 'kind'>[]): string {
  const names = [...new Set(sources.map(source => SOURCE_NAMES[source.kind] ?? source.kind.replaceAll('_', ' ')))].slice(0, 4);
  if (!names.length) return 'from your team’s records';
  return `from your team’s ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}`;
}
const timezoneOf = (user: unknown) => (user as { timezone?: string | null } | null)?.timezone ?? null;

export function SynopsesPanel(props: Props) {
  const account = useStore(state => state.user?.id);
  const primary = useStore(state => state.bots.find(bot => bot.isPrimary && bot.kind !== 'room'));
  return <SynopsesSurface key={`${account}:${workBotKey(primary)}`} {...props} account={account} primaryKey={workBotKey(primary)} />;
}

function SynopsesSurface({ onUpdated, onReports, workspace, account, primaryKey }: Props & { account?: string; primaryKey: string }) {
  const [settings, setSettings] = useState<SynopsisSettings | null>(null);
  const [page, setPage] = useState<Awaited<ReturnType<typeof synopsisApi.list>> | null>(null);
  const [edit, setEdit] = useState(false), [saving, setSaving] = useState(false), [loading, setLoading] = useState(true);
  const [readErrors, setReadErrors] = useState<string[]>([]), [actionError, setActionError] = useState(''), [receipt, setReceipt] = useState('');
  const [revision, setRevision] = useState(0);
  // R2F-017: a time zone change (Settings > Account here, or any tab after the store reloads the account) refreshes the line.
  const accountZone = useStore(state => timezoneOf(state.user));
  const [sources, setSources] = useState<SynopsisSource[] | null>(null);
  const lifetime = useWorkLifetime();
  const pending = useRef(false);
  const activePage = useRef<AbortController>();
  const current = () => lifetime.current && useStore.getState().user?.id === account && workBotKey(useStore.getState().bots.find(bot => bot.isPrimary && bot.kind !== 'room')) === primaryKey;
  useEffect(() => {
    if (!account || !primaryKey || pending.current) return;
    const controller = new AbortController();
    activePage.current?.abort(); activePage.current = controller;
    setLoading(true);
    Promise.allSettled([synopsisApi.settings(controller.signal), synopsisApi.list(0, controller.signal)]).then(([prefs, history]) => {
      if (controller.signal.aborted || pending.current || !current()) return;
      if (prefs.status === 'fulfilled') setSettings(prefs.value);
      if (history.status === 'fulfilled') setPage(history.value);
      setReadErrors([prefs, history].flatMap(result => result.status === 'rejected' ? [(result.reason as Error).message] : []));
      setLoading(false);
    });
    return () => { controller.abort(); activePage.current?.abort(); };
  }, [account, primaryKey, revision, accountZone]);
  // R2F-036: the schedule line names what the latest synopsis was made from.
  const latestId = page?.reports.find(report => report.sourceCount > 0)?.id;
  useEffect(() => {
    if (!latestId) { setSources(null); return; }
    const controller = new AbortController();
    synopsisApi.sources(latestId, 0, controller.signal).then(result => { if (!controller.signal.aborted && current()) setSources(result.sources); }).catch(() => { if (!controller.signal.aborted) setSources(null); });
    return () => controller.abort();
  }, [latestId]);
  const update = async <Result,>(run: () => Promise<Result>, applied: (result: Result) => void, refresh = true) => {
    if (!account || !primaryKey || !current() || pending.current || loading) return;
    pending.current = true; setSaving(true); setActionError(''); setReceipt('');
    try {
      const result = await run();
      if (current()) { applied(result); onUpdated?.(); }
    } catch (err) { if (current()) setActionError((err as Error).message); }
    finally {
      pending.current = false;
      if (current()) { setSaving(false); if (refresh) setRevision(count => count + 1); }
    }
  };
  const older = async () => {
    if (!page?.hasMore || loading || saving) return;
    const controller = new AbortController();
    activePage.current?.abort(); activePage.current = controller;
    setLoading(true); setActionError('');
    try { const next = await synopsisApi.list(page.nextCursor, controller.signal); if (!controller.signal.aborted && current()) setPage({ ...next, reports: [...page.reports, ...next.reports] }); }
    catch (err) { if (!controller.signal.aborted && current()) setActionError((err as Error).message); }
    finally { if (!controller.signal.aborted && current()) setLoading(false); }
  };
  const disabled = loading || saving;
  return <section aria-label="Daily synopses" className="work-ui synopsis-panel">
    {!workspace && <h2 className="work-title">Daily synopses</h2>}
    {readErrors.map((message, index) => <p key={index} role="alert" className="work-error">{message}</p>)}
    {actionError && <p role="alert" className="work-error">{actionError}</p>}
    {receipt && <p role="status">{receipt}</p>}
    {!settings && loading && <p role="status">Loading synopsis schedule…</p>}
    {settings && <div className="work-row synopsis-schedule">
      <div className="work-row__body"><div><label className="workflow-checkbox"><input type="checkbox" checked={settings.enabled} disabled={disabled || edit} onChange={event => { const enabled = event.currentTarget.checked; void update(() => synopsisApi.save({ enabled }), setSettings, false); }} /> Scheduled daily synopsis</label>
        <p className="work-meta">{settings.enabled ? 'Scheduled' : 'Paused'} · {settings.times.length ? settings.times.join(', ') : 'No times selected'} · {settings.timezone}{settings.timezoneSource === 'utc_fallback' ? ' (UTC fallback: account timezone unavailable)' : ''}{settings.quietHours.length ? ` · quiet hours ${settings.quietHours.map(range => `${range.start}–${range.end}`).join(', ')}` : ''} · <span className="synopsis-source">{synopsisSourceText(sources ?? [])}</span>. Saved in Library.</p>
      </div><button className="work-button" type="button" disabled={disabled} aria-expanded={edit} onClick={() => setEdit(!edit)}>Edit schedule</button></div>
      {edit && <ScheduleForm settings={settings} disabled={disabled} cancel={() => setEdit(false)} save={input => void update(() => synopsisApi.save(input), saved => { setSettings(saved); setEdit(false); setReceipt('Synopsis schedule saved.'); }, false)} />}
    </div>}
    {!page && loading && <p role="status">Loading synopsis history…</p>}
    {page?.reports.length === 0 && <div className="work-row"><p className="work-meta">No daily synopses have been recorded yet.</p></div>}
    {page?.reports.map(report => <SynopsisRow key={report.id} report={report} disabled={disabled} onReports={onReports} onRetry={() => void update(() => synopsisApi.retry(report.id), () => {})} />)}
    {page?.hasMore && <div className="work-row"><div className="work-row__body"><div><h3>Older history</h3><p className="work-meta">Load the next page of summaries.</p></div><button className="work-button" type="button" disabled={disabled} onClick={() => void older()}>Load more synopses</button></div></div>}
    <div className="work-actions is-stack">
      <button type="button" className="work-button is-primary" disabled={disabled || !settings} onClick={() => void update(synopsisApi.request, () => setReceipt('Synopsis requested. Refresh to check when it’s saved.'))}>Prepare today’s synopsis</button>
      <button type="button" className="work-button" disabled={disabled} onClick={() => { setActionError(''); setRevision(count => count + 1); }}>Refresh synopses</button>
      {onReports && <button type="button" className="work-button" onClick={onReports}>Back to saved reports</button>}
    </div>
  </section>;
}

function ScheduleForm({ settings, disabled, cancel, save }: { settings: SynopsisSettings; disabled: boolean; cancel: () => void; save: (settings: Partial<Omit<SynopsisSettings, 'timezoneSource'>>) => void }) {
  const [times, setTimes] = useState(settings.times), [timezone, setTimezone] = useState(settings.timezone), [quiet, setQuiet] = useState(settings.quietHours);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (times.some(time => !correctTime(time)) || quiet.some(range => !correctTime(range.start) || !correctTime(range.end))) { setError('Enter valid times from 00:00 to 23:59.'); return; }
    const zone = timezone.trim();
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); }
    catch { setError('Enter a valid timezone, such as America/New_York or UTC.'); return; }
    save({ times, quietHours: quiet, ...(zone !== settings.timezone ? { timezone: zone } : {}) });
  };
  return <form className="work-form" onSubmit={submit}>
    <fieldset><legend>Schedule times</legend>{times.map((time, index) => <div className="synopsis-time-row" key={index}>
      <label className="work-field">Schedule time {index + 1}<input type="time" required value={time} onChange={event => { const value = event.currentTarget.value; setTimes(current => current.map((slot, position) => position === index ? value : slot)); }} /></label>
      <button className="work-button" type="button" aria-label={`Remove schedule time ${index + 1}`} disabled={disabled} onClick={() => setTimes(current => current.filter((_, position) => position !== index))}>Remove</button>
    </div>)}<button className="work-button" type="button" disabled={disabled || times.length >= 6} onClick={() => setTimes(current => [...current, ''])}>Add schedule time</button></fieldset>
    <label className="work-field">Timezone<input type="text" required maxLength={100} placeholder="America/New_York" value={timezone} onChange={event => setTimezone(event.currentTarget.value)} /><small>Use a timezone name such as America/New_York or UTC. When no account timezone is available, the schedule uses UTC until you change it.</small></label>
    <fieldset><legend>Quiet hours</legend><p className="work-meta">Use local times. A range can continue overnight.</p>
      {quiet.map((range, index) => <div className="synopsis-time-row" key={index}>
        {(['start', 'end'] as const).map(edge => <label className="work-field" key={edge}>Quiet hours {index + 1} {edge}<input type="time" required value={range[edge]} onChange={event => { const value = event.currentTarget.value; setQuiet(current => current.map((entry, position) => position === index ? { ...entry, [edge]: value } : entry)); }} /></label>)}
        <button className="work-button" type="button" aria-label={`Remove quiet hours ${index + 1}`} disabled={disabled} onClick={() => setQuiet(current => current.filter((_, position) => position !== index))}>Remove</button>
      </div>)}
      <button className="work-button" type="button" disabled={disabled || quiet.length >= 6} onClick={() => setQuiet(current => [...current, { start: '', end: '' }])}>Add quiet hours</button></fieldset>
    {error && <p className="work-error" role="alert">{error}</p>}
    <div className="work-actions is-stack"><button className="work-button is-primary" type="submit" disabled={disabled}>Save schedule</button><button className="work-button" type="button" disabled={disabled} onClick={cancel}>Cancel</button></div>
  </form>;
}

function SynopsisRow({ report, disabled, onReports, onRetry }: { report: SynopsisRecord; disabled: boolean; onReports?: () => void; onRetry: () => void }) {
  const [open, setOpen] = useState(false), [gaps, setGaps] = useState(false);
  const status = report.delivery?.status;
  const delivered = status === 'delivered' && report.delivery?.channel === 'library';
  return <article className="work-row"><div className="work-row__body"><div>
    <h3>{report.slotKey.startsWith('manual:') ? 'Requested synopsis' : `${report.slotKey} · ${report.timezone}`}</h3>
    <p className="work-meta">{report.slotCount > 1 ? `Catch-up for ${report.slotCount} slots · ` : ''}Coverage through {new Date(report.windowEnd).toLocaleString()} · {report.sourceCount} observations{!report.coverage.summaryComplete ? ` · Partial summary; ${report.coverage.pages} source pages` : ''}.</p>
    <p className="work-meta">{delivered ? 'Saved in Library' : status === 'delivered' ? 'Delivery acknowledged' : status === 'unknown' ? 'Send outcome unknown: verify in Saved reports' : status === 'failed' ? 'Not sent' : report.status === 'preparing' ? 'Preparing factual report' : status ?? 'Waiting to save'}</p>
    </div>{report.artifactId && <button className="work-button" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Read synopsis and source pages</button>}</div>
    {open && <SynopsisSources id={report.id} />}
    <div className="work-actions">
      {status === 'failed' && <button type="button" className="work-button" disabled={disabled} onClick={onRetry}>Retry original saved report</button>}
      {status === 'unknown' && onReports && <button type="button" className="work-button" onClick={onReports}>Saved reports</button>}
      {(report.gaps.length > 0 || report.lastError) && <button type="button" className="work-button" aria-expanded={gaps} onClick={() => setGaps(!gaps)}>Coverage observations</button>}
    </div>
    {gaps && <div>{report.gaps.map((message, index) => <p key={index} className="work-meta">{message}</p>)}{report.lastError && <p className="work-error">{report.lastError}</p>}</div>}
  </article>;
}

function SynopsisSources({ id }: { id: string }) {
  const [report, setReport] = useState<SynopsisDetail>(), [records, setRecords] = useState<SynopsisSource[]>([]);
  const [cursor, setCursor] = useState(0), [more, setMore] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const pending = useRef<AbortController>();
  useEffect(() => {
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError('');
    Promise.all([synopsisApi.report(id, controller.signal), synopsisApi.sources(id, 0, controller.signal)]).then(([detail, page]) => {
      if (controller.signal.aborted) return;
      setReport(detail.report); setRecords(page.sources); setCursor(page.nextCursor); setMore(page.hasMore);
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => pending.current?.abort();
  }, [id, revision]);
  const next = async () => {
    if (busy) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError('');
    try { const page = await synopsisApi.sources(id, cursor, controller.signal); if (!controller.signal.aborted) { setRecords(previous => [...previous, ...page.sources]); setCursor(page.nextCursor); setMore(page.hasMore); } }
    catch (err) { if (!controller.signal.aborted) setError((err as Error).message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <div className="work-stack synopsis-detail">
    {busy && <p role="status">Loading synopsis sources…</p>}
    {error && <p className="work-error" role="alert">{error} <button type="button" className="work-button" onClick={() => setRevision(count => count + 1)}>Retry sources</button></p>}
    {report?.content && <pre>{report.content}</pre>}
    {report?.artifactId && <a className="work-button" href={savedFile(report.artifactId)} download>Download synopsis</a>}
    {report?.pages.map(page => <a key={page.page} href={savedFile(page.artifactId)} download>Download source page {page.page}</a>)}
    {records.map(source => <div key={source.ordinal}><strong>{source.title}</strong><p className="work-meta">{source.owner} · {source.kind} · {source.state}{source.changed ? ' · Changed' : ''}</p>{source.details && <p className="work-meta">{source.details}</p>}</div>)}
    {report && !records.length && <p className="work-meta">No source records were saved for this synopsis.</p>}
    {more && <button className="work-button" type="button" disabled={busy} onClick={() => void next()}>Load more sources</button>}
  </div>;
}
