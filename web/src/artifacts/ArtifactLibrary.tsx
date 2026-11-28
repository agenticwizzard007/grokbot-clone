import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Boxes, Search, LayoutGrid, List, RefreshCw, Share2, MessageSquare, Users, Lock, X } from 'lucide-react';
import { artifactApi, type CollaborativeArtifact } from './api';
import { artifactKind, artifactTitle, initials } from './presentation';
import { ArtifactDialog } from './ArtifactViewer';
import { relativeShort } from '../lib/time';
import { formatBytes } from '../components/config/ui';
import './artifacts.css';

export function ArtifactLibrary({ botId }: { botId?: string }) {
  const [files, setFiles] = useState<CollaborativeArtifact[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [owner, setOwner] = useState('all');
  const [scope, setScope] = useState<'all' | 'shared'>('all');
  const [sort, setSort] = useState('recent'), [view, setView] = useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = useState<{ id: string; tab: 'preview' | 'discussion' | 'sharing' }>();
  const read = useRef<AbortController>();
  const load = useCallback(async () => {
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    setLoading(true); setError('');
    try {
      // Fetch all pages so search, type and team filters cover the entire library.
      let items: CollaborativeArtifact[] = [], total = 0;
      do {
        const result = await artifactApi.library(botId, items.length, controller.signal);
        total = result.total; items = [...items, ...result.artifacts];
        if (!result.artifacts.length) break;
      } while (items.length < total && !controller.signal.aborted);
      if (!controller.signal.aborted) setFiles([...new Map(items.map(file => [file.id, file])).values()]);
    } catch (err) { if (!controller.signal.aborted) setError((err as Error).message); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [botId]);
  useEffect(() => { setFiles([]); void load(); return () => read.current?.abort(); }, [load]);
  const bots = useMemo(() => [...new Map(files.map(file => [file.botId, file.botName])).entries()], [files]);
  const filtered = useMemo(() => files.filter(file =>
    (scope === 'all' || file.role !== 'owner') && (kind === 'all' || artifactKind(file.filename).key === kind) &&
    (owner === 'all' || file.botId === owner) && `${file.filename} ${file.botName} ${file.ownerName}`.toLowerCase().includes(query.toLowerCase().trim())
  ).sort((a, b) => sort === 'name' ? a.filename.localeCompare(b.filename) : sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt), [files, query, kind, owner, scope, sort]);
  const shared = files.filter(file => file.role !== 'owner').length;
  const filtering = !!query || kind !== 'all' || owner !== 'all' || scope !== 'all';
  const clear = () => { setQuery(''); setKind('all'); setOwner('all'); setScope('all'); };
  return <section className="artifact-library" aria-label="Artifact library">
    <div className="artifact-intro">
      <div className="artifact-intro__icon"><Boxes size={25} aria-hidden /></div>
      <div><h2>Good work deserves a shared space.</h2><p>Explore what your bots create. Share with your team and shape what comes next.</p></div>
      <span className="artifact-intro__badge"><Users size={14} aria-hidden /> Built for collaboration</span>
    </div>
    <div className="artifact-collection-bar">
      <div className="artifact-collections" role="group" aria-label="Artifact collection">
        <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All artifacts <span>{loading ? '…' : files.length}</span></button>
        <button type="button" aria-pressed={scope === 'shared'} onClick={() => setScope('shared')}><Users size={15} aria-hidden /> Shared with me <span>{loading ? '…' : shared}</span></button>
      </div>
      <button className="artifact-icon-button" type="button" aria-label="Refresh artifacts" disabled={loading} onClick={() => void load()}><RefreshCw size={17} className={loading ? 'artifact-spinning' : ''} aria-hidden /></button>
    </div>
    <div className="artifact-toolbar">
      <label className="artifact-search"><Search size={17} aria-hidden /><input aria-label="Search artifacts" placeholder="Search artifacts, bots, or people…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={15} aria-hidden /></button>}</label>
      <select aria-label="Artifact type" value={kind} onChange={event => setKind(event.target.value)}><option value="all">All types</option><option value="web">Web pages</option><option value="document">Documents</option><option value="data">Spreadsheets</option><option value="code">Code</option><option value="image">Images</option><option value="file">Other files</option></select>
      {!botId && <select aria-label="Created by bot" value={owner} onChange={event => setOwner(event.target.value)}><option value="all">All bots</option>{bots.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>}
      <div className="artifact-view-toggle" role="group" aria-label="Artifact view"><button type="button" aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><LayoutGrid size={17} aria-hidden /></button><button type="button" aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={18} aria-hidden /></button></div>
    </div>
    <div className="artifact-results-bar"><p role="status">{loading ? 'Loading your library…' : `${filtered.length} ${filtered.length === 1 ? 'artifact' : 'artifacts'}${filtering ? ' found' : ' in your library'}`}</p><label><span className="sr-only">Sort artifacts</span><select value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Newest first</option><option value="oldest">Oldest first</option><option value="name">Name A–Z</option></select></label></div>
    {error && <div className="artifact-error" role="alert"><p>{error}</p><button className="artifact-button" type="button" onClick={() => void load()}>Try again</button></div>}
    {loading && !files.length ? <div className="artifact-grid" aria-hidden>{[1, 2, 3].map(i => <div className="artifact-skeleton" key={i} />)}</div> : !error && !filtered.length ? <div className="artifact-empty"><div className="artifact-intro__icon">{filtering ? <Search size={26} /> : <Boxes size={30} />}</div><h3>{filtering ? 'No artifacts match this view' : 'Your next great idea starts here'}</h3><p>{scope === 'shared' ? 'Artifacts shared with your account will appear here. Ask a teammate to add your email to an artifact.' : filtering ? 'Try another search or clear your filters to explore the library.' : 'Ask a bot to create a report, a web page, or a spreadsheet. Saved work appears here, ready to preview and share.'}</p>{filtering && <button type="button" className="artifact-button" onClick={clear}>Clear filters</button>}</div> : <div className={`artifact-grid${view === 'list' ? ' is-list' : ''}`}>
      {filtered.map(file => {
        const type = artifactKind(file.filename), Icon = type.Icon;
        return <article className="artifact-card" key={file.id}>
          <button type="button" className={`artifact-card__preview artifact-tone-${type.key}`} aria-label={`Preview ${file.filename}`} onClick={() => setSelected({ id: file.id, tab: 'preview' })}>
            <span className="artifact-card__type">{type.extension || 'FILE'}</span><Icon size={38} strokeWidth={1.3} aria-hidden /><span className="artifact-card__preview-label">{type.label}</span><ArrowUpRight size={17} className="artifact-card__open" aria-hidden />
          </button>
          <div className="artifact-card__body"><div className="artifact-card__title-row"><button type="button" className="artifact-card__title" onClick={() => setSelected({ id: file.id, tab: 'preview' })} title={file.filename}>{artifactTitle(file.filename)}</button></div>
            <p className="artifact-card__filename" title={file.filename}>{file.filename}</p>
            <div className="artifact-card__creator"><span className="artifact-avatar">{initials(file.botName)}</span><span title={file.botName}>{file.botName}</span><time dateTime={new Date(file.createdAt).toISOString()} title={new Date(file.createdAt).toLocaleString()}>{relativeShort(file.createdAt)}</time></div>
          </div>
          <div className="artifact-card__footer"><span className="artifact-access">{file.memberCount ? <Users size={13} aria-hidden /> : <Lock size={13} aria-hidden />}{file.role !== 'owner' ? 'Shared with you' : file.memberCount ? `${file.memberCount + 1} people` : 'Only you'}</span><span className="artifact-card__size">{formatBytes(file.size)}</span>
            <button type="button" className="artifact-icon-button" aria-label={`Discuss ${file.filename}`} onClick={() => setSelected({ id: file.id, tab: 'discussion' })}><MessageSquare size={15} aria-hidden />{file.commentCount > 0 && <span>{file.commentCount}</span>}</button>
            <button type="button" className="artifact-icon-button" aria-label={`${file.role === 'owner' ? 'Share' : 'Access to'} ${file.filename}`} onClick={() => setSelected({ id: file.id, tab: 'sharing' })}><Share2 size={15} aria-hidden /></button>
          </div>
        </article>;
      })}
    </div>}
    {selected && <ArtifactDialog id={selected.id} initialTab={selected.tab} onClose={() => { setSelected(undefined); void load(); }} />}
  </section>;
}
