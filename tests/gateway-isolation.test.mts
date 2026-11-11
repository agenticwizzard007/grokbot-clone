import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectionGateway, type PrivateConnection, type ConnectionProvider, type ConnectionRegistry } from '../server/src/platform/composio-policy.js';
import { containerArguments } from '../server/src/runtime/container-policy.js';
import { approvalBinding } from '../server/src/security/approval.js';

function fixture() {
  const rows = new Map<string, PrivateConnection>(), dispatched = new Map<string, string>(), calls: { user: string; account: string }[] = [];
  let fail = false;
  const registry: ConnectionRegistry = {
    identity: async t => `composio-${t}`,
    list: async t => [...rows.values()].filter(r => r.tenant === t && r.state === 'active'),
    get: async (t, id) => rows.get(id)?.tenant === t ? rows.get(id) : undefined,
    revoke: async (t, id) => { const r = rows.get(id); if (!r || r.tenant !== t) return false; r.state = 'revoked'; r.revision++; return true; },
    begin: async (t,id,rev,dispatch) => { const r = rows.get(id), k = `${t}:${dispatch}`; if (!r || r.tenant !== t || r.state !== 'active' || rev !== r.revision || dispatched.has(k)) return false; dispatched.set(k, 'dispatching'); return true; },
    finish: async (t, d, state) => { dispatched.set(`${t}:${d}`, state); },
  };
  const provider: ConnectionProvider = {
    owned: async (u,id) => { const r = rows.get(id); return r && u === `composio-${r.tenant}` ? { toolkit: r.toolkit, active: r.state === 'active' } : undefined; },
    tool: async s => ({ toolkit: s.split('_')[0].toLowerCase(), version: '20261101_00' }),
    execute: async (user,account) => { calls.push({ user,account }); if (fail) throw new Error('upstream timeout'); return { ok: true }; },
    disconnect: async () => {}, refresh: async () => ({ ok: true }),
  };
  const add = (tenant: string, toolkit: string, suffix = '') => {
    const row = { id: `account-${tenant}-${toolkit}${suffix}`, tenant, toolkit, revision: 1, state: 'active', isDefault: false };
    rows.set(row.id, row); return row;
  };
  return { rows, calls, dispatched, add, registry,provider, gateway: new ConnectionGateway(registry,provider), fail: () => { fail = true; } };
}
const dispatch = (r: PrivateConnection, id = 'dispatch_00000000001') => ({ connectionId: r.id, revision: r.revision, dispatchId: id, slug: `${r.toolkit.toUpperCase()}_LIST`, arguments: {} });

