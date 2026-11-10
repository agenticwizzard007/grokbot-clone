import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import '../styles/auth.css';

type ContentProps = { icon?: ReactNode; children: ReactNode };

function AuthButtonContent({ icon, children }: ContentProps) {
  return (
    <>
      <span className="auth-button__icon" aria-hidden="true">{icon}</span>
      <span className="auth-button__label">{children}</span>
    </>
  );
}

/** One control style for phone, Apple, and Google, including linked accounts. */
export function AuthButton({ icon, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & ContentProps) {
  return <button {...props} className={`auth-button ${className}`}><AuthButtonContent icon={icon}>{children}</AuthButtonContent></button>;
}

export function AuthLink({ icon, children, className = '', ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & ContentProps) {
  return <a {...props} className={`auth-button ${className}`}><AuthButtonContent icon={icon}>{children}</AuthButtonContent></a>;
}
