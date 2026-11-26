import { useEffect, useState } from 'react';
import { api, type AccountPreferences } from '../../lib/api';
import { cliApi } from '../../lib/cliApi';
import { useStore } from '../../store';

/** Shared account control in Permissions and Models & access. */
export function ApprovalLevelSettings({ selectedCli, explain = false }: { selectedCli?: string | null; explain?: boolean }) {
  const accountId = useStore(s => s.user?.id);
  const [preferences, setPreferences] = useState<AccountPreferences | null>(null);
  const [cli, setCli] = useState<string | null | undefined>(selectedCli);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (selectedCli !== undefined) setCli(selectedCli); }, [selectedCli]);
  useEffect(() => {
    let active = true;
    setPreferences(null); setError('');
    api.preferences().then(p => { if (active) setPreferences(p); }).catch(() => { if (active) setError('Could not load approval settings. Reopen Settings to try again.'); });
    if (selectedCli === undefined) cliApi.status().then(s => { if (active) setCli(s.selected); }).catch(() => { if (active) setError('Could not check your model access. Reopen Settings to try again.'); });
    return () => { active = false; };
  }, [accountId]);
  const maximum = preferences?.apiApprovalLevel === 'every_action';
  const change = async (apiApprovalLevel: AccountPreferences['apiApprovalLevel']) => {
    setSaving(true); setError('');
    try {
      const saved = await api.updatePreferences({ apiApprovalLevel });
      if (useStore.getState().user?.id === accountId) setPreferences(saved);
    } catch { setError('Could not save your approval setting. Try again.'); }
    finally { setSaving(false); }
  };
  return <section className="cfg-section api-approval-settings" aria-label="API approval settings">
    <h2 className="cfg-section__label">API approval level</h2>
    <label className="cfg-field">
      <span>When Bots use API providers</span>
      <select className="text-input" aria-label="API approval level" value={maximum ? 'every_action' : 'standard'} disabled={!preferences || cli === undefined || !!cli || saving} onChange={e => void change(e.target.value as AccountPreferences['apiApprovalLevel'])}>
        <option value="standard">Standard</option>
        <option value="every_action">Ask before every action</option>
      </select>
    </label>
    {!!cli && <p>This applies when you use API providers. Your selected CLI plan keeps its current permissions.</p>}
    {explain && <p>{cli
      ? 'With a CLI plan, Bots use memory, tasks, skills, files and reads of connected apps without asking. Actions on your behalf in outside services, such as sending or drafting email or messages, changing a connected app or posting, ask first unless you have always allowed them.'
      : maximum
        ? 'Every action asks first, including memory, tasks, skills, files, connected app reads and computer use. Nothing runs until you approve it. Only Always allow choices made at this level can skip later prompts.'
        : 'With Standard, Bots use memory, tasks, skills, files and verified reads of connected apps without asking. Sending or drafting email or messages, changing a connected app and posting ask first unless you have always allowed them. Unverified app reads and tools from other servers may also ask. Computer actions follow your Computer settings.'}</p>}
    {!cli && maximum && <p>Provider search is unavailable at this level. Ask your Bot to use its browser with approval. Standard permissions do not apply here. Always allow choices made at this level are saved separately and return when you turn it on again. Account time zone changes always ask once.</p>}
    {!explain && !cli && !maximum && <p>Standard keeps your current permissions. Choose Ask before every action to approve each action before it runs.</p>}
    {error && <p className="cfg-error" role="alert">{error}</p>}
  </section>;
}
