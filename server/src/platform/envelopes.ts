import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { randomBytes, createCipheriv } from 'node:crypto';
import type { Directory } from './directory.js';
const context = (tenant: string) => ({ tenant, purpose: 'swarm-tenant-master-v1' });
export class TenantEnvelopes {
  private kms = new KMSClient({});
  constructor(private directory: Directory, private keyId = process.env.TENANT_KMS_KEY_ID) { if(!keyId)throw new Error('Managed tenant encryption is required.'); }
  async create(tenant: string) {
    const owner=(await this.directory.pool.query("SELECT encrypted_data_key FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted','failed')",[tenant])).rows[0];
    if(!owner)throw new Error('Tenant revoked.');
    if(owner.encrypted_data_key)return;
    const result = await this.kms.send(new GenerateDataKeyCommand({KeyId:this.keyId,KeySpec:'AES_256',EncryptionContext:context(tenant)}));
    if(!result.CiphertextBlob||!result.Plaintext)throw new Error('KMS key creation failed.');
    try { await this.directory.pool.query("UPDATE tenants SET encrypted_data_key=$2 WHERE id=$1 AND encrypted_data_key IS NULL AND state NOT IN ('deleting','deleted','failed')",[tenant,Buffer.from(result.CiphertextBlob)]); }
    finally { result.Plaintext.fill(0); }
  }
  async key(tenant: string) {
    const row=(await this.directory.pool.query("SELECT encrypted_data_key FROM tenants WHERE id=$1 AND state NOT IN ('deleted','failed')",[tenant])).rows[0];
    if(!row?.encrypted_data_key)throw new Error('Tenant encryption key unavailable.');
    const result=await this.kms.send(new DecryptCommand({KeyId:this.keyId,CiphertextBlob:row.encrypted_data_key,EncryptionContext:context(tenant)}));
    if(result.Plaintext?.length!==32)throw new Error('Invalid tenant key.');
    try { return Buffer.from(result.Plaintext); } finally { result.Plaintext.fill(0); }
  }
  async encrypt(tenant: string, purpose: string, value: unknown) {
    const key=await this.key(tenant);
    try{
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
      cipher.setAAD(Buffer.from(JSON.stringify([tenant,purpose,1])));
      const encrypted=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
      return `private1:${Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url')}`;
    }finally{key.fill(0);}
  }
  async event(tenant: string, id: string, payload: unknown, requiredSession?:string) {
    const secret=await this.encrypt(tenant,`event:${id}`,payload);
    await this.directory.transaction(async client=>{
      if(!(await client.query("SELECT 1 FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted','failed') FOR UPDATE",[tenant])).rowCount)throw new Error('account_revoked');
      if(requiredSession&&!(await client.query(`SELECT 1 FROM sessions WHERE hash=$1 AND tenant_id=$2 AND expires_at>now()
        AND last_seen_at>now()-interval '24 hours' AND authenticated_at>now()-interval '10 minutes' FOR UPDATE`,[requiredSession,tenant])).rowCount)throw new Error('reauth_required');
      await client.query('INSERT INTO wake_events(tenant_id,id,ciphertext) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[tenant,id,Buffer.from(secret)]);
    });
  }
}
