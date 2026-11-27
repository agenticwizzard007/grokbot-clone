import { ButtonGroup } from '../layout';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SettingRow } from './SettingRow';

export function AccessRow({ icon, title, description, status, children }: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
}) {
  return <SettingRow icon={icon} title={title} sub={description} status={status} className="access-row">
    {children && <ButtonGroup stack>{children}</ButtonGroup>}
  </SettingRow>;
}
