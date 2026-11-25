import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, LibraryFile } from '@shared/types';
import { configApi, type LibraryListing } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { formatBytes } from './ui';
import { setupResourceText } from './setupResources';
import { SetupConnectionHelp } from './SetupConnectionHelp';

export function LibraryTab({ bot }: { bot: Bot }) {
  const userId = useStore(state => state.user?.id);
  return <ComputerLibrary key={JSON.stringify([userId, bot.id])} bot={bot} userId={userId} />;
}

function ComputerLibrary({ bot, userId }: { bot: Bot; userId?: string }) {
  const awake = useStore(state => state.computer?.status === 'running');
  const [path, setPath] = useState('');
  const [list, setList] = useState<LibraryListing | null>(null);
  const [loading, setLoading] = useState<'files' | 'wake' | null>('files');
  const [busyFile, setBusyFile] = useState('');
  const [error, setError] = useState('');
  const [downloadStatus, setDownloadStatus] = useState('');
  const version = useRef(0);
  const downloadVersion = useRef(0);
  const load = useCallback(async (wake = false) => {
    const request = ++version.current;
    const current = () => request === version.current && useStore.getState().user?.id === userId;
    setLoading(wake ? 'wake' : 'files'); setError('');
    try {
      const next = await configApi.files(bot.id, path, wake);
      if (current()) setList(next);
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) setLoading(null); }
  }, [bot.id, path, userId]);

  useEffect(() => { void load(); return () => { version.current += 1; }; }, [load, awake]);
  useEffect(() => () => { downloadVersion.current += 1; }, []);

  const navigate = (next: string) => {
    if (next === path) return;
    version.current += 1; downloadVersion.current += 1;
    setPath(next); setList(null); setLoading('files'); setError(''); setBusyFile(''); setDownloadStatus('');
  };
  const download = async (file: LibraryFile) => {
    if (busyFile) return;
    const request = ++downloadVersion.current;
    const current = () => request === downloadVersion.current && useStore.getState().user?.id === userId;
    setBusyFile(file.name); setError(''); setDownloadStatus('');
    try {
      const { url } = await configApi.downloadFile(bot.id, path ? `${path}/${file.name}` : file.name);
      if (!current()) return;
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = file.name; anchor.rel = 'noopener';
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setDownloadStatus(`Download requested: ${file.name}`);
    } catch (failure) { if (current()) setError(`Couldn’t download ${file.name}: ${(failure as Error).message}`); }
    finally { if (current()) setBusyFile(''); }
  };
  const crumbs = path ? path.split('/') : [];
  const problem = setupResourceText(error || list?.error || '');
  const visibleFiles = list?.files.filter(file => path || file.name !== 'Setup') ?? [];
  return <section className="knowledge-files" aria-label="Computer files">
    {crumbs.length > 0 && <nav className="setup-paper__tabs knowledge-files__crumbs" aria-label="File path">
      <button type="button" onClick={() => navigate('')}>Files</button>
      {crumbs.map((part, index) => <button type="button" key={index} aria-current={index === crumbs.length - 1 ? 'location' : undefined} onClick={() => navigate(crumbs.slice(0, index + 1).join('/'))}>{part}</button>)}
    </nav>}
    {loading && <p role="status">{loading === 'wake' ? 'Waking computer…' : 'Looking for files…'}</p>}
    {error && <p className="cfg-error" role="alert">{problem}</p>}
    {downloadStatus && <p role="status">{downloadStatus}</p>}
    {!loading && list?.status === 'asleep' && <div className="details-page__row"><p>{bot.name}’s computer is asleep.</p><button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void load(true)}>Wake and show files</button></div>}
    {!loading && !error && (list?.error || list?.status === 'error') && <p className="cfg-error" role="alert">{problem || 'Could not reach the computer. Refresh files to try again.'}</p>}
    {!loading && <SetupConnectionHelp text={problem} />}
    {!loading && !error && list?.status === 'ok' && !visibleFiles.length && <p>{path ? 'This folder is empty.' : 'No files yet. Files this Bot saves will appear here.'}</p>}
    {list?.status === 'ok' && visibleFiles.map(file => <div key={file.name} className="details-page__row">
      <div><strong>{file.name}</strong><p>{file.isDir ? 'Folder' : formatBytes(file.size)} · {relativeShort(file.modifiedAt)}</p></div>
      <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!file.isDir && !!busyFile} onClick={() => file.isDir ? navigate(path ? `${path}/${file.name}` : file.name) : void download(file)}>
        {file.isDir ? `Open ${file.name}` : busyFile === file.name ? 'Preparing download…' : `Download ${file.name}`}
      </button>
    </div>)}
    <div className="setup-paper__actions knowledge-files__actions">
      <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void load()} disabled={!!loading}>Refresh files</button>
    </div>
  </section>;
}
