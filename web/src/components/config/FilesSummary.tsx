import { useEffect, useState } from 'react';
import type { AgentSetupView, Bot } from '@shared/types';
import { useConfigUI, useVersion } from '../../configStore';
import { useStore } from '../../store';
import { ApiError } from '../../lib/api';
import { configApi } from '../../lib/configApi';
import { deliverablesApi } from '../../lib/deliverablesApi';
import { settingsRead } from '../../lib/settingsReads';
import { setupResourceText } from './setupResources';
import { SetupConnectionHelp } from './SetupConnectionHelp';

export function FilesSummary({ bot, onReports }: { bot: Bot; onReports: () => void }) {
  const userId = useStore(state => state.user?.id);
  const setupVersion = useVersion(`setup:${bot.id}`);
  const [reports, setReports] = useState('Checking saved reports...');
  const [setup, setSetup] = useState<AgentSetupView | null>();
  const [setupError, setSetupError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && useStore.getState().user?.id === userId;
    setReports('Checking saved reports...'); setSetup(undefined); setSetupError('');
    void settingsRead(signal => deliverablesApi.list(bot.id, signal), controller.signal).then(({ artifacts }) => {
      if (current()) setReports(artifacts.some(file => file.botId === bot.id)
        ? 'Reports saved by this Bot are ready to view.'
        : 'No saved reports yet. Ask the Bot to save a report and it will appear here.');
    }).catch(() => { if (current()) setReports('Could not check saved reports. Open saved reports to try again.'); });
    if (bot.kind !== 'room') void settingsRead(signal => configApi.agentSetup(bot.id, signal), controller.signal).then(value => {
      if (current()) setSetup(value);
    }).catch(error => {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 404) setSetup(null);
      else setSetupError('Could not check saved setup. Open Setup to try again.');
    });
    return () => controller.abort();
  }, [bot.id, bot.kind, bot.generation, bot.onboarding?.revision, userId, setupVersion]);
  const hasSetup = setup && Object.values(setup.files).some(text => text.trim());
  const resources = setup?.manifest.brief.shared_resources.map(setupResourceText).filter(text => /needs to be reconnected|could not connect|connection unavailable/i.test(text)) ?? [];
  return <>
    <div className="details-page__row"><div><strong>Saved reports</strong><p role="status">{reports}</p></div>
      <button className="cfg-btn cfg-btn--secondary" type="button" onClick={onReports}>View saved reports</button>
    </div>
    {bot.kind !== 'room' && <div className="details-page__row"><div><strong>Setup</strong>
      <p role="status">{setupError || (setup === undefined ? 'Checking saved setup...' : hasSetup ? 'Saved instructions and configuration files for this Bot.' : 'No saved setup yet. Open Setup to describe what this Bot should do.')}</p>
      {resources.map((text, index) => <p key={index}>{text}</p>)}
      <SetupConnectionHelp text={resources.join('\n')} />
    </div><button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => useConfigUI.getState().setDetailsTab('configuration')}>View setup</button></div>}
  </>;
}
