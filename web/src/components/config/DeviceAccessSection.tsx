import { ShieldCheck } from 'lucide-react';
import { SettingIcon } from './SettingRow';
import { useEffect, useState } from 'react';
import { isNativeApp } from '../../lib/native';
import { isMacPlatform } from './settingsLogic';
import '../../styles/device-access.css';

/** Computer is the only device-permissions surface. Native consent stays in the shell. */
export function DeviceAccessSection() {
  const available = () => isNativeApp && document.documentElement.dataset.swarmMacControl === 'available';
  const [nativeControls, setNativeControls] = useState(available);
  useEffect(() => {
    const observer = new MutationObserver(() => setNativeControls(available()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-swarm-mac-control'] });
    setNativeControls(available());
    return () => observer.disconnect();
  }, []);

  if (nativeControls) return <section className="device-access-native" data-swarm-mac-control-slot="" aria-label="Device access approvals and macOS permissions" />;
  // The native permission controls apply only on macOS; PC pairing also supports Linux.
  if (!isNativeApp && !isMacPlatform()) return (
    <section className="cfg-section device-access-note" aria-label="Linux and Mac computers">
      <h2 className="cfg-section__label">Linux and Mac computers</h2>
      <p className="cfg-field__hint">On Linux, use Connect your PC when PC pairing is available. Run the connect command in a terminal on that PC with Node.js 22+ and keep it running. Browser access also needs Google Chrome.</p>
      <p className="cfg-field__hint">Accessibility, Screen Recording, Full Disk Access and Automation permissions apply only on macOS. The Mac app is optional and requires macOS.</p>
    </section>
  );

  return (
    <section className="cfg-section device-access" aria-label="Device access">
      <h2 className="cfg-section__label">Use your Mac (optional)</h2>
      <div className="cfg-card">
        <div className="cfg-row"><SettingIcon icon={ShieldCheck} />
          <div className="cfg-row__text">
            <div className="cfg-row__title">Use your Mac</div>
            <div className="cfg-row__sub">Open Swarm on your Mac and go to Settings → Computer to approve and connect.</div>
            <div className="cfg-row__sub">Mac app required</div>
          </div>
        </div>
        <div className="cfg-row"><SettingIcon icon={ShieldCheck} />
          <div className="cfg-row__text">
            <div className="cfg-row__title">Agent access</div>
            <div className="cfg-row__sub">Terminal, Files, Browsers, and Desktop &amp; apps require review in the Mac app.</div>
          </div>
        </div>
        <Permission title="Accessibility" detail="Required for mouse and keyboard control." />
        <Permission title="Screen Recording" detail="Required for screen access." />
        <Permission title="Full Disk Access" detail="Optional, when a task needs protected folders." />
        <Permission title="Automation" detail="macOS asks for access per app." />
      </div>
      <div className="access-callout"><strong>Connect in the Mac app</strong><p>Keep Swarm open while it’s connected. Stop keeps this Mac selected but offline. Disconnect revokes access and returns Bots to the server’s default computer.</p></div>
    </section>
  );
}

function Permission({ title, detail }: { title: string; detail: string }) {
  return <div className="cfg-row"><SettingIcon icon={ShieldCheck} />
    <div className="cfg-row__text"><div className="cfg-row__title">{title}</div><div className="cfg-row__sub">{detail}</div></div>
  </div>;
}
