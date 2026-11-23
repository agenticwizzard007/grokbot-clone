import { Blocks, ChevronRight, CircleUserRound, Gauge, KeyRound, MessageCircle, Monitor, Server, Settings as SettingsIcon, ShieldCheck, Terminal, type LucideIcon } from 'lucide-react';
import type { AppSection } from '../../configStore';

// Icon map restored from ed1f0ad41e502adceed11c145f8f3afa416cbb66.
// Last map change: 97896599226bc476e950f9b7419389f8bda57a7f (Learning: Blocks).
// Swarms settings design for desktop, phone, Mac, and iPhone.
export type NavItem = { id: AppSection; label: string; icon: LucideIcon; keywords: string };
export const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Workspace', items: [
    { id: 'general', label: 'General', icon: SettingsIcon, keywords: 'theme dark light appearance layout sidebar details panel keyboard shortcuts' },
    { id: 'account', label: 'Account', icon: CircleUserRound, keywords: 'profile name email sign out log out apple delete sessions sign in' },
    { id: 'messaging', label: 'Messaging', icon: MessageCircle, keywords: 'imessage sms text phone number whatsapp voice replies invite friends contact' },
    { id: 'usage', label: 'Usage', icon: Gauge, keywords: 'cost spend money dollars tokens requests billing limits' },
    { id: 'learning', label: 'Learning', icon: Blocks, keywords: 'hermes memory skills review approval refine history maintenance' },
    { id: 'computer', label: 'Computer', icon: Monitor, keywords: 'vm cloud browser screen desktop pc linux macos companion sleep wake reset device access accessibility recording files automation' },
    { id: 'permissions', label: 'Permissions', icon: ShieldCheck, keywords: 'approvals always allow ask again tools' },
  ] },
  { group: 'Connections', items: [
    { id: 'apps', label: 'Connected apps', icon: Blocks, keywords: 'composio gmail google calendar slack notion integrations connect' },
    { id: 'mcp', label: 'MCP servers', icon: Server, keywords: 'mcp custom tools server url command stdio headers token' },
    { id: 'subscriptions', label: 'Models & access', icon: Terminal, keywords: 'chatgpt codex claude code cli bridge connect subscription plan login auth api' },
    { id: 'keys', label: 'API keys', icon: KeyRound, keywords: 'openrouter model provider key composio default model platform voice xai admin' },
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
