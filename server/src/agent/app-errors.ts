/** Only controlled classifications cross the app/CLI boundary, never provider payloads. */
export function appFailure(error: any): { code: string; message: string } {
  const status = error?.status ?? error?.cause?.status;
  if (['TimeoutError', 'AbortError', 'APIConnectionTimeoutError'].includes(error?.name) || [408, 504].includes(status)) return { code: 'app_timeout', message: 'The app request timed out. Try again later.' };
  if (status === 401) return { code: 'app_auth', message: 'The app rejected authorization. Open Connected apps to check the account and reconnect if needed.' };
  if (status === 403) return { code: 'app_access', message: 'The app denied access to this operation. Check the account permissions in Connected apps.' };
  if (status === 429) return { code: 'app_rate_limit', message: 'The app is receiving too many requests. Try again later.' };
  if (typeof status === 'number' && status >= 500) return { code: 'app_provider', message: 'The app service is temporarily unavailable. Try again later.' };
  if (['Connection not found.', 'Choose a specific connected account.'].includes(error?.message)) return { code: 'app_selection', message: 'The selected account or connection revision is no longer available. Check Connected apps, then select the current active account.' };
  if (['Invalid app arguments.', 'Connection identity overrides are forbidden.'].includes(error?.message) || status === 400 || status === 422) return { code: 'app_arguments', message: 'The app rejected the request arguments. Check the tool schema before trying again.' };
  if (error?.message === 'Invalid tool selection.') return { code: 'app_tool_selection', message: 'The selected tool is no longer available for this app. Discover the current app tools before trying again.' };
  return { code: 'app_operation', message: 'The app request could not be completed. Try again later. This does not mean the account is disconnected.' };
}

/** A persisted app failure, safe to show after native MCP has received its result. */
export class AppToolFailure extends Error {}
