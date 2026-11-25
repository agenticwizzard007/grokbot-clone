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
    .replace(/\s+(?:at|from)\s+revision\s*[:=]?\s*\d+\b/gi, '')
    .replace(/\brevision\s*[:=]?\s*\d+\b/gi, '')
    .replace(/\bstatus(?:\s*[:=]\s*|\s+)([a-z][a-z_-]*)\b/gi, (_match, state: string) => connectionStates[state.toUpperCase()] ?? 'Check connection')
    .replace(/\baccount\s+(?:the\s+)?connected account\b/gi, 'account')
    .replace(/\b(?:account\s+)?(?:is|was)\s+(ACTIVE|CONNECTED|EXPIRED|INACTIVE|DISCONNECTED|REVOKED|INITIATED|INITIALIZING|PENDING|FAILED|ERROR)\b/g, (_match, state: string) => state === 'EXPIRED' ? 'connection expired' : connectionStates[state].toLowerCase())
    .replace(/\b(ACTIVE|CONNECTED|EXPIRED|INACTIVE|DISCONNECTED|REVOKED|INITIATED|INITIALIZING|PENDING|FAILED|ERROR)\b/g, state => state === 'EXPIRED' ? 'connection expired' : connectionStates[state].toLowerCase());
  for (const app of new Set(apps)) {
    if (!result.toLowerCase().includes(app.toLowerCase())) result = `${app}, ${result}`;
  }
  return result.replace(/\s*([,;])(?:\s*[,;])*/g, '$1 ')
    .replace(/[(\[]\s*[,;]?\s*[)\]]/g, '')
    .replace(/([([])\s*[,;]/g, '$1').replace(/[,;]\s*([)\]])/g, '$1')
    .replace(/\s+/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '').trim()
    .replace(/, (connection expired|connected|not connected|access revoked|connection pending|connection failed|connection unavailable)$/, ' $1');
}

/** Format the displayed Markdown only. Downloads and agent instructions keep the original bytes. */
export function setupFileText(text: string): string {
  return text.split('\n').map(line => {
    if (/^\s*(?:[-*]\s*)?(?:setup\s+)?revision\s*[:=]?\s*\d+\s*$/i.test(line)) return '';
    const prefix = line.match(/^\s*(?:[-*] |\d+\. )?/)?.[0] ?? '';
    return prefix + setupResourceText(line.slice(prefix.length));
  }).join('\n');
}
