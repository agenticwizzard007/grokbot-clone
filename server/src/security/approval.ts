import { createHash } from 'node:crypto';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** The MCP name contains connection+revision; bot and exact arguments are independently bound. */
export function approvalBinding(userId: string, botId: string, callId: string, tool: string, args: unknown) {
  return createHash('sha256').update(canonical([userId, botId, callId, tool, args])).digest('hex');
}
