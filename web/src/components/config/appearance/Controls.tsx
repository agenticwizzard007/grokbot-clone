import { useId, type ReactNode } from 'react';
import { Row, Section, Card } from '../../layout';
import { Segmented } from '../ui';

export function AppearanceSection({ title, children, helper }: { title: string; children: ReactNode; helper?: string }) {
  return <Section title={title} aria-label={title} className="appearance-section"><Card variant="list">{helper && <p className="appearance-helper">{helper}</p>}{children}</Card></Section>;
}
export function Choice({ label, value, values, onChange }: { label: string; value: string; values: readonly (string | { value: string; label: string })[]; onChange: (value: string) => void }) {
  const options = values.map(value => typeof value === 'string' ? { value, label: value[0].toUpperCase() + value.slice(1) } : value);
  return <Row className="appearance-control" title={label} trailing={<Segmented label={label} value={value} options={options} onChange={onChange} />} />;
}
export function SelectRow({ label, value, options, onChange, disabled }: { label: string; value: string; options: { value: string; label: string; disabled?: boolean }[]; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  return <Row className="appearance-control" title={<label htmlFor={id}>{label}</label>} trailing={<select id={id} className="text-input" value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>{options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}</select>} />;
}
