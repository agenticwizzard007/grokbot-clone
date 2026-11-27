export const COMPONENT_IDS = ['sidebar.search', 'sidebar.usage', 'sidebar.account', 'chat.runLog', 'chat.avatars', 'chat.safetyNote', 'chat.modelChip', 'header.voiceButton', 'bots.statusChips', 'bots.roomsSection', 'tasks.filters', 'phone.tabLabels'] as const;
export type ComponentId = typeof COMPONENT_IDS[number];
export type ComponentVisibility = 'show' | 'hide' | 'collapsed';
const labels = ['Search in the sidebar', 'Usage in the sidebar', 'Account in the sidebar', 'Run log', 'Chat avatars', 'Safety note', 'Model chip', 'Voice button', 'Bot status chips', 'Rooms section', 'Task filters', 'Phone tab labels'];
export const COMPONENTS = COMPONENT_IDS.map((id, i) => ({ id, label: labels[i], allowed: (id === 'chat.runLog' ? ['show', 'collapsed', 'hide'] : ['show', 'hide']) as ComponentVisibility[], default: (id === 'chat.runLog' ? 'collapsed' : 'show') as ComponentVisibility }));
