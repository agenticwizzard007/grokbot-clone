/** Public operation labels shared by live events and historical transcript rows.
 * Use identifiers only: never echo arbitrary app arguments or document contents. */
export function appName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/i.test(value)) return undefined;
  const names: Record<string, string> = { gmail: 'Gmail', github: 'GitHub', googlecalendar: 'Google Calendar', googledrive: 'Google Drive', googlesheets: 'Google Sheets', linkedin: 'LinkedIn', notion: 'Notion', slack: 'Slack' };
  return names[value.toLowerCase()] ?? value.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function appToolLabel(name: string, args?: unknown): string | undefined {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  if (name === 'list_app_connections') return 'Checking app connections';
  if (name === 'search_apps') return 'Finding available apps';
  if (name === 'request_app_connection') return `Connecting ${appName(a.toolkit) ?? 'an app'}`;
  if (name === 'SWARM_APPS_SEARCH') return `Finding ${appName(a.toolkit) ?? 'app'} actions`;
  const slug = name === 'SWARM_APPS_EXECUTE' ? a.tool_slug : name;
  if (typeof slug !== 'string' || !/^[A-Z][A-Z0-9]*_[A-Z0-9_]{1,180}$/.test(slug) || /^(COMPOSIO|SWARM)_/.test(slug)) return undefined;
  const [toolkit, ...operation] = slug.split('_');
  const action = operation.join(' ').toLowerCase();
  return `${appName(toolkit) ?? 'Connected app'}: ${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}
