import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { McpServerInput, McpServerView } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { accessApi, verifyAccessAccount } from '../../lib/accessApi';
import { needsReauth } from '../../lib/api';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { ConfirmButton, Switch } from './ui';
import { ReauthPrompt } from './ReauthPrompt';
import { useAccessReauth } from './useAccessReauth';

const blank = (): McpServerInput => ({ name: '', transport: 'http', url: '', command: '', args: [], cwd: '', folders: [], enabled: true, botIds: [], requireApproval: true, oauth: false });
const editorValues = (server: McpServerView | null): McpServerInput => server ? { name: server.name, transport: server.transport, url: server.url, command: server.command, args: server.args, cwd: server.cwd, folders: server.folders ?? [], enabled: server.enabled, botIds: server.botIds, requireApproval: server.requireApproval, oauth: server.oauth ?? false } : blank();
type SafeDraft = Pick<McpServerInput, 'name' | 'transport' | 'folders' | 'enabled' | 'botIds' | 'requireApproval' | 'oauth'> & { reenterEndpoint: boolean; credentialsChanged: boolean };
type McpIntent = { action: 'save'; id: string | null; draft: SafeDraft } | { action: 'oauth'; id: string };
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

function parseMcpIntent(value: unknown): McpIntent | null {
  if (!value || typeof value !== 'object') return null;
  const intent = value as Partial<McpIntent>;
  if (intent.action === 'oauth' && typeof intent.id === 'string') return { action: 'oauth', id: intent.id };
  if (intent.action !== 'save' || !(typeof intent.id === 'string' || intent.id === null)) return null;
  const draft = intent.draft;
  if (!draft || typeof draft.name !== 'string' || !['http', 'sse', 'stdio'].includes(draft.transport) || !isStringList(draft.folders) || !(draft.botIds === null || isStringList(draft.botIds)) || typeof draft.enabled !== 'boolean' || typeof draft.requireApproval !== 'boolean') return null;
  return { action: 'save', id: intent.id, draft: {
    name: draft.name, transport: draft.transport, folders: draft.folders, botIds: draft.botIds,
    enabled: draft.enabled, requireApproval: draft.requireApproval, oauth: draft.oauth === true,
    reenterEndpoint: draft.reenterEndpoint === true, credentialsChanged: draft.credentialsChanged === true,
  } };
}

function safeDraft(input: McpServerInput, server: McpServerView | null): SafeDraft {
  const { name, transport, folders, enabled, botIds, requireApproval, oauth } = input;
  const before = editorValues(server);
  return {
    name, transport, folders: folders ?? before.folders ?? [], enabled, botIds, requireApproval, oauth,
    reenterEndpoint: !server || transport !== before.transport || input.url !== before.url || input.command !== before.command || input.cwd !== before.cwd || JSON.stringify(input.args) !== JSON.stringify(before.args),
    credentialsChanged: input.bearerToken !== undefined || !!input.headers || !!input.env,
  };
}

function restoreDraft(server: McpServerView | null, recovered?: SafeDraft): McpServerInput {
  const before = editorValues(server);
  if (!recovered) return before;
  const { reenterEndpoint, credentialsChanged: _, ...draft } = recovered;
  return { ...before, ...draft, ...(reenterEndpoint ? { url: '', command: '', args: [], cwd: '' } : {}) };
}
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

