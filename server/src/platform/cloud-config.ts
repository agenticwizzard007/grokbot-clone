/** Endpoint overrides are opt-in even in production-built local Docker images. */
export function cloudEndpointConfig(env: NodeJS.ProcessEnv, prefix: 'TENANT_KMS' | 'BACKUP_S3') {
  const endpoint = env[`${prefix}_ENDPOINT`] || undefined;
  const region = env[`${prefix}_REGION`] || undefined;
  const style = prefix === 'BACKUP_S3' ? env.BACKUP_S3_FORCE_PATH_STYLE || undefined : undefined;
  if ((endpoint || region || style) && env.NODE_ENV === 'production' && env.SWARM_ALLOW_LOCAL_CLOUD !== '1') {
    throw new Error(`${prefix} overrides require SWARM_ALLOW_LOCAL_CLOUD=1 in production.`);
  }
  if (endpoint) {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error(`Invalid ${prefix}_ENDPOINT.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`Invalid ${prefix}_ENDPOINT.`);
    }
  }
  if (region && !/^[a-z0-9-]+$/.test(region)) throw new Error(`Invalid ${prefix}_REGION.`);
  if (style && !['true', 'false', '1', '0'].includes(style)) throw new Error('Invalid BACKUP_S3_FORCE_PATH_STYLE.');
  return {
    // Ignore the SDK's implicit AWS_ENDPOINT_URL/config-file endpoint bypass.
    ignoreConfiguredEndpointUrls: true,
    ...(endpoint ? { endpoint } : {}),
    ...(region ? { region } : {}),
    ...(style ? { forcePathStyle: style === 'true' || style === '1' } : {}),
  };
}
