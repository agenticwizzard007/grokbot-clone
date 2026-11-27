import { useEffect, useState, type ReactNode } from 'react';
import { APP_SECTIONS, BOT_TABS, SETTINGS_LABELS, dashboardSlug } from '../lib/navigation';
import { botSlug } from '../lib/userRoutes';
import { useStore } from '../store';
import { useUiConfig, useEffectiveConfig } from '../customization';
import { Page, Section, Card, Row } from './layout';

/** Fixed recovery links are independent of every configurable visibility/order value. */
export function allSectionLinks(bots: { id: string; name: string }[], dashboards: { id: string; name: string }[]) {
  return [
    { group: 'Sections', label: 'Bots', href: '#bots' },
    { group: 'Sections', label: 'Tasks', href: '#tasks' },
    { group: 'Sections', label: 'Loops', href: '#loops' },
    { group: 'Sections', label: 'Files', href: '#reports' },
    { group: 'Sections', label: 'Team', href: '#team' },
    { group: 'Sections', label: 'Goals', href: '#goals' },
    { group: 'Sections', label: 'Routines', href: '#all/routines' },
    { group: 'Sections', label: 'Search', href: '#search' },
    { group: 'Sections', label: 'Connect apps', href: '#apps/connect' },
    { group: 'Sections', label: 'Create a Bot', href: '#new-bot' },
    { group: 'Sections', label: 'Create a group', href: '#new-bot/group' },
    { group: 'Sections', label: 'Set up Swarm', href: '#first-run' },
    { group: 'Settings', label: 'Settings', href: '#settings' },
    { group: 'Settings', label: 'About your use', href: '#settings/appearance/use' },
    ...APP_SECTIONS.map(id => ({ group: 'Settings', label: SETTINGS_LABELS[id], href: `#settings/${id}` })),
    ...dashboards.map(d => ({ group: 'Dashboards', label: d.name, href: `#dash/${dashboardSlug(d)}` })),
    ...bots.flatMap(bot => {
      const root = `#bot/${botSlug(bot)}`, group = bot.name;
      return [
        { group, label: 'Chat', href: root },
        { group, label: 'Flow', href: `${root}/details/flow` },
        ...['tasks', 'team', 'goals', 'reports'].map(id => ({ group, label: id === 'reports' ? 'Files' : id[0].toUpperCase() + id.slice(1), href: `${root}/${id}` })),
        ...['activity', 'tasks', 'files', 'files/reports', 'setup', 'setup/responsibilities', 'setup/harness', 'setup/files', 'setup/history'].map(id => ({ group, label: ({ activity: 'Activity', tasks: 'Task details', files: 'File details', 'files/reports': 'Saved reports', setup: 'Setup', 'setup/responsibilities': 'Responsibilities', 'setup/harness': 'Agent settings', 'setup/files': 'Knowledge', 'setup/history': 'History' } as Record<string, string>)[id], href: `${root}/details/${id}` })),
        ...BOT_TABS.map(id => ({ group, label: id[0].toUpperCase() + id.slice(1), href: `${root}/settings/${id}` })),
      ];
    }),
  ];
}

/** Availability is account-scoped. No profile means the existing shell is unchanged. */
export function useAdaptedNavigation() {
  const account = useStore(s => s.user?.id);
  const { revision } = useUiConfig();
  const previewNavigation = useEffectiveConfig().layout.phoneTabs.includes('more');
  const [active, setActive] = useState(false);
  useEffect(() => {
    let alive = true;
    setActive(false);
    if (account) void fetch('/api/ui/requirements', { credentials: 'include' }).then(async response => {
      const data = response.ok ? await response.json() : null;
      if (alive) setActive(!!data?.adapted);
    }).catch(() => {});
    return () => { alive = false; };
  }, [account, revision]);
  return active || previewNavigation;
}

// These scopes use the existing Paper tokens. Default accounts and shared
// dashboard components keep their existing rendering and behavior.
const adaptiveStyles = `
.all-sections-page p { margin: 0; }
.adaptive-home { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow-y: auto; }
.adaptive-home :is(.btn, .cfg-btn) { gap: 8px; font-size: 14px; line-height: 20px; }
.adaptive-home :is(.dashboard-muted, .dashboard-list-meta, .dashboard-chart-labels, .dashboard-chart-legend, .dashboard-schedule time, .dashboard-schedule li > span, .dashboard-bot-grid small) { font-size: 13px; line-height: 20px; color: var(--color-text-secondary); }
.adaptive-home :is(.dashboard-widget--stat, .dashboard-status, .dashboard-bot-grid li > div, .dashboard-schedule li) { gap: 8px; }
.adaptive-home .dashboard-actions .btn:first-child, .adaptive-home .dashboard-empty-data .btn { background: var(--color-bg-tertiary); color: var(--color-text-primary); box-shadow: inset 0 0 0 1px var(--color-border); }
.adaptive-home .dashboard-actions .btn:last-child { background: var(--color-primary); color: var(--color-on-primary); }
@media (max-width: 760px) {
  .adaptive-home .dashboard-heading > div:first-child { display: none; }
  .adaptive-home .dashboard-actions { max-width: none; flex: 1 1 0; width: 100%; }
}
@media (min-width: 761px) {
  .app:has(.adaptive-home, .all-sections-page) .shell-header > .shell-header__title { display: none; }
}
`;

export function AdaptiveHome({ children }: { children: ReactNode }) {
  const adapted = useAdaptedNavigation();
  return adapted ? <div className="adaptive-home"><style>{adaptiveStyles}</style>{children}</div> : <>{children}</>;
}

export function AllSections({ routines = false }: { routines?: boolean }) {
  const bots = useStore(s => s.bots);
  const phone = useStore(s => s.mobile);
  const { saved } = useUiConfig();
  const links = routines ? bots.filter(bot => bot.kind !== 'room').map(bot => ({ group: 'Bots', label: bot.name, href: `#bot/${botSlug(bot)}/settings/routines` })) : allSectionLinks(bots, saved.dashboards);
  const groups = [...new Set(links.map(link => link.group))];
  return <Page type="list" className="all-sections-page" aria-label={routines ? 'Routines' : 'All sections'} title={phone ? undefined : routines ? 'Routines' : 'All sections'} style={{ overflowY: 'auto', height: '100%' }}>
    <style>{adaptiveStyles}</style>
    <p>{routines ? 'View and manage each Bot\'s routines.' : 'Everything stays available here.'}</p>
    {routines && !links.length && <p>No Bots yet. <a href="#new-bot">Create a Bot</a> to add routines.</p>}
    {groups.map(group => <Section key={group} title={group}><Card variant="list" style={{ paddingBlock: 16 }}>
      {links.filter(link => link.group === group).map(link => <a key={link.href} href={link.href} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}><Row title={link.label} /></a>)}
    </Card></Section>)}
  </Page>;
}
