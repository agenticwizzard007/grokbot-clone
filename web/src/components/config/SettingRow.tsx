import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** One outline style for settings rows, including custom forms and disclosures. */
export function SettingIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="settings-row__icon" size={20} strokeWidth={1.75} aria-hidden />;
}

/** Icon, label, helper text, then the control. Kept independent of the settings shell. */
export function SettingRow({ icon, title, sub, status, children, wrap, className = '' }: {
  icon: LucideIcon;
  title: ReactNode;
  sub?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
  wrap?: boolean;
  className?: string;
}) {
  return <div className={`cfg-row${wrap ? ' settings-row--wrap' : ''}${className ? ` ${className}` : ''}`}>
    <SettingIcon icon={icon} />
    <div className="cfg-row__text">
      <div className="cfg-row__title">{title}</div>
      {sub && <div className="cfg-row__sub">{sub}</div>}
      {status && <div className="cfg-row__sub">{status}</div>}
    </div>
    {children}
  </div>;
}
