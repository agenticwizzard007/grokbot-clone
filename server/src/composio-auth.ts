import { env } from './env.js';

/** Platform credentials stay on the server. Connect/MCP consumer keys cannot serve app users. */
export function composioCredentials(key = env.composioKey) {
  if (key.startsWith('ck_')) throw new Error('This is a personal Composio MCP key. Use a Platform project key or an authorized developer user key for the app.');
  if (key.startsWith('uak_')) {
    const orgId = env.composioOrgId;
    const projectId = env.composioProjectId;
    if (!orgId || !projectId) throw new Error('A Composio user key needs COMPOSIO_ORG_ID and COMPOSIO_PROJECT_ID to select this app’s developer project.');
    return { apiKey: null, userApiKey: key, orgApiKey: null, orgId, projectId };
  }
  return { apiKey: key, userApiKey: null, orgApiKey: null };
}

export function composioHeaders(key = env.composioKey): Record<string, string> {
  const credentials = composioCredentials(key);
  return credentials.userApiKey
    ? { 'x-user-api-key': credentials.userApiKey, 'x-org-id': credentials.orgId!, 'x-project-id': credentials.projectId! }
    : { 'x-api-key': credentials.apiKey! };
}

/** Includes scope so changing projects invalidates cached catalogs and sessions too. */
export const composioIdentity = () => JSON.stringify(composioHeaders());
