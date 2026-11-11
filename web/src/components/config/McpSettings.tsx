import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { McpServerInput, McpServerView } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { ConfirmButton, Switch } from './ui';

const blank = (): McpServerInput => ({ name: '', transport: 'http', url: '', command: '', args: [], cwd: '', folders: [], enabled: true, botIds: [], requireApproval: true, oauth: false });
function pairs(text: string, label: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${label} must be a JSON object, for example {"KEY": "value"}.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error(`${label} must contain text keys and values.`);
  return value as Record<string, string>;
}

/** A form row: label and hint on the left, the field on the right (stacked on phones). */
function FormRow({ label, hint, children }: { label: string; hint?: ReactNode; children: (ids: { id: string; describedBy?: string }) => ReactNode }) {
  const id = useId();
  return (
    <div className="settings-field">
      <div className="settings-field__text">
        <label className="settings-field__label" htmlFor={id}>{label}</label>
        {hint && <div className="settings-field__hint" id={`${id}-hint`}>{hint}</div>}
      </div>
      <div className="settings-field__control">{children({ id, describedBy: hint ? `${id}-hint` : undefined })}</div>
    </div>
  );
}

function FolderPicker({ selected, onChange }: { selected: string[]; onChange: (folders: string[]) => void }) {
  const [folder, setFolder] = useState('');
  const [page, setPage] = useState('');
  const [choices, setChoices] = useState<{ path: string; name: string }[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true; setLoading(true); setError(''); setChoices([]); setNext(null);
    configApi.mcpFolders(folder, page).then(result => { if (alive) { setChoices(result.folders); setNext(result.next); } })
      .catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [folder, page]);
  const open = (value: string) => { setFolder(value); setPage(''); };
  const overlaps = (value: string) => selected.some(s => s === value || s.startsWith(value + '/') || value.startsWith(s + '/'));
  return <div className="cfg-row"><div className="cfg-row__text">
    <div className="cfg-row__title">Shared folders</div>
    <p className="cfg-row__sub">Choose up to eight Library folders this server can read. Folder access includes their contents and subfolders. It cannot change your files.</p>
    {selected.map((value, index) => <div className="mcp-actions" key={value}><span>{value} · <code>/workspace/folders/{index + 1}</code></span><button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => onChange(selected.filter(s => s !== value))}>Remove folder</button></div>)}
    {!selected.length && <p className="cfg-row__sub">No folders shared.</p>}
    <div className="mcp-actions"><span>{folder || 'Your Library'}</span>{folder && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => open(folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '')}>Up</button>}
      {folder && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={loading || !!error || selected.length >= 8 || overlaps(folder)} onClick={() => onChange([...selected, folder])}>Share this folder</button>}
    </div>
    {loading ? <p className="cfg-row__sub">Loading folders…</p> : choices.map(choice => <button type="button" className="cfg-btn cfg-btn--secondary" key={choice.path} onClick={() => open(choice.path)}>{choice.name}</button>)}
    {!loading && !choices.length && !error && <p className="cfg-row__sub">No folders here.</p>}
    {next && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPage(next)}>Next folders</button>}
    {error && <p role="alert" className="cfg-error">{error}</p>}
  </div></div>;
}

