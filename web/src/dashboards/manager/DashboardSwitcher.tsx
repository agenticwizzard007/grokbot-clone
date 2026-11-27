import { useRef, useState } from 'react';
import { Check, ChevronDown, LayoutDashboard, Plus } from 'lucide-react';
import { useEffectiveConfig } from '../../customization';
import { useStore } from '../../store';
import { navigation } from '../../configStore';
import { Menu } from '../../components/Menu';
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
  const items = [...dashboards.map(item => ({ label: item.name, icon: item.id === dashboard?.id ? Check : LayoutDashboard, onSelect: () => openDashboard(item) })),
    { label: 'All dashboards', icon: LayoutDashboard, separatorBefore: true, onSelect: () => navigation.navigate({ kind: 'dashboards' }) },
    ...(dashboards.length < DASHBOARD_LIMIT ? [{ label: 'New dashboard', icon: Plus, onSelect: () => setCreating(true) }] : [])];
  return <div className="dashboard-switcher"><h1><button ref={trigger} type="button" className="dashboard-title-control" aria-label={`Switch dashboard: ${dashboard?.name ?? 'Dashboard'}`} aria-haspopup={mobile ? 'dialog' : 'menu'} aria-expanded={open} onClick={() => setOpen(!open)}>{dashboard?.name ?? 'Dashboard'}<ChevronDown size={20} aria-hidden /></button></h1>
    {open && (mobile ? <DashboardDialog title="Switch dashboard" close={() => setOpen(false)}><Section><div className="dashboard-switcher-list">{items.map(item => <button type="button" className="btn btn--secondary" key={item.label} aria-current={dashboard?.name === item.label ? 'page' : undefined} onClick={() => { setOpen(false); item.onSelect(); }}><item.icon size={20} aria-hidden /><span>{item.label}</span></button>)}</div><ButtonGroup><button className="btn btn--secondary" onClick={() => setOpen(false)}>Cancel</button></ButtonGroup></Section></DashboardDialog> : <Menu items={items} triggerRef={trigger} onClose={() => setOpen(false)} />)}
    {creating && <DashboardForm state={{ kind: 'create' }} {...manager} close={() => setCreating(false)} />}
  </div>;
}
