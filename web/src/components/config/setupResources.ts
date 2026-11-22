import { toolkitDisplayName } from './settingsLogic';

const connectionStates: Record<string, string> = {
  ACTIVE: 'Connected', CONNECTED: 'Connected', EXPIRED: 'Reconnect required',
  INACTIVE: 'Not connected', DISCONNECTED: 'Not connected', REVOKED: 'Access revoked',
  INITIATED: 'Connection pending', INITIALIZING: 'Connection pending', PENDING: 'Connection pending',
  FAILED: 'Connection failed', ERROR: 'Connection unavailable',
};

/** Saved resource descriptions can contain connection metadata from older setup briefs. */
export function setupResourceText(text: string): string {
  let result = text;
  const apps: string[] = [];
  result = result.replace(/\btoolkit(?:\s*[:=]\s*|\s+)([a-z0-9_-]+)/gi, (_match, slug: string) => {
    apps.push(toolkitDisplayName(slug.toLowerCase()));
    return '';
  });
  result = result
    .replace(/\brevision\s*[:=]?\s*\d+\b/gi, '')
    .replace(/\bstatus(?:\s*[:=]\s*|\s+)([a-z][a-z_-]*)\b/gi, (_match, state: string) => connectionStates[state.toUpperCase()] ?? 'Check connection')
    .replace(/\baccount\s+(?:the\s+)?connected account\b/gi, 'account');
  for (const app of new Set(apps)) {
    if (!result.toLowerCase().includes(app.toLowerCase())) result = `${app}, ${result}`;
  }
  return result.replace(/\s*([,;])(?:\s*[,;])*/g, '$1 ')
    .replace(/[(\[]\s*[,;]?\s*[)\]]/g, '')
    .replace(/([([])\s*[,;]/g, '$1').replace(/[,;]\s*([)\]])/g, '$1')
    .replace(/\s+/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '').trim();
}
