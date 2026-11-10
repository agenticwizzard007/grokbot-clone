import { useEffect, useState } from 'react';
import type { McpServerInput, McpServerView } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { useStore } from '../../store';
import { ConfirmButton } from './ui';

const blank = (): McpServerInput => ({ name: '', transport: 'http', url: '', command: '', args: [], cwd: '', enabled: true, botIds: null, requireApproval: true });
function pairs(text: string, label: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${label} must be a JSON object, for example {"KEY": "value"}.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error(`${label} must contain text keys and values.`);
  return value as Record<string, string>;
}

function McpEditor({ server, onSave, onCancel }: { server: McpServerView | null; onSave: (input: McpServerInput) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState<McpServerInput>(server ? { name: server.name, transport: server.transport, url: server.url, command: server.command, args: server.args, cwd: server.cwd, enabled: server.enabled, botIds: server.botIds, requireApproval: server.requireApproval } : blank());
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [headers, setHeaders] = useState('');
  const [env, setEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bots = useStore(s => s.bots).filter(b => b.kind !== 'room');
  const set = <K extends keyof McpServerInput>(key: K, value: McpServerInput[K]) => setDraft(d => ({ ...d, [key]: value }));
  return <form className="cfg-card mcp-editor" aria-label={server ? 'Edit MCP server' : 'Add MCP server'} onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { await onSave({ ...draft, bearerToken: clearToken ? '' : token || undefined, headers: pairs(headers, 'Headers'), env: pairs(env, 'Environment variables') }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }}>
    <h2>{server ? 'Edit MCP server' : 'Add MCP server'}</h2>
    <fieldset disabled={busy} className="mcp-fields">
      <label className="cfg-field"><span className="cfg-field__label">Name</span><input className="text-input" required maxLength={80} value={draft.name} onChange={e => set('name', e.target.value)} placeholder="Research tools" autoFocus /></label>
      <label className="cfg-field"><span className="cfg-field__label">Connection</span><select className="text-input" value={draft.transport} onChange={e => set('transport', e.target.value as McpServerInput['transport'])}>
        <option value="http">Remote URL (Streamable HTTP)</option><option value="sse">Remote URL (legacy SSE)</option><option value="stdio">Local command (stdio)</option>
      </select></label>
      {draft.transport === 'stdio' ? <>
        <label className="cfg-field"><span className="cfg-field__label">Command</span><input className="text-input" required value={draft.command} onChange={e => set('command', e.target.value)} placeholder="npx" /></label>
        <label className="cfg-field"><span className="cfg-field__label">Arguments — one per line</span><textarea className="text-input" rows={3} value={draft.args.join('\n')} onChange={e => set('args', e.target.value ? e.target.value.split('\n') : [])} placeholder={'-y\n@your-org/mcp-server'} /></label>
        <p className="cfg-field__hint">Runs on the machine hosting Swarm — your Mac for a local installation. Enter the executable above and each argument separately. Put secrets in environment variables below.</p>
      </> : <label className="cfg-field"><span className="cfg-field__label">Server URL</span><input className="text-input" required type="url" value={draft.url} onChange={e => set('url', e.target.value)} placeholder="https://example.com/mcp" /></label>}
      <label className="cfg-field"><span className="cfg-field__label">Agent access</span><select className="text-input" value={draft.botIds === null ? 'all' : 'selected'} onChange={e => set('botIds', e.target.value === 'all' ? null : [])}><option value="all">All my agents, including new ones</option><option value="selected">Selected agents only</option></select></label>
      {draft.botIds !== null && <div className="mcp-bots" role="group" aria-label="Agents with access">
        {bots.map(b => <label className="mcp-check" key={b.id}><input type="checkbox" checked={draft.botIds!.includes(b.id)} onChange={e => set('botIds', e.target.checked ? [...draft.botIds!, b.id] : draft.botIds!.filter(id => id !== b.id))} />{b.name}{b.label ? ` · ${b.label}` : ''}</label>)}
        {!draft.botIds.length && <span className="cfg-field__hint">No agent can use this server until you select one.</span>}
      </div>}
      <label className="mcp-check"><input type="checkbox" checked={draft.requireApproval} onChange={e => set('requireApproval', e.target.checked)} />Ask me before using tools</label>
      <p className="cfg-field__hint">You can allow individual tools permanently from their approval cards.</p>
      <details className="mcp-advanced"><summary>{draft.transport === 'stdio' ? 'Environment & working directory' : 'Authentication & headers'}</summary>
        {draft.transport === 'stdio' ? <>
          <label className="cfg-field"><span className="cfg-field__label">Working directory (optional)</span><input className="text-input" value={draft.cwd} onChange={e => set('cwd', e.target.value)} placeholder="/path/to/project" /></label>
          <label className="cfg-field"><span className="cfg-field__label">Environment variables (JSON)</span><textarea className="text-input" spellCheck={false} autoComplete="off" rows={3} value={env} onChange={e => setEnv(e.target.value)} placeholder={'{"API_KEY": "your-key"}'} /></label>
          {!!server?.envNames.length && <p className="cfg-field__hint">Saved: {server.envNames.join(', ')}. Leave blank to keep them; enter {'{}'} to clear them.</p>}
        </> : <>
          <label className="cfg-field"><span className="cfg-field__label">Bearer token (optional)</span><input className="text-input" type="password" autoComplete="off" value={token} onChange={e => { setToken(e.target.value); setClearToken(false); }} placeholder={server?.hasBearerToken ? 'Saved — leave blank to keep' : 'Paste access token'} /></label>
          {server?.hasBearerToken && <label className="mcp-check"><input type="checkbox" checked={clearToken} onChange={e => { setClearToken(e.target.checked); setToken(''); }} />Remove saved token</label>}
          <label className="cfg-field"><span className="cfg-field__label">Custom headers (JSON, optional)</span><textarea className="text-input" rows={3} spellCheck={false} autoComplete="off" value={headers} onChange={e => setHeaders(e.target.value)} placeholder={'{"X-API-Key": "your-key"}'} /></label>
          {!!server?.headerNames.length && <p className="cfg-field__hint">Saved: {server.headerNames.join(', ')}. Leave blank to keep them; enter {'{}'} to clear them.</p>}
          <p className="cfg-field__hint">Use the token or headers your MCP provider supplies. Interactive OAuth sign-in is not supported yet.</p>
        </>}
      </details>
    </fieldset>
    {error && <div className="cfg-error" role="alert">{error}</div>}
    <div className="mcp-actions"><button className="cfg-btn cfg-btn--primary" disabled={busy} type="submit">{busy ? 'Connecting…' : 'Save & test connection'}</button><button className="cfg-btn cfg-btn--secondary" disabled={busy} type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
}

export function McpSettings() {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<McpServerView | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const upsert = (server: McpServerView) => setServers(list => list.some(s => s.id === server.id) ? list.map(s => s.id === server.id ? server : s) : [...list, server]);
  useEffect(() => { let alive = true; configApi.mcpServers().then(r => { if (alive) { setServers(r.servers); setCanManage(r.canManage); } }).catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); }); return () => { alive = false; }; }, []);
  async function act(id: string, work: () => Promise<void>) { setBusy(id); setError(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } }
  return <>
    <div className="app-settings__head"><h1>MCP servers</h1><p>Connect custom tools and choose which agents can use them.</p></div>
    {error && <div className="cfg-error" role="alert">{error}</div>}
    {loading ? <p className="cfg-empty">Loading…</p> : <>
      {!canManage && <p className="cfg-field__hint">The server owner manages custom MCP connections.</p>}
      {editing !== undefined ? <McpEditor key={editing?.id ?? 'new'} server={editing} onCancel={() => setEditing(undefined)} onSave={async input => {
        const { server } = editing ? await configApi.updateMcpServer(editing.id, input) : await configApi.createMcpServer(input);
        upsert(server);
        try { upsert((await configApi.testMcpServer(server.id)).server); }
        catch (e) { setError(`Saved, but the connection test failed: ${(e as Error).message}`); }
        setEditing(undefined);
      }} /> : canManage && <div><button className="cfg-btn cfg-btn--primary" type="button" onClick={() => setEditing(null)}>Add MCP server</button></div>}
      {!servers.length && editing === undefined && <div className="cfg-empty">No custom servers yet. Add a remote URL or a local MCP command.</div>}
      <div className="mcp-list">{servers.map(s => <section className="cfg-card mcp-server" key={s.id} aria-label={s.name}>
        <div className="cfg-row"><span className={`computer-status-dot is-${s.enabled && s.checkedAt && !s.error ? 'on' : 'off'}`} aria-hidden /><div className="cfg-row__text"><div className="cfg-row__title">{s.name}</div><div className="cfg-row__sub">{!s.enabled ? 'Disabled' : s.error ? 'Connection failed' : s.checkedAt ? 'Connection verified' : 'Not tested'} · {s.tools.length} tool{s.tools.length === 1 ? '' : 's'}</div></div>{canManage && <label className="mcp-check"><input aria-label={`Enable ${s.name}`} type="checkbox" checked={s.enabled} disabled={!!busy} onChange={e => { const enabled = e.target.checked; void act(s.id, async () => upsert((await configApi.updateMcpServer(s.id, { enabled })).server)); }} />Enabled</label>}</div>
        <div className="mcp-server__body"><p className="cfg-field__hint">{s.transport === 'stdio' ? 'Local command' : s.transport === 'sse' ? 'Remote SSE' : 'Remote HTTP'} · {s.botIds === null ? 'All my agents' : `${s.botIds.length} selected agent${s.botIds.length === 1 ? '' : 's'}`}</p>
          {s.error && <div className="cfg-error" role="alert">{s.error}</div>}
          {!!s.tools.length && <details className="mcp-tools"><summary>Available tools ({s.tools.length})</summary>{s.tools.map(t => <div key={t.name}><strong>{t.name}</strong>{t.description && <p>{t.description}</p>}</div>)}</details>}
          {s.checkedAt && !s.error && !s.tools.length && <p className="cfg-field__hint">This server exposes no tools. MCP resources and prompt templates are not supported yet.</p>}
          {canManage && <div className="mcp-actions"><button className="cfg-btn cfg-btn--secondary" disabled={!!busy || editing !== undefined} type="button" onClick={() => setEditing(s)}>Edit</button><button className="cfg-btn cfg-btn--secondary" disabled={!!busy} type="button" onClick={() => void act(s.id, async () => upsert((await configApi.testMcpServer(s.id)).server))}>{busy === s.id ? 'Working…' : 'Test connection'}</button><ConfirmButton className="cfg-btn cfg-btn--secondary" disabled={!!busy} confirmLabel="Remove server" onConfirm={() => act(s.id, async () => { await configApi.deleteMcpServer(s.id); setServers(list => list.filter(item => item.id !== s.id)); })}>Remove</ConfirmButton></div>}
        </div>
      </section>)}</div>
    </>}
  </>;
}
