import { useEffect, useState } from 'react';
import type { AgentInstructionPreview, AgentSetupView, Bot } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { ApiError } from '../../lib/api';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';

function StandingInstructions({ bot, running, onSave }: { bot: Bot; running: boolean; onSave: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bot.instructions);
  const [original, setOriginal] = useState(bot.instructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changedElsewhere = editing && bot.instructions !== original;
  const edit = () => { setOriginal(bot.instructions); setDraft(bot.instructions); setEditing(true); setSaved(false); setError(null); };
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const { bot: next } = await configApi.updateBot(bot.id, { instructions: draft, expectedInstructions: original });
      useStore.setState((s) => ({ bots: s.bots.map((b) => b.id === next.id ? next : b) }));
      setEditing(false); setSaved(true); onSave();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 409) await useStore.getState().loadBots().catch(() => {});
    }
    finally { setSaving(false); }
  };
  return <section className="agent-config__section">
    <div className="agent-config__row"><h3>Standing instructions</h3>{!editing && <button type="button" className="link-btn link-btn--small" onClick={edit}>Edit instructions</button>}</div>
    <p className="agent-config__muted">Your editable part of the system prompt. Define preferences, decision rules and what a good result looks like.</p>
    {editing ? <>
      <textarea aria-label="Standing instructions" className="text-input cfg-textarea" rows={8} maxLength={8000} value={draft} disabled={saving} onChange={(e) => setDraft(e.target.value)} placeholder="For each result, include its source. Flag missing evidence. Keep updates concise." />
      <span className="agent-config__muted">{draft.length.toLocaleString()} / 8,000 characters · Saved changes apply to future model requests.</span>
      {changedElsewhere && <p className="cfg-error" role="alert">Instructions changed elsewhere. Cancel to load the latest version before editing.</p>}
      {running && <p className="agent-config__muted">Wait for the current run to finish before saving.</p>}
      <div className="agent-config__actions">
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={saving || running || changedElsewhere || draft === original} onClick={save}>{saving ? 'Saving…' : 'Save instructions'}</button>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={saving} onClick={() => { setEditing(false); setError(null); }}>Cancel</button>
      </div>
    </> : <p className={bot.instructions ? 'agent-config__text' : 'agent-config__muted'}>{bot.instructions || 'No additional standing instructions. The saved role and shared rules still apply.'}</p>}
    {saved && <p className="agent-config__muted" role="status">Instructions saved.</p>}
    {error && <p className="cfg-error" role="alert">{error}</p>}
  </section>;
}

function InstructionPreview({ botId, revision, version }: { botId: string; revision: number; version: number }) {
  const settingsOpen = useConfigUI((s) => s.botSettings?.botId === botId || !!s.appSettings);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<AgentInstructionPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || settingsOpen) { setPreview(null); return; }
    let current = true;
    setLoading(true); setPreview(null); setError(null);
    configApi.agentInstructions(botId).then((value) => { if (current) setPreview(value); })
      .catch((e) => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [botId, revision, version, open, refresh, settingsOpen]);
  return <details className="agent-config__preview" onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>Preview assembled instructions</summary>
    <p className="agent-config__muted">Built from the current configuration without running the agent. Conversation history and tool definitions are supplied separately. This is a preview, not a record of a previous run.</p>
    {loading && <p role="status">Preparing preview…</p>}
    {error && <p className="cfg-error" role="alert">{error}</p>}
    {preview && <>
      <p className="agent-config__muted">{preview.stage === 'active' ? 'Active agent instructions' : 'Setup consultant instructions · operational tools restricted'} · {new Date(preview.capturedAt).toLocaleTimeString()}</p>
      <pre className="agent-config__prompt" tabIndex={0} aria-label="Assembled system instructions">{preview.instructions}</pre>
    </>}
    <button type="button" className="link-btn link-btn--small" disabled={loading} onClick={() => setRefresh((v) => v + 1)}>{error ? 'Retry preview' : 'Refresh preview'}</button>
  </details>;
}

export function AgentHarness({ bot, data, running, version, onSave }: { bot: Bot; data: AgentSetupView; running: boolean; version: number; onSave: () => void }) {
  const { brief } = data.manifest;
  return <>
    <StandingInstructions bot={bot} running={running} onSave={onSave} />
    <InstructionPreview botId={bot.id} revision={data.onboarding.revision} version={version} />
    {(brief.communication_style || brief.working_principles.length > 0) && <section className="agent-config__section">
      <h3>Working style</h3>
      {brief.communication_style && <p>{brief.communication_style}</p>}
      {!!brief.working_principles.length && <ul>{brief.working_principles.map((item, i) => <li key={i}>{item}</li>)}</ul>}
    </section>}
    <section className="agent-config__section">
      <h3>Runtime controls</h3>
      <p className="agent-config__muted">Instructions guide behavior. They do not grant app access, change approval settings or register scheduled routines.</p>
      <div className="agent-config__actions">
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openAppSettings('permissions')}>Permissions</button>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openBotSettings(bot.id, 'skills')}>Skills</button>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openBotSettings(bot.id, 'routines')}>Routines</button>
      </div>
    </section>
    <details className="agent-config__preview">
      <summary>How the harness works</summary>
      <p>The harness combines the agent’s instructions with the tools and controls that carry out its work.</p>
      <ol className="agent-config__layers">
        <li><strong>Instructions</strong><span>Saved role, workflows and your standing instructions, combined with Swarm’s shared operating rules.</span></li>
        <li><strong>Context</strong><span>Conversation, relevant saved memory and saved skills. Skills are included after activation.</span></li>
        <li><strong>Tools & controls</strong><span>The model requests actions. Swarm checks account access, setup status and required approvals before running tools.</span></li>
        <li><strong>Results</strong><span>Tool results return to the model so it can continue, check its work and report the outcome.</span></li>
      </ol>
    </details>
  </>;
}
