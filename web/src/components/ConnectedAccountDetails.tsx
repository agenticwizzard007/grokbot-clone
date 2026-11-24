import { connectedDate, connectionStatus, connectionStatusLabel, visibleConnections, fallbackAccountLabel, type ConnectionDetails } from '@shared/connection-details';
import '../styles/connected-account-details.css';

export type DisplayAccount = { id: string; status: string; isDisabled?: boolean } & Partial<ConnectionDetails>;
export function ConnectedAccountDetails({ account }: { account: DisplayAccount }) {
  const status = connectionStatus(account.status, account.isDisabled);
  if (['pending', 'failed'].includes(connectionStatus(account.status))) return null;
  const label = account.accountLabel || fallbackAccountLabel(account.id);
  return <span className="connected-account-details" data-account-id={account.id}>
    <span className="connected-account-details__label" title={label}>{label}</span>
    <span className="connected-account-details__meta">
      <span>{connectionStatusLabel(status)}</span>
      {status === 'active' && <span>{connectedDate(account.connectedAt)}</span>}
    </span>
  </span>;
}
export function ConnectedAccounts({ accounts }: { accounts: DisplayAccount[] | undefined }) {
  return <>{visibleConnections(accounts ?? []).map(account => <ConnectedAccountDetails key={account.id} account={account} />)}</>;
}
