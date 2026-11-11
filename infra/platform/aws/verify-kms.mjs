// Verify a KMS key against the platform's exact envelope contract (server/src/platform/envelopes.ts):
// GenerateDataKey AES_256 with EncryptionContext {tenant, purpose:'swarm-tenant-master-v1'}, Decrypt with the same
// context, and refusal when the tenant context differs. Uses the ambient AWS credential chain. No data is stored.
import { KMSClient, GenerateDataKeyCommand, DecryptCommand, DescribeKeyCommand } from '@aws-sdk/client-kms';
const keyId = process.argv[2] ?? process.env.TENANT_KMS_KEY_ID;
if (!keyId) { console.error('usage: node infra/platform/aws/verify-kms.mjs <key ARN>'); process.exit(2); }
const kms = new KMSClient({});
const context = (tenant) => ({ tenant, purpose: 'swarm-tenant-master-v1' });
const tenant = 'usr_verify_' + Date.now().toString(36);
const results = {};
const described = await kms.send(new DescribeKeyCommand({ KeyId: keyId }));
results.key = { arn: described.KeyMetadata.Arn, enabled: described.KeyMetadata.Enabled, spec: described.KeyMetadata.KeySpec, rotation: undefined };
const generated = await kms.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256', EncryptionContext: context(tenant) }));
results.generate = { plaintextBytes: generated.Plaintext.length, ciphertextBytes: generated.CiphertextBlob.length };
const decrypted = await kms.send(new DecryptCommand({ KeyId: keyId, CiphertextBlob: generated.CiphertextBlob, EncryptionContext: context(tenant) }));
results.decryptSameTenant = Buffer.from(decrypted.Plaintext).equals(Buffer.from(generated.Plaintext)) ? 'matches' : 'MISMATCH';
try {
  await kms.send(new DecryptCommand({ KeyId: keyId, CiphertextBlob: generated.CiphertextBlob, EncryptionContext: context('usr_other_tenant') }));
  results.decryptOtherTenant = 'ACCEPTED (unexpected)';
} catch (error) { results.decryptOtherTenant = `refused (${error.name})`; }
try {
  await kms.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256', EncryptionContext: { tenant, purpose: 'something-else' } }));
  results.wrongPurpose = 'ACCEPTED (the identity is not restricted by purpose; use the CloudFormation policy)';
} catch (error) { results.wrongPurpose = `refused (${error.name})`; }
const ok = results.key.enabled && results.generate.plaintextBytes === 32 && results.decryptSameTenant === 'matches' && results.decryptOtherTenant.startsWith('refused');
console.log(JSON.stringify({ ok, ...results }, null, 2));
process.exit(ok ? 0 : 1);
