export const NAV_IDS = ['allBots', 'tasks', 'files', 'search', 'dashboards', 'yourBots', 'createBot', 'usage', 'settings', 'routines'] as const;
export type NavId = typeof NAV_IDS[number];
const labels = ['All Bots', 'Tasks', 'Artifacts', 'Search', 'Dashboards', 'Your Bots', 'Create a Bot', 'Usage', 'Settings', 'Routines'];
export const NAV = NAV_IDS.map((id, i) => ({ id, label: labels[i], hideable: id !== 'settings', sidebar: id !== 'search', phoneTab: ({ allBots: 'bots', tasks: 'tasks', routines: 'routines', usage: 'usage', files: 'files', search: 'search', settings: 'settings' } as Record<string, string>)[id] ?? null }));
export const SIDEBAR_WIDTHS = { narrow: 240, default: 272, wide: 320 } as const;
export const CHAT_WIDTHS = { default: 752, wide: 920 } as const;
