import type { ReactNode } from 'react';

export function AccessRow({ title, description, status, children }: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
}) {
  return <div className="cfg-row access-row">
    <div className="cfg-row__text">
      <div className="cfg-row__title">{title}</div>
      {description && <div className="cfg-row__sub">{description}</div>}
      {status && <div className="cfg-row__sub">{status}</div>}
    </div>
    {children && <div className="access-row__actions">{children}</div>}
  </div>;
}
