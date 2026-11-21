import { useConfigUI } from '../../configStore';
import { AppSettings } from './AppSettings';

/** Overlays owned by the settings feature: the app settings page; bot configuration is mounted in the main pane. */
export function ConfigLayer() {
  const appSettings = useConfigUI((s) => !!s.appSettings);
  return (
    <>
      {appSettings && <AppSettings />}
    </>
  );
}
