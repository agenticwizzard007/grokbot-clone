import { ArrowDown, ArrowUp } from 'lucide-react';
import { REGISTRY, type UiConfig, type PatchOp } from '@shared/ui-config/index';
import { ButtonGroup, Row } from '../../layout';
import { Switch } from '../ui';
import { AppearanceSection, Choice, SelectRow } from './Controls';
import { moveSidebar, phoneTabPatch, setValue, sidebarVisibility } from './patches';
export type Patch = (ops: PatchOp[]) => Promise<boolean>;
export function LayoutControls({ doc, patch }: { doc: UiConfig; patch: Patch }) {
  const tabs = doc.layout.phoneTabs;
  const tabOptions = [{ value: '', label: 'None' }, ...['bots', 'tasks', 'search'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })), ...doc.dashboards.map(d => ({ value: `dashboard:${d.id}`, label: d.name }))];
  // Settings keeps its saved position. Empty slots are always at the end.
  const slots = Array.from({ length: 5 }, (_, i) => tabs[i] ?? '');
  return <>
    <AppearanceSection title="Sidebar">
      {doc.layout.sidebar.order.map((id, i) => {
        const nav = REGISTRY.nav.find(item => item.id === id)!;
        return <Row key={id} title={nav.label} trailing={<div className="appearance-row-actions"><Switch label={`Show ${nav.label}`} on={!doc.layout.sidebar.hidden.includes(id)} disabled={!nav.hideable} onChange={show => void patch(sidebarVisibility(doc, id, show))} /><ButtonGroup>
          <button type="button" className="cfg-btn cfg-btn--secondary" aria-label={`Move ${nav.label} up`} disabled={i === 0} onClick={() => void patch(moveSidebar(doc, i, -1))}><ArrowUp size={16} aria-hidden /></button>
          <button type="button" className="cfg-btn cfg-btn--secondary" aria-label={`Move ${nav.label} down`} disabled={i === doc.layout.sidebar.order.length - 1} onClick={() => void patch(moveSidebar(doc, i, 1))}><ArrowDown size={16} aria-hidden /></button>
        </ButtonGroup></div>} />;
      })}
      <Choice label="Width" value={doc.layout.sidebar.width} values={['narrow', 'default', 'wide']} onChange={v => void patch(setValue('/layout/sidebar/width', v))} />
      <Choice label="Collapsed" value={doc.layout.sidebar.collapsed === null ? 'auto' : doc.layout.sidebar.collapsed ? 'always' : 'never'} values={['auto', 'always', 'never']} onChange={v => void patch(setValue('/layout/sidebar/collapsed', v === 'auto' ? null : v === 'always'))} />
    </AppearanceSection>
    <AppearanceSection title="Home">
      <SelectRow label="Start on" value={doc.layout.home.kind === 'dashboard' ? doc.layout.home.dashboardId : doc.layout.home.kind} options={[...['default', 'bots', 'tasks'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })), ...doc.dashboards.map(d => ({ value: d.id, label: d.name }))]} onChange={v => void patch(setValue('/layout/home', v.startsWith('d_') ? { kind: 'dashboard', dashboardId: v } : { kind: v }))} />
      {slots.map((value, index) => <SelectRow key={index} label={`Tab ${index + 1}`} value={value} disabled={value === 'settings'} options={value === 'settings' ? [{ value, label: 'Settings' }] : tabOptions.map(option => ({ ...option, disabled: Boolean(option.value.startsWith('dashboard:') && tabs.some(tab => tab.startsWith('dashboard:') && tab !== value)) || (!option.value && tabs.length <= 3 && !!value) }))} onChange={v => void patch(phoneTabPatch(doc, index, v))} />)}
    </AppearanceSection>
    <AppearanceSection title="Show">
      {REGISTRY.components.map(component => component.allowed.includes('collapsed')
        ? <Choice key={component.id} label={component.label} value={doc.components[component.id] ?? component.default} values={component.allowed} onChange={v => void patch(setValue(`/components/${component.id}`, v))} />
        : <Row key={component.id} title={component.label} trailing={<Switch label={component.label} on={(doc.components[component.id] ?? component.default) === 'show'} onChange={v => void patch(setValue(`/components/${component.id}`, v ? 'show' : 'hide'))} />} />)}
    </AppearanceSection>
  </>;
}
