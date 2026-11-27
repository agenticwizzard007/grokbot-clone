import { Card, ButtonGroup } from './layout';
import { useState } from 'react';
import type { Bot } from '@shared/types';
import { api } from '../lib/api';
import { openConversation, useConfigUI } from '../configStore';
import { toast } from '../lib/toast';
import { useStore } from '../store';
import { isInSetup } from '../lib/botSetupState';
import './setup-banner.css';

/** Configuring Bots get a visible way to finish or skip setup (MF-010, PD-02). */
type SetupAware = Pick<Bot, 'kind'> & { onboarding?: { status: string } | null };
export function needsSetupBanner(bot: SetupAware): boolean {
  return isInSetup(bot);
}

/** Open Details on the Setup tab, even if Details is already open on another tab. */
export function openSetupDetails(botId: string) {
  if (useStore.getState().selectedBotId !== botId) openConversation(botId);
  useConfigUI.getState().setDetailsTab('configuration');
}

export function SetupBanner({ bot }: { bot: Bot }) {
  const [busy, setBusy] = useState(false);
  if (!needsSetupBanner(bot as Bot & SetupAware)) return null;
  const skip = async () => {
    if (busy) return;
    const accountId = useStore.getState().user?.id;
    setBusy(true);
    try {
      const result = await api.skipSetup(bot.id);
      if (useStore.getState().user?.id !== accountId) return;
      const currentBot = useStore.getState().bots.find(current => current.id === bot.id);
      if (!currentBot || (currentBot.onboarding?.revision ?? 0) > (result.bot.onboarding?.revision ?? 0)) return;
      useStore.setState(state => ({ bots: state.bots.map(current => current.id === bot.id ? { ...current, onboarding: result.bot.onboarding } : current) }));
      toast(`${bot.name} is ready to work`);
    } catch (error) {
      if (useStore.getState().user?.id === accountId) toast((error as Error).message || 'Could not skip setup', { tone: 'error' });
    } finally { setBusy(false); }
  };
  return <Card className="setup-banner" role="region" aria-label={`${bot.name} setup`}>
    <span className="setup-banner__text">Finish setup</span>
    <ButtonGroup stack className="setup-banner__actions">
      <button type="button" className="btn btn--sm btn--secondary" onClick={() => openSetupDetails(bot.id)}>Review setup</button>
      <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={skip}>{busy ? 'Skipping...' : 'Skip setup'}</button>
    </ButtonGroup>
  </Card>;
}
