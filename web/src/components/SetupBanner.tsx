import { useState } from 'react';
import type { Bot } from '@shared/types';
import { api } from '../lib/api';
import { queueImportedSetup } from '../lib/setupApi';
import { toast } from '../lib/toast';
import { useStore } from '../store';
import './setup-banner.css';

/** Configuring Bots get a visible way to finish or skip setup (MF-010, PD-02). */
type SetupAware = Pick<Bot, 'kind'> & { onboarding?: { status: string } | null };
export function needsSetupBanner(bot: SetupAware): boolean {
  // Bot payloads without onboarding come from older servers; treat them as active.
  return bot.kind !== 'room' && !!bot.onboarding && bot.onboarding.status !== 'active';
}

/** Open Details on the Setup tab, even if Details is already open on another tab. */
export function openSetupDetails(botId: string) {
  const state = useStore.getState();
  const reopen = () => {
    const current = useStore.getState();
    if (current.user?.id) queueImportedSetup(current.user.id, botId);
    current.set({ detailsOpen: true });
  };
  if (state.detailsOpen) { state.set({ detailsOpen: false }); requestAnimationFrame(reopen); }
  else reopen();
}

export function SetupBanner({ bot }: { bot: Bot }) {
  const [busy, setBusy] = useState(false);
  if (!needsSetupBanner(bot as Bot & SetupAware)) return null;
  const skip = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.skipSetup(bot.id);
      toast(`${bot.name} is ready to work`);
      useStore.getState().loadBots().catch(() => {});
    } catch (error) {
      toast((error as Error).message || 'Could not skip setup', { tone: 'error' });
    } finally { setBusy(false); }
  };
  return <div className="setup-banner" role="region" aria-label={`${bot.name} setup`}>
    <span className="setup-banner__text">{bot.name} is being set up. Answer a few questions, or start using it now.</span>
    <span className="setup-banner__actions">
      <button type="button" className="btn btn--sm btn--secondary" onClick={() => openSetupDetails(bot.id)}>Review and activate</button>
      <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={skip}>{busy ? 'Skipping...' : 'Skip setup'}</button>
    </span>
  </div>;
}
