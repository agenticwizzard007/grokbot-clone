import { useEffect, useState } from 'react';
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
        ...['activity', 'tasks', 'files', 'files/reports', 'setup', 'setup/responsibilities', 'setup/harness', 'setup/files', 'setup/history'].map(id => ({ group, label: `Details: ${id.replaceAll('/', ' ')}`, href: `${root}/details/${id}` })),
        ...BOT_TABS.map(id => ({ group, label: `Bot settings: ${id}`, href: `${root}/settings/${id}` })),
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

export function AllSections({ routines = false }: { routines?: boolean }) {
  const bots = useStore(s => s.bots);
  const { saved } = useUiConfig();
  const links = routines ? bots.filter(bot => bot.kind !== 'room').map(bot => ({ group: 'Bots', label: bot.name, href: `#bot/${botSlug(bot)}/settings/routines` })) : allSectionLinks(bots, saved.dashboards);
  const groups = [...new Set(links.map(link => link.group))];
  return <Page type="list" title={routines ? 'Routines' : 'All sections'} style={{ overflowY: 'auto', height: '100%' }}>
    <p>{routines ? 'View and manage each Bot\'s routines.' : 'Everything stays available here.'}</p>
    {routines && !links.length && <p>No Bots yet. <a href="#new-bot">Create a Bot</a> to add routines.</p>}
    {groups.map(group => <Section key={group} title={group}><Card variant="list">
      {links.filter(link => link.group === group).map(link => <Row key={link.href} title={<a href={link.href} style={{ display: 'flex', alignItems: 'center', minHeight: 44, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{link.label}</a>} />)}
    </Card></Section>)}
  </Page>;
}
