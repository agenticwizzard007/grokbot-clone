import { useConfigUI } from '../../configStore';

export function SetupConnectionHelp({ text }: { text: string }) {
  if (!/needs to be reconnected|could not connect|connection unavailable/i.test(text)) return null;
  return <p>Open Connected apps to check the account and reconnect it.{' '}
    <button type="button" className="link-btn" onClick={() => useConfigUI.getState().openAppSettings('apps')}>Connected apps</button>
  </p>;
}
