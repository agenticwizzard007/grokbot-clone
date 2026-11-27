import { Brain, Blocks, ChevronRight, CircleUserRound, Gauge, KeyRound, MessageCircle, Monitor, LayoutDashboard, Server, Settings as SettingsIcon, ShieldCheck, Terminal, Users, type LucideIcon } from 'lucide-react';
import { SETTINGS_LABELS } from '../../lib/navigation';
import type { AppSection } from '../../configStore';

// Learning and connected apps keep distinct icons.
export type NavItem = { id: AppSection; label: string; icon: LucideIcon; keywords: string };
export const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Workspace', items: [
    { id: 'general', label: SETTINGS_LABELS.general, icon: SettingsIcon, keywords: 'details panel time zone keyboard diagnostics' },
    { id: 'appearance', label: 'Layout', icon: LayoutDashboard, keywords: 'layout sidebar navigation home dashboard shortcuts export import history reset' },
    { id: 'agents', label: SETTINGS_LABELS.agents, icon: Users, keywords: 'handoffs send team standing links automatic loops defaults limits approval' },
    { id: 'account', label: SETTINGS_LABELS.account, icon: CircleUserRound, keywords: 'profile name email sign out log out apple delete sessions sign in' },
    { id: 'messaging', label: SETTINGS_LABELS.messaging, icon: MessageCircle, keywords: 'imessage sms text phone number whatsapp voice replies invite friends contact' },
    { id: 'usage', label: SETTINGS_LABELS.usage, icon: Gauge, keywords: 'cost spend money dollars tokens requests billing limits' },
    { id: 'learning', label: SETTINGS_LABELS.learning, icon: Brain, keywords: 'hermes memory skills review approval refine history maintenance' },
    { id: 'computer', label: SETTINGS_LABELS.computer, icon: Monitor, keywords: 'vm cloud browser screen desktop pc linux macos companion sleep wake reset device access accessibility recording files automation' },
    { id: 'permissions', label: SETTINGS_LABELS.permissions, icon: ShieldCheck, keywords: 'approvals always allow ask again tools' },
  ] },
  { group: 'Connections', items: [
    { id: 'subscriptions', label: 'Models and access', icon: Terminal, keywords: 'chatgpt codex claude code cli bridge connect subscription plan login auth api' },
    { id: 'keys', label: SETTINGS_LABELS.keys, icon: KeyRound, keywords: 'openrouter model provider key composio default model platform voice xai admin' },
    { id: 'apps', label: SETTINGS_LABELS.apps, icon: Blocks, keywords: 'composio gmail google calendar slack notion integrations connect' },
    { id: 'mcp', label: SETTINGS_LABELS.mcp, icon: Server, keywords: 'mcp custom tools server url command stdio headers token' },
  ] },
];
export const matches = (it: NavItem, q: string) => {
  const hay = `${it.label} ${it.keywords}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

export function SettingsNavButton({ item, compact = false, strip = false, active, onSelect }: {
  item: NavItem; compact?: boolean; strip?: boolean; active: boolean; onSelect: (id: AppSection) => void;
}) {
  return <button type="button" className={`${strip ? 'settings-strip__item' : 'cfg-nav__item settings-nav__item'}${active ? ' is-active' : ''}`} onClick={() => onSelect(item.id)} aria-current={active ? 'page' : undefined}>
    <item.icon className="settings-nav__icon" size={compact ? 20 : 18} strokeWidth={1.75} aria-hidden />
    <span className="settings-nav__text">{item.label}</span>
    {compact && <ChevronRight className="settings-nav__chev" size={16} strokeWidth={1.75} aria-hidden />}
  </button>;
}
