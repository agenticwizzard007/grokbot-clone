import type { WorkTab } from '../../../server/src/lib/user-routes';
// Shared with tool-generated links so chat and copied URLs resolve identically.
export { botSlug, routeBot, linkedWork, workHash } from '../../../server/src/lib/user-routes';
export type { WorkTab, WorkRoute } from '../../../server/src/lib/user-routes';

export const workTabLabel = (tab: WorkTab): string => tab === 'Reports' ? 'Files' : tab;
