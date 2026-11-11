import { useEffect, useState } from 'react';
import { isNativeApp } from '../../lib/native';
import '@fontsource-variable/instrument-sans/wght.css';
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

  return (
    <section className="cfg-section device-access" aria-labelledby="device-access-title">
      <h2 id="device-access-title" className="cfg-section__label">Device access</h2>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Use your Mac</div>
            <div className="cfg-row__sub">Open Swarm on your Mac and go to Settings → Computer to approve access and connect.</div>
          </div>
          <span className="device-access__availability">Mac app required</span>
        </div>
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Agent access</div>
            <div className="cfg-row__sub">Agents act as your Mac user. Review and approve all four capabilities before connecting.</div>
            <ul className="device-access__capabilities">
              <li><b>Terminal</b><span>Run commands and use installed tools.</span></li>
              <li><b>Files</b><span>Read, create, change and delete files you can access.</span></li>
              <li><b>Browsers</b><span>Browse websites and interact with signed-in pages.</span></li>
              <li><b>Desktop & apps</b><span>See the screen, click, type and use open apps.</span></li>
            </ul>
          </div>
        </div>
      </div>
      <h3 className="device-access__label">macOS permissions</h3>
      <p>Enable Swarm in System Settings from the Mac app’s device access controls.</p>
      <div className="cfg-card device-access__permissions">
        <Permission title="Accessibility" detail="Click, type and control apps." requirement="Required for input" />
        <Permission title="Screen Recording" detail="See your screen to understand and perform tasks." requirement="Required for screen access" />
        <Permission title="Full Disk Access" detail="Read protected folders and data. Add Swarm in Settings if a task needs this." requirement="Optional" />
        <Permission title="Automation" detail="Control other apps. macOS asks for each app an agent uses." requirement="Approved per app" />
      </div>
      <p>Choose <b>Connect this Mac</b> in Swarm and keep the app open while agents work. Stop or disconnect from the same controls at any time.</p>
    </section>
  );
}

function Permission({ title, detail, requirement }: { title: string; detail: string; requirement: string }) {
  return <div className="cfg-row">
    <div className="cfg-row__text"><div className="cfg-row__title">{title}</div><div className="cfg-row__sub">{detail}</div></div>
    <span className="device-access__requirement">{requirement}</span>
  </div>;
}
