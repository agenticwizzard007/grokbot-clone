import { selectedCli } from '../cli/store.js';
import { accountPreferences } from '../settings.js';

/** The stored API preference never changes a selected CLI plan's policy. */
export function asksBeforeEveryAction(userId: string | null | undefined): boolean {
  return !!userId && !selectedCli(userId) && accountPreferences(userId).apiApprovalLevel === 'every_action';
}
export const MAX_APPROVAL_PREFIX = 'api_max:';

export const MAX_APPROVAL_INSTRUCTIONS = 'Ask before every action is on for API providers. Every tool call, including internal reads, memory, skills, files, setup, delegation and nested code calls, waits for an approval card unless the user saved Always allow at this level. Request the needed tool normally, then wait for the actual card decision. Never claim an action ran before its result. Provider-native search is disabled; browser tools remain available with approval.';
