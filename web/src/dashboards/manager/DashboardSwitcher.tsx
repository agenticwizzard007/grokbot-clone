import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, LayoutDashboard, Plus } from 'lucide-react';
import { useEffectiveConfig } from '../../customization';
import { useStore } from '../../store';
import { navigation } from '../../configStore';
import { ButtonGroup, Section } from '../../components/layout';
import { DashboardDialog } from '../Dialog';
import { DashboardForm } from './DashboardForm';
import { openDashboard, useDashboardManager } from './useDashboardManager';
import { DASHBOARD_LIMIT } from './model';
import '../dashboard-ui.css';
import '../../styles/dashboards.css';
export function DashboardSwitcher({ dashboardId }: { dashboardId: string }) {
  const manager = useDashboardManager(), dashboards = useEffectiveConfig().dashboards;
  const dashboard = dashboards.find(item => item.id === dashboardId), mobile = useStore(state => state.mobile);
  const [open, setOpen] = useState(false), [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const items: { label: string; checked?: boolean; icon: typeof Check; onSelect(): void }[] = [...dashboards.map(item => ({ label: item.name, checked: item.id === dashboard?.id, icon: item.id === dashboard?.id ? Check : LayoutDashboard, onSelect: () => openDashboard(item) })),
    { label: 'All dashboards', icon: LayoutDashboard, onSelect: () => navigation.navigate({ kind: 'dashboards' }) },
    ...(dashboards.length < DASHBOARD_LIMIT ? [{ label: 'New dashboard', icon: Plus, onSelect: () => setCreating(true) }] : [])];
  return <div className="dashboard-switcher"><h1 aria-label={dashboard?.name ?? 'Dashboard'}><button ref={trigger} type="button" className="dashboard-title-control" aria-label={`Switch dashboard: ${dashboard?.name ?? 'Dashboard'}`} aria-haspopup={mobile ? 'dialog' : 'menu'} aria-expanded={open} onClick={() => setOpen(!open)}>{dashboard?.name ?? 'Dashboard'}<ChevronDown size={20} aria-hidden /></button></h1>
    {open && (mobile ? <DashboardDialog title="Switch dashboard" close={() => setOpen(false)}><Section><div className="dashboard-switcher-list">{items.map((item, index) => <button type="button" className="btn btn--secondary" key={index} aria-current={item.checked ? 'page' : undefined} onClick={() => { setOpen(false); item.onSelect(); }}><item.icon size={20} aria-hidden /><span>{item.label}</span></button>)}</div><ButtonGroup><button className="btn btn--secondary" onClick={() => setOpen(false)}>Cancel</button></ButtonGroup></Section></DashboardDialog> : <SwitcherMenu items={items} close={() => setOpen(false)} trigger={trigger} />)}
    {creating && <DashboardForm state={{ kind: 'create' }} {...manager} close={() => setCreating(false)} />}
  </div>;
}

function SwitcherMenu({ items, close, trigger }: { items: { label: string; checked?: boolean; icon: typeof Check; onSelect(): void }[]; close(): void; trigger: React.RefObject<HTMLButtonElement> }) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus();
    const outside = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    document.addEventListener('mousedown', outside); return () => document.removeEventListener('mousedown', outside);
  }, [close, trigger]);
  return <div ref={menu} className="menu is-left is-below has-icons" role="menu" aria-label="Dashboards" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); trigger.current?.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  }}>{items.map((item, index) => <button type="button" className="menu__item" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked} key={index} onClick={() => { close(); item.onSelect(); }}><span className="menu__main"><item.icon size={18} className="menu__icon" aria-hidden /><span className="menu__label">{item.label}</span></span></button>)}</div>;
}
