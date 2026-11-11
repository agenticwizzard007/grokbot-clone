/** Deployment identity is immutable for the lifetime of a process. */
export const roles = ['standalone', 'platform', 'provisioner', 'composio-gateway', 'tenant'] as const;
export type DeploymentRole = typeof roles[number];
const configured = process.env.SWARM_ROLE;
const value = configured ?? 'standalone';
if (!roles.includes(value as DeploymentRole)) throw new Error('Invalid SWARM_ROLE');
export const deploymentRole = value as DeploymentRole;
export const production = process.env.NODE_ENV === 'production';
export const tenantId = process.env.SWARM_TENANT_ID ?? '';
export const isTenant = deploymentRole === 'tenant';
export function validateDeployment() {
  // A production process must name its role. SWARM_ROLE=standalone is the single shared server this app has always been
  // (fly.toml sets it); the other roles are the isolated platform. Leaving SWARM_ROLE unset is refused so a tenant image
  // can never start as a shared multi-user server by accident.
  if (production && configured === undefined) throw new Error('Production requires SWARM_ROLE. Set SWARM_ROLE=standalone for the single-server deployment, or one of platform, provisioner, composio-gateway, tenant.');
  if (production && process.env.DEV_LOGIN === '1') throw new Error('Development authentication is forbidden in production.');
  if (isTenant) {
    if (!/^usr_[A-Za-z0-9_-]{8,100}$/.test(tenantId)) throw new Error('Tenant identity is required.');
    for (const name of ['COMPOSIO_API_KEY', 'COMPOSIO_WEBHOOK_SECRET', 'FLY_API_TOKEN', 'DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'INKBOX_ADMIN_API_KEY', 'INKBOX_API_KEY', 'DIRECT_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GOOGLE_CLIENT_SECRET', 'APPLE_PRIVATE_KEY']) {
      if (process.env[name]) throw new Error(`Platform credential ${name} is forbidden in a tenant process.`);
    }
    if (!process.env.TENANT_DATA_KEY_FILE || !process.env.TENANT_MANIFEST_FILE) throw new Error('Tenant key and volume manifest are required.');
    if (production && process.env.COMPUTER_PROVIDER !== 'local') throw new Error('Tenant desktops must use the local isolated companion.');
  }
}
export function assertTenant(userId: string) {
  if (isTenant && userId !== tenantId) throw new Error('Tenant identity mismatch.');
}
