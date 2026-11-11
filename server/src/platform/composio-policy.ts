import { createHash } from 'node:crypto';
import type { Tool } from '@composio/core';

/** The SDK ToolSchema exposes tags?: string[]; schema.readOnly and slug names are not attestations. */
export function trustedReadOnly(tool: Pick<Tool, 'tags'>): boolean {
  return Array.isArray(tool.tags) && tool.tags.includes('readOnlyHint') &&
    !tool.tags.some(tag => ['createHint', 'updateHint', 'destructiveHint'].includes(tag));
}
export function publicAppTools(tools: Tool[], toolkit: string) {
  return tools.filter(t => /^[A-Z][A-Z0-9_]{2,199}$/.test(t.slug) && !t.slug.startsWith('COMPOSIO_') && t.toolkit?.slug === toolkit)
    .map(t => ({ slug: t.slug, description: t.description, parameters: t.inputParameters, readOnly: trustedReadOnly(t) }));
}
export function appArguments(args: unknown): asserts args is Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid app arguments.');
  for (const key of ['tenantId', 'userId', 'user_id', 'connectedAccountId', 'connected_account_id', 'authConfigId', 'sessionId']) {
    if (Object.hasOwn(args, key)) throw new Error('Connection identity overrides are forbidden.');
  }
}
export interface PrivateConnection { id: string; tenant: string; toolkit: string; revision: number; state: string; isDefault: boolean }
export interface ConnectionRegistry {
  identity(tenant: string): Promise<string>;
  list(tenant: string): Promise<PrivateConnection[]>;
  get(tenant: string, id: string): Promise<PrivateConnection | undefined>;
  revoke(tenant: string, id: string): Promise<boolean>;
  begin(tenant: string, id: string, revision: number, dispatch: string, tool: string, argumentsHash: string): Promise<boolean>;
  finish(tenant: string, dispatch: string, state: 'completed' | 'uncertain'): Promise<void>;
}
export interface ConnectionProvider {
  owned(identity: string, id: string): Promise<{ toolkit: string; active: boolean } | undefined>;
  tool(slug: string): Promise<{ toolkit: string; version: string; readOnly?: boolean }>;
  execute(identity: string, connection: string, slug: string, version: string, args: Record<string, unknown>): Promise<unknown>;
  disconnect(id: string): Promise<void>;
  refresh(id: string): Promise<unknown>;
}
export class ConnectionNotFound extends Error { constructor() { super('Connection not found.'); } }
/** Deliberately no administration, arbitrary proxy, remote code execution, or Tool Router passthrough. */
export class ConnectionGateway {
  constructor(private registry: ConnectionRegistry, private provider: ConnectionProvider, private authorize:()=>Promise<unknown>=async()=>{}) {}
  async own(tenant: string, id: string, revision?: number) {
    const found = await this.registry.get(tenant, id);
    const row=found?{...found}:undefined;
    if (!row || row.tenant !== tenant || row.state !== 'active' || (revision !== undefined && row.revision !== revision)) throw new ConnectionNotFound();
    const identity = await this.registry.identity(tenant);
    const remote = await this.provider.owned(identity, id);
    if (!remote || !remote.active || remote.toolkit !== row.toolkit) throw new ConnectionNotFound();
    const current=await this.registry.get(tenant,id);
    if(!current||current.state!=='active'||current.tenant!==tenant||current.revision!==row.revision||current.toolkit!==row.toolkit)throw new ConnectionNotFound();
    await this.authorize();
    return { row:current, identity };
  }
  async list(tenant: string) {
    const rows = await this.registry.list(tenant);
    const result: PrivateConnection[] = [];
    for (const row of rows) {
      try { await this.own(tenant, row.id); result.push(row); }
      catch (e) { if (!(e instanceof ConnectionNotFound)) throw e; }
    }
    return result;
  }
  async select(tenant: string, toolkit: string, id?: string) {
    if (id) { const own = await this.own(tenant, id); if (own.row.toolkit !== toolkit) throw new ConnectionNotFound(); return own.row; }
    const rows = (await this.list(tenant)).filter(c => c.toolkit === toolkit);
    const choice = rows.length === 1 ? rows[0] : rows.find(c => c.isDefault);
    if (!choice) throw new Error('Choose a specific connected account.');
    return choice;
  }
  async execute(tenant: string, input: { connectionId: string; revision: number; dispatchId: string; slug: string; arguments: Record<string, unknown>; readOnly?: boolean }) {
    if (!/^[A-Z][A-Z0-9_]{2,199}$/.test(input.slug) || input.slug.startsWith('COMPOSIO_')) throw new Error('Unsupported app operation.');
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(input.dispatchId) || !Number.isSafeInteger(input.revision)) throw new Error('Invalid dispatch.');
    if (input.readOnly !== undefined && typeof input.readOnly !== 'boolean') throw new Error('Invalid execution mode.');
    appArguments(input.arguments);
    const { row, identity } = await this.own(tenant, input.connectionId, input.revision);
    const tool = await this.provider.tool(input.slug);
    if (tool.toolkit !== row.toolkit || !tool.version || tool.version === 'latest') throw new Error('Tool does not belong to the selected app or has no pinned version.');
    if (input.readOnly && tool.readOnly !== true) throw new Error('Setup requires a provider-verified read-only app tool. Write or unknown tool metadata is refused.');
    const hash = createHash('sha256').update(JSON.stringify(input.arguments)).digest('hex');
    if (!await this.registry.begin(tenant, row.id, row.revision, input.dispatchId, input.slug, hash)) throw new Error('Dispatch already exists or authorization changed. Inspect its outcome before retrying.');
    try {
      await this.authorize();
      const result = await this.provider.execute(identity, row.id, input.slug, tool.version, input.arguments);
      await this.registry.finish(tenant, input.dispatchId, 'completed');
      return result;
    } catch {
      await this.registry.finish(tenant, input.dispatchId, 'uncertain');
      throw new Error('Provider outcome is uncertain. This operation will not be replayed automatically.');
    }
  }
  async disconnect(tenant: string, id: string) {
    await this.own(tenant, id);
    // Local revocation is durable before the provider request; a failed deletion never re-enables dispatch.
    if (!await this.registry.revoke(tenant, id)) throw new ConnectionNotFound();
    await this.authorize();
    await this.provider.disconnect(id);
  }
  async refresh(tenant: string, id: string) { await this.own(tenant, id); return this.provider.refresh(id); }
}
