import { useEffect, useState } from 'react';
import type { AgentInstructionPreview, AgentSetupView, Bot } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { ApiError } from '../../lib/api';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Glyph } from './glyphs';
import { ShieldCheck } from 'lucide-react';

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
  return <section className="agent-config__section agent-config__instructions">
    <div className="agent-config__row"><h3>Standing instructions</h3>{!editing && <button type="button" className="cfg-btn cfg-btn--secondary agent-config__edit" aria-label="Edit instructions" onClick={edit}><Icon name="edit" size={14} />Edit</button>}</div>
    <p className="agent-config__muted">Set preferences, decision rules and what a good result looks like. These become part of the system prompt.</p>
    {editing ? <div className="agent-config__editor">
      <textarea aria-label="Standing instructions" className="text-input cfg-textarea" rows={8} maxLength={8000} value={draft} disabled={saving} onChange={(e) => setDraft(e.target.value)} placeholder="For each result, include its source. Flag missing evidence. Keep updates concise." />
      <div className="agent-config__editor-meta"><span>{draft.length.toLocaleString()} / 8,000</span><span>Applies to future requests</span></div>
      {changedElsewhere && <p className="cfg-error" role="alert">Instructions changed elsewhere. Cancel to load the latest version before editing.</p>}
      {running && <p className="agent-config__muted">Wait for the current run to finish before saving.</p>}
      <div className="agent-config__actions">
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={saving || running || changedElsewhere || draft === original} onClick={save}>{saving ? 'Saving…' : 'Save instructions'}</button>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={saving} onClick={() => { setEditing(false); setError(null); }}>Cancel</button>
      </div>
    </div> : <p className={bot.instructions ? 'agent-config__text' : 'agent-config__muted'}>{bot.instructions || 'No additional standing instructions. The saved role and shared rules still apply.'}</p>}
    {saved && <p className="agent-config__saved" role="status"><Icon name="check" size={14} />Instructions saved.</p>}
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
    <summary><span className="agent-config__summary-icon"><Icon name="file" size={18} /></span><span>Preview assembled instructions</span><Icon name="chev_right" className="agent-config__chevron" /></summary>
    <div className="agent-config__disclosure-body">
      <p className="agent-config__muted">Built from the current configuration without running the agent. Conversation history and tool definitions are supplied separately. This is a preview, not a record of a previous run.</p>
      {loading && <p role="status">Preparing preview…</p>}
      {error && <p className="cfg-error" role="alert">{error}</p>}
      {preview && <>
        <p className="agent-config__muted">{preview.stage === 'active' ? 'Active agent instructions' : 'Setup consultant instructions · operational tools restricted'} · {new Date(preview.capturedAt).toLocaleTimeString()}</p>
        <pre className="agent-config__prompt" tabIndex={0} aria-label="Assembled system instructions">{preview.instructions}</pre>
      </>}
      <button type="button" className="cfg-btn cfg-btn--secondary" disabled={loading} onClick={() => setRefresh((v) => v + 1)}><Icon name="refresh" size={14} />{error ? 'Retry preview' : 'Refresh preview'}</button>
    </div>
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
      <div className="agent-config__settings">
        <button type="button" aria-label="Permissions" onClick={() => useConfigUI.getState().openAppSettings('permissions')}><span className="agent-config__setting-icon"><ShieldCheck size={18} aria-hidden /></span><span className="agent-config__setting-text"><strong>Permissions</strong><span>App access and approvals</span></span><Icon name="chev_right" /></button>
        <button type="button" aria-label="Skills" onClick={() => useConfigUI.getState().openBotSettings(bot.id, 'skills')}><span className="agent-config__setting-icon"><Glyph name="spark" size={18} /></span><span className="agent-config__setting-text"><strong>Skills</strong><span>Saved methods and checklists</span></span><Icon name="chev_right" /></button>
        <button type="button" aria-label="Routines" onClick={() => useConfigUI.getState().openBotSettings(bot.id, 'routines')}><span className="agent-config__setting-icon"><Icon name="clock" size={18} /></span><span className="agent-config__setting-text"><strong>Routines</strong><span>Scheduled work</span></span><Icon name="chev_right" /></button>
      </div>
    </section>
    <details className="agent-config__preview">
      <summary><span className="agent-config__summary-icon"><Glyph name="gear" size={18} /></span><span>How the harness works</span><Icon name="chev_right" className="agent-config__chevron" /></summary>
      <div className="agent-config__disclosure-body">
        <p>The harness combines the agent’s instructions with the tools and controls that carry out its work.</p>
        <ol className="agent-config__layers">
          <li><strong>Instructions</strong><span>Saved role, workflows and your standing instructions, combined with Swarm’s shared operating rules.</span></li>
          <li><strong>Context</strong><span>Conversation, relevant saved memory and saved skills. Skills are included after activation.</span></li>
          <li><strong>Tools & controls</strong><span>The model requests actions. Swarm checks account access, setup status and required approvals before running tools.</span></li>
          <li><strong>Results</strong><span>Tool results return to the model so it can continue, check its work and report the outcome.</span></li>
        </ol>
      </div>
    </details>
  </>;
}