function McpEditor({ server, recovered, locked, onSave, onCancel, onRemove }: { server: McpServerView | null; recovered?: SafeDraft; locked: boolean; onSave: (input: McpServerInput) => Promise<void>; onCancel: () => void; onRemove?: () => Promise<void> }) {
  const [draft, setDraft] = useState(() => restoreDraft(server, recovered));
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [headers, setHeaders] = useState('');
  const [env, setEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bots = useStore(s => s.bots).filter(b => b.kind !== 'room');
  const set = <K extends keyof McpServerInput>(key: K, value: McpServerInput[K]) => setDraft(d => ({ ...d, [key]: value }));
  const stdio = draft.transport === 'stdio';
  return <section className="cfg-section" hidden={locked}>
    <h2 className="cfg-section__label">{server ? `Edit ${server.name}` : 'New server'}</h2>
    {recovered && <div className="access-callout" role="status">
      You’re signed in again. Review your draft and choose Save &amp; test connection again.
      {recovered.reenterEndpoint && ' Re-enter the connection URL or command and its arguments.'}
      {recovered.credentialsChanged && ' Re-enter any credentials you want to change; they weren’t carried through sign-in.'}
    </div>}
    <form className="cfg-card mcp-editor" aria-label={server ? 'Edit MCP server' : 'Add MCP server'} onSubmit={async e => {
      e.preventDefault(); if (busy || locked) return; setBusy(true); setError('');
      try { await onSave({ ...draft, folders: JSON.stringify(draft.folders) === JSON.stringify(server?.folders ?? []) ? undefined : draft.folders, bearerToken: clearToken ? '' : token || undefined, headers: pairs(headers, 'Headers'), env: pairs(env, 'Environment variables') }); }
      catch (e) {
        if (needsReauth(e)) { setToken(''); setClearToken(false); setHeaders(''); setEnv(''); }
        else setError(e instanceof Error ? e.message : 'Couldn’t save this MCP server.');
      }
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
  const user = useStore(state => state.user);
  return user && <AccountMcpSettings key={user.id} accountId={user.id} accountEmail={user.email} />;
}

function AccountMcpSettings({ accountId, accountEmail }: { accountId: string; accountEmail: string }) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<McpServerView | null | undefined>(undefined);
  const [recovered, setRecovered] = useState<SafeDraft>();
  const [recoveredOAuth, setRecoveredOAuth] = useState<string>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const action = useRef(false);
  const applied = useRef(false);
  const reauth = useAccessReauth('mcp', accountId, parseMcpIntent);
  const locked = !!reauth.pending || reauth.checking;
  const current = () => mounted.current && useStore.getState().user?.id === accountId;
  const upsert = (server: McpServerView) => setServers(list => list.some(s => s.id === server.id) ? list.map(s => s.id === server.id ? server : s) : [...list, server]);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    setLoading(true); setLoadError(''); setCanManage(false); setServers([]);
    void configApi.mcpServers().then(result => {
      if (alive && current()) { setServers(result.servers ?? []); setCanManage(!!result.canManage); }
    }).catch(err => { if (alive && current()) setLoadError(err.message); }).finally(() => { if (alive && current()) setLoading(false); });
    return () => { alive = false; mounted.current = false; };
  }, [accountId, reload]);

  useEffect(() => {
    const intent = reauth.returned;
    if (!intent || loading || loadError || applied.current) return;
    applied.current = true;
    const server = intent.id === null ? null : servers.find(item => item.id === intent.id);
    if (!canManage || server === undefined) { setNotice('The previous server is no longer available to edit. No changes were made.'); return; }
    if (intent.action === 'save') { setEditing(server); setRecovered(intent.draft); }
    else if (server?.oauth) setRecoveredOAuth(server.id);
    else setNotice('OAuth is no longer available for this server. No connection was started.');
  }, [canManage, loadError, loading, reauth.returned, servers]);

  async function act(id: string, work: () => Promise<void>, intent?: McpIntent) {
    if (locked || action.current || !current()) return;
    action.current = true; setBusy(id); setError(''); setNotice('');
    try { await verifyAccessAccount(accountId); if (current()) await work(); }
    catch (err) {
      if (!current()) return;
      if (intent && needsReauth(err)) reauth.request(intent, err.message);
      else setError(err instanceof Error ? err.message : 'Couldn’t update MCP settings.');
    } finally { action.current = false; if (current()) setBusy(null); }
  }

  function edit(server: McpServerView | null | undefined) { setEditing(server); setRecovered(undefined); }

  const test = (server: McpServerView) => act(server.id, async () => {
    const result = await configApi.testMcpServer(server.id);
    if (current()) upsert(result.server);
  });
  return <>
    <div className="app-settings__head">
      <h1>Manage MCP servers</h1><p>Allow Bots to use only the servers and tools they need.</p>
    </div>
    {error && <div className="cfg-error" role="alert">{error}</div>}
    {reauth.error && <div className="cfg-error" role="alert">{reauth.error}</div>}
    {reauth.checking && <div className="cfg-empty" role="status">Verifying your sign-in…</div>}
    {reauth.pending && <ReauthPrompt reason={reauth.pending.reason} accountEmail={accountEmail} resume={{ section: 'mcp', action: 'login', accountId }} retryLabel={reauth.pending.intent.action === 'oauth' ? 'Connect account' : 'Save & test connection'} terminalActive={false} onCancel={() => { reauth.cancel(); edit(undefined); }} />}
    {notice && <p className="access-callout" role="status">{notice}</p>}
    {recoveredOAuth && !locked && <p className="access-callout" role="status">You’re signed in again. Select Connect account on the server to start authorization.</p>}
    {!locked && loadError && <div><p className="cfg-error" role="alert">{loadError}</p><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setReload(value => value + 1)}>Try again</button></div>}
    {!locked && loading && <div className="cfg-empty cfg-empty--flat" role="status">Loading MCP servers…</div>}
    {!loading && !loadError && <>
      {editing !== undefined && <McpEditor key={editing?.id ?? 'new'} server={editing} recovered={recovered} locked={locked} onCancel={() => edit(undefined)}
        onRemove={editing ? async () => { const id = editing.id; await act(id, async () => { await configApi.deleteMcpServer(id); if (current()) { setServers(list => list.filter(item => item.id !== id)); edit(undefined); } }); } : undefined}
        onSave={async input => {
          if (locked || action.current || !current()) return;
          action.current = true; setBusy(editing?.id ?? 'new'); setError('');
          try {
            await verifyAccessAccount(accountId);
            if (!current()) return;
            const { server } = editing ? await accessApi.updateMcpServer(editing.id, input) : await accessApi.createMcpServer(input);
            if (!current()) return;
            upsert(server);
            try { const result = await configApi.testMcpServer(server.id); if (current()) upsert(result.server); }
            catch (err) { if (current()) setError(`Saved, but the connection test failed: ${err instanceof Error ? err.message : 'Unknown error'}`); }
            if (current()) edit(undefined);
          } catch (err) {
            if (current() && needsReauth(err)) reauth.request({ action: 'save', id: editing?.id ?? null, draft: safeDraft(input, editing) }, err.message);
            throw err;
          } finally { action.current = false; if (current()) setBusy(null); }
        }} />}
      {!locked && <section className="cfg-section access-mcp">
        <h2 className="cfg-section__label">Your servers</h2>
        {!servers.length ? <div className="cfg-empty">{canManage ? 'No custom servers yet. Add a remote URL or a local MCP command.' : 'No custom servers are available to this account.'}</div> : <div className="cfg-card">
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
              {s.oauth && <button className={`cfg-btn ${recoveredOAuth === s.id ? 'cfg-btn--primary' : 'cfg-btn--secondary'}`} disabled={!!busy} type="button" onClick={() => void act(s.id, async () => { const result = await accessApi.authorizeMcpServer(s.id); if (current()) window.location.assign(result.redirectUrl); }, { action: 'oauth', id: s.id })}>Connect account</button>}
              <Switch label={`Enable ${s.name}`} on={s.enabled} disabled={!!busy} onChange={enabled => void act(s.id, async () => { const result = await accessApi.updateMcpServer(s.id, { enabled }); if (current()) upsert(result.server); })} />
              {(s.error || !s.checkedAt) && <button className="cfg-btn cfg-btn--secondary" disabled={!!busy} type="button" onClick={() => void test(s)}>{busy === s.id ? 'Testing…' : s.error ? 'Test again' : 'Test'}</button>}
              <button className="cfg-btn cfg-btn--secondary" disabled={!!busy || editing !== undefined} type="button" onClick={() => setEditing(s)}>Edit</button>
            </div>}
          </section>)}
        </div>}
        {canManage && editing === undefined && <button className="cfg-btn cfg-btn--primary" type="button" disabled={!!busy} onClick={() => edit(null)}>Add MCP server</button>}
      </section>}
    </>}
  </>;
}