test('50 Notion and 150 Gmail simulated authorizations stay private across all operations', async () => {
  const f = fixture();
  for (let i = 0; i < 200; i++) {
    const owner = `user-${i}`, toolkit = i < 50 ? 'notion' : 'gmail';
    const r = f.add(owner, toolkit);
    assert.deepEqual((await f.gateway.list(owner)).map(c => c.id), [r.id]);
    await f.gateway.execute(owner, dispatch(r));
    const foreign = `user-${(i + 1) % 200}`;
    for (const action of [() => f.gateway.own(foreign,r.id), () => f.gateway.execute(foreign,dispatch(r)), () => f.gateway.refresh(foreign,r.id), () => f.gateway.disconnect(foreign,r.id)]) await assert.rejects(action, /Connection not found/);
  }
  assert.equal(f.calls.length, 200);
  for (const c of f.calls) assert.equal(c.user, `composio-${f.rows.get(c.account)!.tenant}`);
});
test('multiple accounts require selection; guessed IDs and tool/identity substitution fail', async () => {
  const f = fixture(), a = f.add('alice','gmail'), b = f.add('alice','gmail','-second');
  await assert.rejects(f.gateway.select('alice','gmail'), /Choose/);
  assert.equal((await f.gateway.select('alice','gmail',b.id)).id, b.id);
  await assert.rejects(f.gateway.execute('alice', { ...dispatch(a), slug: 'COMPOSIO_REMOTE_WORKBENCH' }));
  await assert.rejects(f.gateway.execute('alice', { ...dispatch(a), slug: 'NOTION_LIST' }));
  await assert.rejects(f.gateway.execute('alice', { ...dispatch(a), arguments: { userId: 'bob' } }));
  await assert.rejects(f.gateway.execute('alice', { ...dispatch(a), revision: 2 }));
  assert.equal(f.calls.length, 0);
});
test('disconnect and uncertain outcomes prevent subsequent dispatch and automatic replay', async () => {
  const f = fixture(), r = f.add('alice','gmail');
  f.fail();
  await assert.rejects(f.gateway.execute('alice', dispatch(r)), /uncertain/);
  await assert.rejects(f.gateway.execute('alice', dispatch(r)), /already exists/);
  assert.equal(f.dispatched.get('alice:dispatch_00000000001'), 'uncertain');
  await f.gateway.disconnect('alice', r.id);
  await assert.rejects(f.gateway.execute('alice', dispatch(r, 'dispatch_00000000002')));
  assert.equal(f.calls.length, 1);
});
test('revocation while upstream ownership is being checked blocks refresh and tool dispatch',async()=>{
  for(const operation of ['refresh','execute'] as const){
    const f=fixture(),row=f.add('alice','gmail'),owned=f.provider.owned;let refreshed=false;
    f.provider.owned=async(...args)=>{const result=await owned(...args);await f.registry.revoke('alice',row.id);return result;};
    f.provider.refresh=async()=>{refreshed=true;return {};};
    await assert.rejects(operation==='refresh'?f.gateway.refresh('alice',row.id):f.gateway.execute('alice',dispatch(row)),/Connection not found/);
    assert.equal(refreshed,false);assert.equal(f.calls.length,0);
  }
});
test('runtime revocation after dispatch reservation blocks the provider side effect',async()=>{
  const f=fixture(),row=f.add('alice','gmail');
  const gateway=new ConnectionGateway(f.registry,f.provider,async()=>{if(f.dispatched.size)throw new Error('Runtime revoked');});
  await assert.rejects(gateway.execute('alice',dispatch(row)),/uncertain/);
  assert.equal(f.calls.length,0);assert.equal(f.dispatched.get('alice:dispatch_00000000001'),'uncertain');
});
test('container policy forbids mutable images and isolates provider credential mounts', () => {
  const digest = 'registry.example/swarm@sha256:' + 'a'.repeat(64);
  const policy = { tenantId: 'usr_123456789', root: '/data', network: 'swarm-public', runnerImage: digest, mcpImage: digest };
  const name = 'swarm-11111111-1111-1111-1111-111111111111';
  const args = containerArguments(policy, { kind: 'mcp', id: 'mcp_123456789' }, name);
  for (const flag of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pull=never','--pids-limit=128']) assert.ok(args.includes(flag));
  assert.ok(!args.includes('--mount'));
  for (const provider of ['claude','codex'] as const) {
    const mounts = containerArguments(policy, { kind: 'cli', provider }, name).filter(x => x.startsWith('type=bind'));
    assert.deepEqual(mounts, [`type=bind,src=/data/subscriptions/${provider},dst=/home/runner`]);
  }
  assert.throws(() => containerArguments({ ...policy, mcpImage: 'registry.example/swarm:latest' }, { kind: 'mcp', id: 'mcp_123456789' }, name));
  assert.throws(() => containerArguments(policy, { kind: 'cli', provider: '../../app' as any }, name));
});
test('approvals bind owner, bot, connection revision, call and canonical arguments', () => {
  const hash = approvalBinding('a','bot-a','call-a','mcp_revision_1',{ b: 2, a: 1 });
  assert.equal(hash, approvalBinding('a','bot-a','call-a','mcp_revision_1',{ a: 1, b: 2 }));
  for (const args of [ ['b','bot-a','call-a','mcp_revision_1',{a:1,b:2}], ['a','bot-b','call-a','mcp_revision_1',{a:1,b:2}], ['a','bot-a','call-b','mcp_revision_1',{a:1,b:2}], ['a','bot-a','call-a','mcp_revision_2',{a:1,b:2}], ['a','bot-a','call-a','mcp_revision_1',{a:1,b:3}] ] as const) assert.notEqual(hash, approvalBinding(...args));
});
