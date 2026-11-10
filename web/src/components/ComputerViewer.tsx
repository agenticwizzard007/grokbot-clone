import { useCallback, useEffect, useRef, useState } from 'react';
import type RFBType from '@novnc/novnc';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { usePageVisible } from '../lib/usePageVisible';
import { botVars } from '../lib/colors';
import { useSelectedBot, useStore } from '../store';
import { computerStatusText } from './DetailsPanel';
import { useConfigUI } from '../configStore';
import { Icon } from './Icon';

type Mode = 'watch' | 'control';
type Conn = 'connecting' | 'connected' | 'disconnected' | 'error';

function WakeProgress({ detail, local = false }: { detail: string; local?: boolean }) {
  return (
    <div className="viewer__wake" role="status" aria-live="polite">
      <span className="viewer__wake-orbit" aria-hidden="true"><span className="viewer__wake-face"><i /><i /></span></span>
      <span className="viewer__wake-title">{local ? 'Connecting to your computer' : 'Agent waking up'}</span>
      <span className="viewer__wake-detail">{detail}</span>
    </div>
  );
}

/** Fullscreen computer stage: noVNC over our relay. Watch mode is view-only; Take control reconnects with mode=control. */
export function ComputerViewer() {
  const bot = useSelectedBot();
  const computer = useStore((s) => s.computer);
  const set = useStore((s) => s.set);
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFBType | null>(null);
  const [mode, setMode] = useState<Mode>(() => (useStore.getState().viewerControl ? 'control' : 'watch'));
  useEffect(() => { if (useStore.getState().viewerControl) useStore.setState({ viewerControl: false }); }, []);
  const [conn, setConn] = useState<Conn>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const wakeRequested = useRef<string | null>(null);
  const wakeInFlight = useRef(false);
  const mounted = useRef(false);
  const visible = usePageVisible();
  const running = computer?.status === 'running';
  const close = () => set({ viewerOpen: false });

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const wake = useCallback(() => {
    if (!bot || wakeInFlight.current) return;
    wakeRequested.current = bot.id;
    wakeInFlight.current = true;
    setWaking(true);
    setWakeError(null);
    api.ensureComputer().then(({ computer }) => { if (mounted.current) set({ computer }); })
      .catch(e => { if (mounted.current) setWakeError(e.message); })
      .finally(() => { wakeInFlight.current = false; if (mounted.current) setWaking(false); });
  }, [bot?.id, set]);

  useEffect(() => {
    if (!visible) { wakeRequested.current = null; return; }
    if (!bot || computer?.provider === 'local' || !computer || !['suspended', 'stopped', 'absent'].includes(computer.status) || wakeRequested.current === bot.id) return;
    // Opening the computer is an explicit request to use it; overlap wake-up with viewer loading.
    wake();
  }, [visible, bot?.id, computer?.provider, computer?.status, wake]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // In control mode Escape belongs to the remote desktop.
      if (e.key === 'Escape' && mode === 'watch') { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (!visible || !bot || !running || !screenRef.current) return;
    let disposed = false;
    let rfb: RFBType | null = null;
    setConn('connecting');
    (async () => {
      const { default: RFB } = await import('@novnc/novnc');
      if (disposed || !screenRef.current) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/api/bots/${bot.id}/screen?mode=${mode}`;
      rfb = new RFB(screenRef.current, url, { shared: true });
      rfb.viewOnly = mode === 'watch';
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.focusOnClick = mode === 'control';
      rfb.addEventListener('connect', () => { if (!disposed) { setConn('connected'); if (mode === 'control') rfb?.focus(); } });
      rfb.addEventListener('disconnect', (e) => { if (!disposed) setConn((e as CustomEvent<{ clean: boolean }>).detail?.clean ? 'disconnected' : 'error'); });
      rfb.addEventListener('securityfailure', () => { if (!disposed) setConn('error'); });
      rfbRef.current = rfb;
    })().catch(() => { if (!disposed) setConn('error'); });
    return () => {
      disposed = true;
      try { rfb?.disconnect(); } catch { /* already closed */ }
      rfbRef.current = null;
      if (screenRef.current) screenRef.current.innerHTML = '';
    };
  }, [visible, bot?.id, running, mode, attempt]);

  if (!bot) return null;
  const busy = waking || computer?.status === 'starting' || computer?.status === 'resuming' || computer?.status === 'creating';
  const preparing = busy || (running && conn === 'connecting');

  return (
    <div className={`viewer${preparing ? ' is-loading' : ''}`} role="dialog" aria-modal="true" aria-label={`${bot.name}'s computer`} style={botVars(bot.avatarColor)}>
      <div className="viewer__scrim" onClick={mode === 'watch' ? close : undefined} />
      <div className="viewer__top">
        <div className="viewer__title">
          <BotAvatarFor bot={bot} size={24} />
          <span>{bot.name}'s computer</span>
          <span className="viewer__status">{preparing && computer?.provider !== 'local' ? 'Agent waking up' : computerStatusText(computer)}</span>
        </div>
        <button type="button" className="viewer__close" onClick={close} aria-label="Close computer"><Icon name="close" color="#FFFFFF" /></button>
      </div>

      <div className="viewer__stage">
        {running ? (
          <>
            <div ref={screenRef} className={`viewer__screen${mode === 'control' ? ' is-control' : ''}`} />
            {conn !== 'connected' && (
              <div className="viewer__overlay">
                {conn === 'connecting' ? <WakeProgress local={computer?.provider === 'local'} detail={computer?.provider === 'cloudvm' ? 'Getting Chrome ready…' : 'Connecting to the screen…'} /> : (
                  <>
                    <span>{conn === 'error' ? 'Couldn’t reach the screen.' : 'Disconnected.'}</span>
                    <button type="button" className="btn btn--light" onClick={() => setAttempt((n) => n + 1)}>Reconnect</button>
                  </>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="viewer__overlay viewer__overlay--asleep">
            {!busy && <span className="viewer__sleep-face" aria-hidden="true"><i /><i /></span>}
            {computer?.provider === 'local' ? (
              <>
                <span>Your PC isn’t connected.</span>
                <button type="button" className="btn btn--light" onClick={() => { close(); useConfigUI.getState().openAppSettings('computer'); }}>Connect your PC</button>
              </>
            ) : (
              <>
                {busy ? <WakeProgress detail={computer?.status === 'creating' ? 'Setting up your computer…' : 'Starting your computer…'} /> : <span>The computer is asleep.</span>}
                {!busy && <button type="button" className="btn btn--light" onClick={wake}>Wake computer</button>}
              </>
            )}
            {(wakeError || computer?.error) && <span className="viewer__err">{wakeError || computer?.error}</span>}
          </div>
        )}
      </div>

      {running && conn === 'connected' && (
        <div className={`viewer__bar${mode === 'control' ? ' is-control' : ''}`}>
          {mode === 'watch' ? (
            <>
              <span className="viewer__bar-text"><b>Watching</b> · Take control to use the mouse and keyboard</span>
              <button type="button" className="btn btn--light" onClick={() => setMode('control')}>Take control</button>
            </>
          ) : (
            <>
              <span className="viewer__bar-text"><span className="viewer__live-dot" /> <b>You're in control</b></span>
              <button type="button" className="btn btn--light" onClick={() => setMode('watch')}>I'm done</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