function McpEditor({ server, onSave, onCancel, onRemove }: { server: McpServerView | null; onSave: (input: McpServerInput) => Promise<void>; onCancel: () => void; onRemove?: () => Promise<void> }) {
  const [draft, setDraft] = useState<McpServerInput>(server ? { name: server.name, transport: server.transport, url: server.url, command: server.command, args: server.args, cwd: server.cwd, folders: server.folders ?? [], enabled: server.enabled, botIds: server.botIds, requireApproval: server.requireApproval, oauth: server.oauth ?? false } : blank());
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [headers, setHeaders] = useState('');
  const [env, setEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bots = useStore(s => s.bots).filter(b => b.kind !== 'room');
  const set = <K extends keyof McpServerInput>(key: K, value: McpServerInput[K]) => setDraft(d => ({ ...d, [key]: value }));
  const stdio = draft.transport === 'stdio';
  return <section className="cfg-section">
    <h2 className="cfg-section__label">{server ? `Edit ${server.name}` : 'New server'}</h2>
    <form className="cfg-card mcp-editor" aria-label={server ? 'Edit MCP server' : 'Add MCP server'} onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try { await onSave({ ...draft, folders: JSON.stringify(draft.folders) === JSON.stringify(server?.folders ?? []) ? undefined : draft.folders, bearerToken: clearToken ? '' : token || undefined, headers: pairs(headers, 'Headers'), env: pairs(env, 'Environment variables') }); }
      catch (e) { setError((e as Error).message); }
      finally { setBusy(false); }
    }}>
      <fieldset disabled={busy} className="mcp-fields">
        <FormRow label="Name" hint="What Bots see this server as.">{({ id, describedBy }) => <input id={id} aria-describedby={describedBy} className="text-input" required maxLength={80} value={draft.name} onChange={e => set('name', e.target.value)} placeholder="Research tools" autoFocus />}</FormRow>
        <FormRow label="Connection" hint="How Swarm reaches the server.">{({ id, describedBy }) => <select id={id} aria-describedby={describedBy} className="text-input" value={draft.transport} onChange={e => setDraft(d => ({ ...d, transport: e.target.value as McpServerInput['transport'], folders: e.target.value === 'stdio' ? d.folders : [] }))}>
          <option value="http">Remote URL (Streamable HTTP)</option><option value="sse">Remote URL (legacy SSE)</option><option value="stdio">Local command (stdio)</option>
        </select>}</FormRow>
        {stdio ? <>
          <FormRow label="Command" hint="Runs in a private container. Use an installed command.">{({ id, describedBy }) => <input id={id} aria-describedby={describedBy} className="text-input" required value={draft.command} onChange={e => set('command', e.target.value)} placeholder="/usr/local/bin/mcp-server" />}</FormRow>
          <FormRow label="Arguments — one per line" hint="Put secrets in environment variables instead.">{({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} className="text-input" rows={3} value={draft.args.join('\n')} onChange={e => set('args', e.target.value ? e.target.value.split('\n') : [])} placeholder={'-y\n@your-org/mcp-server'} />}</FormRow>
          <FolderPicker selected={draft.folders ?? []} onChange={folders => set('folders', folders)} />
        </> : <FormRow label="Server URL">{({ id }) => <input id={id} className="text-input" required type="url" value={draft.url} onChange={e => set('url', e.target.value)} placeholder="https://example.com/mcp" />}</FormRow>}
        <FormRow label="Bot access" hint="Which Bots can use its tools.">{({ id, describedBy }) => <>
          <select id={id} aria-describedby={describedBy} className="text-input" value={draft.botIds === null ? 'all' : 'selected'} onChange={e => set('botIds', e.target.value === 'all' ? null : [])}><option value="all">All my Bots, including new ones</option><option value="selected">Selected Bots only</option></select>
          {draft.botIds !== null && <div className="mcp-bots" role="group" aria-label="Bots with access">
            {bots.map(b => <label className="mcp-check" key={b.id}><input type="checkbox" checked={draft.botIds!.includes(b.id)} onChange={e => set('botIds', e.target.checked ? [...draft.botIds!, b.id] : draft.botIds!.filter(id => id !== b.id))} />{b.name}{b.label ? ` · ${b.label}` : ''}</label>)}
            {!draft.botIds.length && <span className="cfg-field__hint">No Bot can use this server until you pick one.</span>}
          </div>}
        </>}</FormRow>
        <div className="cfg-row">
          <div className="cfg-row__text"><div className="cfg-row__title">Ask before using tools</div><div className="cfg-row__sub">You can allow single tools for good from their approval cards.</div></div>
          <Switch label="Ask before using tools" on={draft.requireApproval} onChange={v => set('requireApproval', v)} />
        </div>
        <details className="mcp-advanced">
          <summary className="cfg-row">
            <span className="cfg-row__text"><span className="cfg-row__title">{stdio ? 'Environment variables' : 'Authentication & headers'}</span><span className="cfg-row__sub">{stdio ? 'Optional. Secrets the command needs.' : 'Optional. A bearer token or custom headers.'}</span></span>
            <ChevronRight className="mcp-advanced__chev" size={18} strokeWidth={1.75} aria-hidden />
          </summary>
          <div className="mcp-advanced__body">
            {stdio ? <>
              <FormRow label="Environment variables (JSON)" hint={server?.envNames.length ? `Saved: ${server.envNames.join(', ')}. Leave blank to keep them; enter {} to clear them.` : undefined}>{({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} className="text-input" spellCheck={false} autoComplete="off" rows={3} value={env} onChange={e => setEnv(e.target.value)} placeholder={'{"API_KEY": "your-key"}'} />}</FormRow>
            </> : <>
              <div className="cfg-row"><div className="cfg-row__text"><div className="cfg-row__title">Sign in with OAuth</div><div className="cfg-row__sub">Save this server, then connect your account.</div></div><Switch label="Use OAuth" on={draft.oauth ?? false} onChange={value => set('oauth', value)} /></div>
              <FormRow label="Bearer token (optional)" hint={server?.hasBearerToken ? <label className="mcp-check"><input type="checkbox" checked={clearToken} onChange={e => { setClearToken(e.target.checked); setToken(''); }} />Remove saved token</label> : undefined}>{({ id }) => <input id={id} className="text-input" type="password" autoComplete="off" value={token} onChange={e => { setToken(e.target.value); setClearToken(false); }} placeholder={server?.hasBearerToken ? 'Saved — leave blank to keep' : 'Paste access token'} />}</FormRow>
              <FormRow label="Custom headers (JSON, optional)" hint={server?.headerNames.length ? `Saved: ${server.headerNames.join(', ')}. Leave blank to keep them; enter {} to clear them.` : 'Use the token or headers your MCP provider gives you.'}>{({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} className="text-input" rows={3} spellCheck={false} autoComplete="off" value={headers} onChange={e => setHeaders(e.target.value)} placeholder={'{"X-API-Key": "your-key"}'} />}</FormRow>
            </>}
          </div>
        </details>
      </fieldset>
      {error && <div className="cfg-error cfg-error--inset" role="alert">{error}</div>}
      <div className="mcp-actions">
        {onRemove && <ConfirmButton className="cfg-btn cfg-btn--ghost-danger" confirmLabel="Remove server" disabled={busy} onConfirm={onRemove}>Remove…</ConfirmButton>}
        <span className="mcp-actions__spacer" />
        <button className="cfg-btn cfg-btn--secondary" disabled={busy} type="button" onClick={onCancel}>Cancel</button>
        <button className="cfg-btn cfg-btn--primary" disabled={busy} type="submit">{busy ? 'Connecting…' : 'Save & test connection'}</button>
      </div>
    </form>
  </section>;
}

const transportText = (s: McpServerView) => (s.transport === 'stdio' ? 'Local command' : s.transport === 'sse' ? 'Remote SSE' : 'Remote HTTP');
const accessText = (s: McpServerView) => (s.botIds === null ? 'All my Bots' : `${s.botIds.length} selected Bot${s.botIds.length === 1 ? '' : 's'}`);
const statusDot = (s: McpServerView) => (s.enabled && s.checkedAt && !s.error ? 'on' : s.enabled && s.error ? 'error' : 'off');
const ago = (ts: number) => { const r = relativeShort(ts); return r === 'now' ? 'just now' : /^\d/.test(r) ? `${r} ago` : r.toLowerCase(); };
/** "Remote HTTP · All my Bots · 12 tools · Verified 2m ago" */
const summary = (s: McpServerView) => [transportText(s), accessText(s), `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`,
  !s.enabled ? 'Disabled' : s.checkedAt ? `Verified ${ago(s.checkedAt)}` : 'Not tested'].join(' · ');

export function McpSettings() {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<McpServerView | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const upsert = (server: McpServerView) => setServers(list => list.some(s => s.id === server.id) ? list.map(s => s.id === server.id ? server : s) : [...list, server]);
  useEffect(() => { let alive = true; configApi.mcpServers().then(r => { if (alive) { setServers(r.servers ?? []); setCanManage(!!r.canManage); } }).catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); }); return () => { alive = false; }; }, []);
  async function act(id: string, work: () => Promise<void>) { setBusy(id); setError(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } }
  const test = (s: McpServerView) => act(s.id, async () => upsert((await configApi.testMcpServer(s.id)).server));
  return <>
    <div className="app-settings__head app-settings__head--action">
      <div><h1>MCP servers</h1><p>Connect custom tools and choose which Bots can use them.</p></div>
      {canManage && editing === undefined && !loading && <button className="cfg-btn cfg-btn--primary" type="button" onClick={() => setEditing(null)}>Add MCP server</button>}
    </div>
    {error && <div className="cfg-error" role="alert">{error}</div>}
    {loading ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : <>
      {editing !== undefined && <McpEditor key={editing?.id ?? 'new'} server={editing} onCancel={() => setEditing(undefined)}
        onRemove={editing ? async () => { const id = editing.id; await act(id, async () => { await configApi.deleteMcpServer(id); setServers(list => list.filter(item => item.id !== id)); setEditing(undefined); }); } : undefined}
        onSave={async input => {
          const { server } = editing ? await configApi.updateMcpServer(editing.id, input) : await configApi.createMcpServer(input);
          upsert(server);
          try { upsert((await configApi.testMcpServer(server.id)).server); }
          catch (e) { setError(`Saved, but the connection test failed: ${(e as Error).message}`); }
          setEditing(undefined);
        }} />}
      <section className="cfg-section">
        <h2 className="cfg-section__label">Your servers</h2>
        {!servers.length ? <div className="cfg-empty">No custom servers yet. Add a remote URL or a local MCP command.</div> : <div className="cfg-card">
          {servers.map(s => <section className="cfg-row mcp-server" key={s.id} aria-label={s.name}>
            <span className={`computer-status-dot is-${statusDot(s)}`} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">{s.name}</div>
              {s.enabled && s.error
                ? <div className="cfg-row__sub is-error" role="alert">Connection failed: {s.error}</div>
                : <div className="cfg-row__sub">{summary(s)}</div>}
              {!!s.tools.length && <details className="mcp-tools"><summary>Available tools ({s.tools.length})</summary>{s.tools.map(t => <div key={t.name}><strong>{t.name}</strong>{t.description && <p>{t.description}</p>}</div>)}</details>}
              {s.checkedAt && !s.error && !s.tools.length && <div className="cfg-row__sub">This server exposes no tools. MCP resources and prompt templates aren’t supported yet.</div>}
            </div>
            {canManage && <div className="mcp-server__actions">
              {s.oauth && <button className="cfg-btn cfg-btn--secondary" disabled={!!busy} type="button" onClick={() => void act(s.id, async () => { const result = await configApi.authorizeMcpServer(s.id); window.location.assign(result.redirectUrl); })}>Connect account</button>}
              <Switch label={`Enable ${s.name}`} on={s.enabled} disabled={!!busy} onChange={enabled => void act(s.id, async () => upsert((await configApi.updateMcpServer(s.id, { enabled })).server))} />
              {(s.error || !s.checkedAt) && <button className="cfg-btn cfg-btn--secondary" disabled={!!busy} type="button" onClick={() => void test(s)}>{busy === s.id ? 'Testing…' : s.error ? 'Test again' : 'Test'}</button>}
              <button className="cfg-btn cfg-btn--secondary" disabled={!!busy || editing !== undefined} type="button" onClick={() => setEditing(s)}>Edit</button>
            </div>}
          </section>)}
        </div>}
      </section>
    </>}
  </>;
}
