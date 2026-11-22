import type { Bot } from '@shared/types';

/**
 * A Bot still in setup cannot join a group until it is activated (MF-034, R2F-008).
 * Bot payloads without onboarding come from older servers; treat them as active.
 */
export function isInSetup(bot: Pick<Bot, 'kind'> & { onboarding?: { status: string } | null }): boolean {
  return bot.kind !== 'room' && !!bot.onboarding && bot.onboarding.status !== 'active';
}

export const ACTIVATE_FIRST = 'Activate first';
export const activateBeforeGroup = (name: string) => `Activate ${name} before adding it to a group.`;
