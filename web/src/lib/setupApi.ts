import type { AgentSetupView, Bot } from '@shared/types';
import { nativeRequest } from './learningApi';

type SetupManifest = AgentSetupView['manifest'];
let importedSetup: { userId: string; botId: string } | undefined;

export function queueImportedSetup(userId: string, botId: string) { importedSetup = { userId, botId }; }
export function hasImportedSetup(userId: string | undefined, botId: string) {
  return importedSetup?.userId === userId && importedSetup?.botId === botId;
}
export function clearImportedSetup(userId: string | undefined, botId: string) {
  if (hasImportedSetup(userId, botId)) importedSetup = undefined;
}

export function readSetupManifest(text: string): { manifest: unknown; name: string } {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('This file is not valid JSON. Choose an exported bot-setup.json.'); }
  const manifest = value as Partial<SetupManifest> | null;
  if (!manifest || !['swarm.bot-setup', 'grokbot.bot-setup'].includes(manifest.format ?? '') ||
      (manifest.version !== 1 && manifest.version !== 2) || !manifest.brief || !manifest.source ||
      typeof manifest.bot?.name !== 'string' || !manifest.bot.name.trim() || manifest.bot.name.trim().length > 60) {
    throw new Error('This is not a supported setup manifest. Choose an exported bot-setup.json.');
  }
  return { manifest: value, name: manifest.bot.name.trim() };
}

export const setupApi = {
  importManifest: async (manifest: unknown, name: string, expectedUserId: string) => {
    if (!expectedUserId) throw new Error('Sign in before importing a setup.');
    return nativeRequest<{ bot: Bot | null; computer: AgentSetupView['computer'] }>('/bots/import', 'POST', { manifest, name, expectedUserId });
  },
  retryComputer: (botId: string) =>
    nativeRequest<{ computer: AgentSetupView['computer'] }>(`/bots/${encodeURIComponent(botId)}/setup/retry`, 'POST', {}),
  readFile: async (botId: string, filename: string, signal: AbortSignal) => {
    const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/setup/${encodeURIComponent(filename)}`, { credentials: 'include', signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Couldn’t download the configuration file. Refresh setup and try again.');
    return response.blob();
  },
};
