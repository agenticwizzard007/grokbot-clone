import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Pool} from 'pg';
import {tenantDriver,assertProvisioningImage,assertQualifiedImage,infrastructureGates} from '../server/src/platform/release-policy.js';
import {createTenantDriver} from '../server/src/platform/provisioner.js';
import {DockerTenants} from '../server/src/platform/docker-tenants.js';
import {FlyTenants} from '../server/src/platform/fly-tenants.js';
const image=`sha256:${'a'.repeat(64)}`;

test('Fly is the default and invalid driver names fail closed',()=>{
  assert.equal(tenantDriver({}),'fly');assert.equal(tenantDriver({TENANT_DRIVER:'fly',NODE_ENV:'production'}),'fly');
  for(const value of ['','Docker','local','fly '])assert.throws(()=>tenantDriver({TENANT_DRIVER:value}),/TENANT_DRIVER/);
});

test('production Docker requires the exact explicit risk acknowledgement',()=>{
  assert.equal(tenantDriver({TENANT_DRIVER:'docker',NODE_ENV:'development'}),'docker');
  for(const value of [undefined,'0','true'])assert.throws(()=>tenantDriver({TENANT_DRIVER:'docker',NODE_ENV:'production',SWARM_ALLOW_DOCKER_TENANTS:value}),/shared-kernel/);
  assert.equal(tenantDriver({TENANT_DRIVER:'docker',NODE_ENV:'production',SWARM_ALLOW_DOCKER_TENANTS:'1'}),'docker');
});

test('Docker qualification never queries or records Fly release gates',async()=>{
  const database={query:async()=>{throw new Error('Docker must not read or write Fly evidence');}} as unknown as Pool;
  await assertProvisioningImage(database,image,{TENANT_DRIVER:'docker',NODE_ENV:'test'});
  await assert.rejects(assertProvisioningImage(database,'busybox:latest',{TENANT_DRIVER:'docker'}),/digest-pinned/);
  await assert.rejects(assertProvisioningImage(database,image,{TENANT_DRIVER:'docker',NODE_ENV:'production'}),/shared-kernel/);
});

test('Fly still needs every approved exact-image infrastructure gate',async()=>{
  let rows:{name:string}[]=[],calls=0;
  const database={query:async(sql:string,args:any[])=>{calls++;assert.match(sql,/approved_at<=now\(\)/);assert.equal(args[0],image);assert.deepEqual(args[1],infrastructureGates);return {rows};}} as unknown as Pool;
  await assert.rejects(assertProvisioningImage(database,image,{}),/qualification evidence/);
  rows=infrastructureGates.filter(name=>name!=='fly-network-isolation').map(name=>({name}));
  await assert.rejects(assertQualifiedImage(database,image),/qualification evidence/);
  rows=infrastructureGates.map(name=>({name}));await assertProvisioningImage(database,image,{TENANT_DRIVER:'fly'});assert.equal(calls,3);
});

test('provisioner selects Docker without Fly credentials and preserves the Fly default',()=>{
  const keys=['TENANT_DRIVER','NODE_ENV','SWARM_ALLOW_DOCKER_TENANTS','DOCKER_HOST','FLY_API_TOKEN','FLY_ORG_SLUG'];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    for(const key of keys)delete process.env[key];process.env.TENANT_DRIVER='docker';
    assert.ok(createTenantDriver() instanceof DockerTenants);
    process.env.NODE_ENV='production';assert.throws(()=>createTenantDriver(),/shared-kernel/);
    delete process.env.TENANT_DRIVER;process.env.FLY_API_TOKEN='fixture';process.env.FLY_ORG_SLUG='fixture';assert.ok(createTenantDriver() instanceof FlyTenants);
  }finally{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
});
