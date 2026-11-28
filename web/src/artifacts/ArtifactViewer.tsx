import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Check, Copy, Download, FileQuestion, Lock, MessageSquare, RefreshCw, Send, Share2, Users, X } from 'lucide-react';
import { artifactApi, artifactUrl, type ArtifactDetail } from './api';
import { artifactKind, artifactTitle, initials } from './presentation';
import { formatBytes } from '../components/config/ui';
import { DeliverablesPanel } from '../components/config/DeliverablesPanel';
import { ApiError } from '../lib/api';
import { useStore } from '../store';
import './artifacts.css';

type Tab = 'preview' | 'discussion' | 'sharing';
export function ArtifactDialog({ id, initialTab, onClose }: { id: string; initialTab: Tab; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  return createPortal(<dialog className="artifact-dialog" ref={dialog} aria-label="Artifact details" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <ArtifactViewer id={id} initialTab={initialTab} onClose={onClose} />
  </dialog>, document.body);
}
export function ArtifactPage({ id }: { id: string }) {
  useEffect(() => { void useStore.getState().loadBots().catch(() => {}); }, []);
  return <main className="artifact-page"><a className="artifact-back" href="/#reports"><ArrowLeft size={17} aria-hidden /> Back to artifacts</a><ArtifactViewer id={id} /></main>;
}
function ArtifactViewer({ id, initialTab = 'preview', onClose }: { id: string; initialTab?: Tab; onClose?: () => void }) {
  const userId = useStore(state => state.user?.id);
  const [detail, setDetail] = useState<ArtifactDetail>();
  const [content, setContent] = useState<string | null>(), [contentError, setContentError] = useState('');
  const [tab, setTab] = useState<Tab>(initialTab), [source, setSource] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [draft, setDraft] = useState(''), [email, setEmail] = useState(''), [role, setRole] = useState<'viewer' | 'commenter'>('commenter');
  const [delivery, setDelivery] = useState(false), [imageUrl, setImageUrl] = useState('');
  const [revision, setRevision] = useState(0);
  const active = useRef(true), mutation = useRef(false), requestId = useRef(crypto.randomUUID());
  const current = () => active.current && useStore.getState().user?.id === userId;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const value = await artifactApi.detail(id, signal);
      if (!signal.aborted) { setDetail(value); setError(''); }
    } catch (err) {
      if (!signal.aborted) {
        setError((err as Error).message);
        if (err instanceof ApiError && [401, 404].includes(err.status)) { setDetail(undefined); setContent(undefined); setImageUrl(''); }
      }
    }
  }, [id]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(controller.signal); }, 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setContent(undefined); setContentError('');
    void artifactApi.content(id, controller.signal).then(value => { if (!controller.signal.aborted) setContent(value.text); })
      .catch(err => { if (!controller.signal.aborted) setContentError((err as Error).message); });
    return () => controller.abort();
  }, [id, revision]);
  const filename = detail?.artifact.filename;
  useEffect(() => {
    if (!filename || !/\.(png|jpe?g|gif|webp)$/i.test(filename)) return;
    const controller = new AbortController(); let objectUrl = '';
    void fetch(`/api/deliverables/artifacts/${encodeURIComponent(id)}/download`, { credentials: 'include', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Image preview is unavailable.');
      const blob = await response.blob();
      if (!controller.signal.aborted) {
        objectUrl = URL.createObjectURL(new Blob([blob], { type: `image/${/\.jpe?g$/i.test(filename) ? 'jpeg' : filename.split('.').pop()!.toLowerCase()}` }));
        setImageUrl(objectUrl);
      }
    }).catch(err => { if (!controller.signal.aborted) setContentError((err as Error).message); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, filename, revision]);
  const mutate = async (work: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (err) { if (current()) setError((err as Error).message); }
    finally { mutation.current = false; if (current()) setBusy(false); }
  };
  const changeMember = (address: string, permission: 'viewer' | 'commenter' | 'remove') => mutate(async () => {
    const result = await artifactApi.member(id, address, permission);
    if (current()) {
      setDetail(previous => previous && ({ ...previous, members: result.members, artifact: { ...previous.artifact, memberCount: result.members.length - 1 } }));
      setEmail(''); setNotice(permission === 'remove' ? 'Access removed.' : 'Access updated. Copy the link to share it with your teammate.');
    }
  });
  const copy = async () => {
    try { await navigator.clipboard.writeText(artifactUrl(id)); if (current()) setNotice('Link copied. Only people with access can open it.'); }
    catch { if (current()) setNotice('Select and copy the link below.'); }
  };
  const postComment = () => mutate(async () => {
    const result = await artifactApi.comment(id, draft.trim(), requestId.current);
    if (current()) { setDetail(previous => previous && ({ ...previous, comments: result.comments })); setDraft(''); requestId.current = crypto.randomUUID(); setNotice('Comment added.'); }
  });
  if (!detail) return <div className="artifact-viewer artifact-viewer--loading">{onClose && <button className="artifact-icon-button artifact-close" type="button" aria-label="Close artifact" onClick={onClose}><X size={20} /></button>}{error ? <div className="artifact-empty"><Lock size={32} aria-hidden /><h2>Artifact unavailable</h2><p role="alert">{error}</p><p>Sign in with the email the owner added, or ask them to share this artifact with you.</p><button className="artifact-button" type="button" onClick={() => setRevision(value => value + 1)}>Try again</button></div> : <p role="status">Loading artifact…</p>}</div>;
  const { artifact, members, comments } = detail;
  const type = artifactKind(artifact.filename), Icon = type.Icon;
  const isOwner = artifact.role === 'owner';
  const html = /\.html?$/i.test(artifact.filename), markdown = /\.md$/i.test(artifact.filename);
  return <div className="artifact-viewer">
    <header className="artifact-viewer__header"><span className={`artifact-file-icon artifact-tone-${type.key}`}><Icon size={24} aria-hidden /></span><div><p className="artifact-eyebrow">{type.label} · {formatBytes(artifact.size)}</p><h2>{artifactTitle(artifact.filename)}</h2><p className="artifact-viewer__filename">{artifact.filename}</p></div><div className="artifact-viewer__actions"><a className="artifact-button" href={artifact.downloadUrl} download={artifact.filename}><Download size={16} aria-hidden /><span>Download</span></a><button className="artifact-button is-primary" type="button" onClick={() => setTab('sharing')}><Share2 size={16} aria-hidden />{isOwner ? 'Share' : 'Access'}</button>{onClose && <button type="button" className="artifact-icon-button" aria-label="Close artifact" onClick={onClose}><X size={20} aria-hidden /></button>}</div></header>
    <div className="artifact-viewer__meta"><span className="artifact-avatar">{initials(artifact.botName)}</span><span>Created by <strong>{artifact.botName}</strong></span><span>·</span><time dateTime={new Date(artifact.createdAt).toISOString()}>{new Date(artifact.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time><span className="artifact-meta-access">{members.length > 1 ? <Users size={14} aria-hidden /> : <Lock size={14} aria-hidden />}{members.length > 1 ? `Shared with ${members.length - 1} ${members.length === 2 ? 'teammate' : 'teammates'}` : 'Only you'}</span></div>
    <div className="artifact-tabs-row"><div className="artifact-viewer__tabs" role="tablist" aria-label="Artifact sections" onKeyDown={event => {
      const tabs: Tab[] = ['preview', 'discussion', 'sharing'];
      const next = event.key === 'ArrowRight' ? tabs[(tabs.indexOf(tab) + 1) % 3] : event.key === 'ArrowLeft' ? tabs[(tabs.indexOf(tab) + 2) % 3] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : null;
      if (next) { event.preventDefault(); setTab(next); document.getElementById(`artifact-tab-${id}-${next}`)?.focus(); }
    }}>{(['preview', 'discussion', 'sharing'] as const).map(value => <button role="tab" type="button" key={value} id={`artifact-tab-${id}-${value}`} aria-controls={`artifact-panel-${id}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => { setTab(value); setNotice(''); }}>{value === 'preview' ? 'Preview' : value === 'discussion' ? <>Discussion <span>{comments.length}</span></> : <><Users size={15} aria-hidden /> Sharing</>}</button>)}</div><button className="artifact-icon-button" type="button" aria-label="Refresh artifact" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} aria-hidden /></button></div>
    {error && <p className="artifact-error" role="alert">{error}</p>}
    {notice && <p className="artifact-notice" role="status"><Check size={15} aria-hidden />{notice}</p>}
    <div className="artifact-viewer__content" role="tabpanel" id={`artifact-panel-${id}`} aria-labelledby={`artifact-tab-${id}-${tab}`} tabIndex={0}>
      {tab === 'preview' && <>
        <div className="artifact-preview-toolbar"><span>{source ? 'Source' : 'Artifact preview'}</span>{content != null && (html || markdown) && <button type="button" aria-pressed={source} className="artifact-button" onClick={() => setSource(value => !value)}>{source ? 'Show preview' : 'View source'}</button>}</div>
        {contentError ? <p className="artifact-error" role="alert">{contentError}</p> : imageUrl ? <div className="artifact-image-preview"><img src={imageUrl} alt={artifact.filename} /></div> : content === undefined ? <p className="artifact-preview-loading" role="status">Loading preview…</p> : content === null ? <div className="artifact-empty"><FileQuestion size={38} aria-hidden /><h3>Ready to download</h3><p>A preview isn’t available for this format or for text over 1 MB. Download the original to open it in your favorite app.</p><a className="artifact-button" href={artifact.downloadUrl} download={artifact.filename}><Download size={16} aria-hidden /> Download artifact</a></div> : html && !source ? <iframe className="artifact-html-preview" title={`Preview of ${artifact.filename}`} sandbox="" referrerPolicy="no-referrer" srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">${content}`} /> : markdown && !source ? <div className="artifact-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div> : <pre className="artifact-source"><code>{content}</code></pre>}
        {html && !source && <p className="artifact-preview-note">Static preview. Download the artifact to use its interactive features.</p>}
        {isOwner && <details className="artifact-delivery" onToggle={event => setDelivery(event.currentTarget.open)}><summary>Send to a connected channel</summary>{delivery && <DeliverablesPanel botId={artifact.botId} artifactId={artifact.id} workspace />}</details>}
      </>}
      {tab === 'discussion' && <div className="artifact-discussion"><div className="artifact-section-heading"><div><h3>Make it better, together.</h3><p>Leave feedback, ask a question, or suggest the next iteration.</p></div><MessageSquare size={22} aria-hidden /></div>
        {!comments.length && <div className="artifact-discussion-empty"><MessageSquare size={24} aria-hidden /><p>No comments yet. Start the conversation.</p></div>}
        <ol className="artifact-comments">{comments.map(comment => <li key={comment.id}><span className="artifact-avatar">{initials(comment.authorName)}</span><div><div className="artifact-comment-heading"><strong>{comment.authorName}{comment.userId === userId ? ' (you)' : ''}</strong><time dateTime={new Date(comment.createdAt).toISOString()}>{new Date(comment.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></div><p>{comment.body}</p></div></li>)}</ol>
        {artifact.role === 'viewer' ? <p className="artifact-permission-note"><Lock size={16} aria-hidden /> You have view-only access. Ask the owner for comment access to join the discussion.</p> : <form className="artifact-comment-form" onSubmit={event => { event.preventDefault(); if (draft.trim()) void postComment(); }}><label htmlFor={`artifact-comment-${id}`}>Add to the discussion</label><textarea id={`artifact-comment-${id}`} placeholder="Share your thoughts with the team…" value={draft} maxLength={4000} disabled={busy} onChange={event => { setDraft(event.target.value); requestId.current = crypto.randomUUID(); }} required /><div><span>{draft.length}/4,000</span><button type="submit" className="artifact-button is-primary" disabled={busy || !draft.trim()}><Send size={15} aria-hidden />{busy ? 'Posting…' : 'Post comment'}</button></div></form>}
      </div>}
      {tab === 'sharing' && <div className="artifact-sharing"><div className="artifact-section-heading"><div><h3>Bring your team into the work.</h3><p>{isOwner ? 'Give teammates access to preview, download, and discuss this artifact.' : 'The owner manages who can view and discuss this artifact.'}</p></div><Share2 size={22} aria-hidden /></div>
        {isOwner && <form className="artifact-invite" onSubmit={event => { event.preventDefault(); void changeMember(email.trim(), role); }}><label htmlFor={`artifact-email-${id}`}>Add a teammate</label><div><input id={`artifact-email-${id}`} type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="teammate@company.com" maxLength={254} required disabled={busy} /><select aria-label="Teammate permission" value={role} disabled={busy} onChange={event => setRole(event.target.value as typeof role)}><option value="commenter">Can comment</option><option value="viewer">Can view</option></select><button className="artifact-button is-primary" type="submit" disabled={busy || !email.trim()}>{busy ? 'Saving…' : 'Add teammate'}</button></div><p>Use the email of an existing account on this workspace. Then send them the link below.</p></form>}
        <h4 className="artifact-people-heading">People with access <span>{members.length}</span></h4>
        <ul className="artifact-members">{members.map(member => <li key={member.userId}><span className="artifact-avatar">{initials(member.name)}</span><div><strong>{member.name}{member.userId === userId ? ' (you)' : ''}</strong>{member.email && <span>{member.email}</span>}</div>{member.role === 'owner' ? <span className="artifact-role">Owner</span> : isOwner ? <><select aria-label={`Permission for ${member.name}`} value={member.role} disabled={busy} onChange={event => void changeMember(member.email, event.target.value as 'viewer' | 'commenter')}><option value="commenter">Can comment</option><option value="viewer">Can view</option></select><button type="button" className="artifact-icon-button" disabled={busy} aria-label={`Remove access for ${member.name}`} onClick={() => void changeMember(member.email, 'remove')}><X size={16} aria-hidden /></button></> : <span className="artifact-role">{member.role === 'commenter' ? 'Can comment' : 'Can view'}</span>}</li>)}</ul>
        <div className="artifact-link-box"><div><Lock size={19} aria-hidden /><div><strong>Only people with access</strong><p>This link works for the people listed above. Sign-in is required.</p></div></div><label className="sr-only" htmlFor={`artifact-link-${id}`}>Artifact link</label><div><input id={`artifact-link-${id}`} value={artifactUrl(id)} readOnly onFocus={event => event.target.select()} /><button className="artifact-button" type="button" onClick={() => void copy()}><Copy size={15} aria-hidden />Copy link</button></div></div>
      </div>}
    </div>
  </div>;
}
