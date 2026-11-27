import { Section, Card, Row } from '../layout';
import { InfoTip } from './SettingsControls';
import { useEffect, useState } from 'react';
import { api, type AccountPreferences } from '../../lib/api';
import { cliApi } from '../../lib/cliApi';
import { useStore } from '../../store';

/** Shared account control in Permissions and Models & access. */
export function ApprovalLevelSettings({ selectedCli }: { selectedCli?: string | null; explain?: boolean }) {
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
  return <Section title={<>Approval level <InfoTip label="About approvals">{cli ? 'Plan permissions apply. Switch to API billing to change this setting.' : maximum ? 'Every action asks first. Always allow choices are saved separately for this level.' : 'External actions and unverified reads ask first. Computer actions follow Computer settings.'}</InfoTip></>} aria-label="API approval settings">
    <Card variant="list"><div role="radiogroup" aria-label="API approval level">
      {([{value:'standard',label:'External actions',note:'Recommended'}, {value:'every_action',label:'Ask before every action',note:''}, {value:'never',label:'Never ask',note:'Unavailable'}] as const).map(option => <Row key={option.value} leading={<input type="radio" id={`approval-${option.value}`} name="api-approval" value={option.value} checked={option.value === (maximum ? 'every_action' : 'standard')} disabled={option.value === 'never' || !preferences || cli === undefined || !!cli || saving} onChange={() => { if (option.value !== 'never') void change(option.value); }} />} title={<label htmlFor={`approval-${option.value}`}>{option.label}</label>} subtitle={option.note || undefined} />)}
    </div></Card>
    {error && <p className="cfg-error" role="alert">{error}</p>}
  </Section>;
}
