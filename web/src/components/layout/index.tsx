import type { HTMLAttributes, ReactNode } from 'react';
import '../../styles/layout.css';

type Props = HTMLAttributes<HTMLDivElement>;
const classes = (...values: (string | undefined | false)[]) => values.filter(Boolean).join(' ');

/** The width describes the content column, excluding symmetric page gutters. */
export function Page({ type = 'form', title, helper, children, className, ...props }: Omit<Props, 'title'> & {
  type?: 'form' | 'list' | 'chat'; title?: ReactNode; helper?: ReactNode;
}) {
  return <div {...props} data-layout="page" data-page-type={type} className={classes('layout-page', className)}>
    <div className="layout-page__content">
      {(title || helper) && <header className="layout-page__header">{title && <h1>{title}</h1>}{helper && <p>{helper}</p>}</header>}
      {children}
    </div>
  </div>;
}

export function Section({ title, action, children, className, ...props }: Omit<Props, 'title'> & { title?: ReactNode; action?: ReactNode }) {
  return <section {...props} data-layout="section" className={classes('layout-section', className)}>
    {(title || action) && <header className="layout-section__header">{title && <h2>{title}</h2>}{action}</header>}
    <div className="layout-section__content">{children}</div>
  </section>;
}

export function Card({ variant, children, className, ...props }: Props & { variant?: 'list' }) {
  return <div {...props} data-layout="card" className={classes('layout-card', variant === 'list' && 'layout-card--list', className)}>{children}</div>;
}

export function Row({ leading, title, subtitle, trailing, children, className, ...props }: Omit<Props, 'title'> & {
  leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode;
}) {
  return <div {...props} data-layout="row" className={classes('layout-row', className)}>
    {leading && <span className="layout-row__leading">{leading}</span>}
    <div className="layout-row__text"><div className="layout-row__title">{title}</div>{subtitle && <div className="layout-row__subtitle">{subtitle}</div>}{children}</div>
    {trailing && <div className="layout-row__trailing">{trailing}</div>}
  </div>;
}

export function ButtonGroup({ stack = false, children, className, ...props }: Props & { stack?: boolean }) {
  return <div {...props} data-layout="button-group" className={classes('layout-button-group', stack && 'layout-button-group--stack', className)}>{children}</div>;
}
