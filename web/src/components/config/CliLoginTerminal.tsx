import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { X } from 'lucide-react';
import { cliApi, type CliProvider, type LoginSession } from '../../lib/cliApi';
import { ApiError } from '../../lib/api';
import { SwarmMark } from '../SwarmMark';
import '@xterm/xterm/css/xterm.css';

const OFFICIAL_DOMAINS = ['openai.com', 'chatgpt.com', 'claude.ai', 'claude.com', 'anthropic.com'];
const OFFICIAL_URL = /https:\/\/(?:[a-z0-9-]+\.)*(?:openai\.com|chatgpt\.com|claude\.ai|claude\.com|anthropic\.com)(?::443)?(?=$|[\s/?#])(?:[/?#][^\s<>"'`]*)?/i;
const officialUrl = (uri: string) => {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && OFFICIAL_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
};
const active = (state: LoginSession['state']) => state === 'running' || state === 'verifying';
const LABELS: Record<LoginSession['state'], string> = {
  running: 'Running', verifying: 'Verifying', connected: 'Connected', failed: 'Failed', cancelled: 'Cancelled',
};

function terminalTheme(element: HTMLElement) {
  const style = getComputedStyle(element);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: color('--subscription-terminal-bg'), foreground: color('--color-text-primary'),
    cursor: color('--subscription-accent'), cursorAccent: color('--subscription-terminal-bg'),
    selectionBackground: color('--subscription-selection'),
    black: color('--color-text-primary'), brightBlack: color('--color-text-secondary'),
    red: color('--color-danger-text'), brightRed: color('--color-danger-text'),
    green: color('--color-success-text'), brightGreen: color('--color-success-text'),
    yellow: color('--color-warn-text'), brightYellow: color('--color-warn-text'),
    blue: color('--subscription-accent'), brightBlue: color('--subscription-accent'),
    magenta: color('--color-bot-purple'), brightMagenta: color('--color-bot-purple'),
    cyan: color('--color-bot-teal'), brightCyan: color('--color-bot-teal'),
    white: color('--color-text-secondary'), brightWhite: color('--color-text-primary'),
  };
}

export function CliLoginTerminal({ provider, onConnected, onClose, onStateChange }: {
  provider: CliProvider;
  onConnected: () => void;
  onClose: () => void;
  onStateChange: (state: LoginSession['state']) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onConnected, onClose, onStateChange });
  callbacks.current = { onConnected, onClose, onStateChange };
  const [state, setState] = useState<LoginSession['state'] | 'starting'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const name = provider === 'claude' ? 'Claude Code' : 'Codex';

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let session: LoginSession | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let queue: Promise<void> = Promise.resolve();
    let reads: Promise<LoginSession | null> = Promise.resolve(null);
    let failed = false;
    let connectedNotified = false;
    const controller = new AbortController();
    const terminal = new Terminal({
      cursorBlink: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      fontSize: 13, lineHeight: 1.5, fontFamily: getComputedStyle(container.current).getPropertyValue('--font-mono-stack').trim(),
      rows: 20, cols: 80, scrollback: 2000, screenReaderMode: true, disableStdin: true,
      theme: terminalTheme(container.current), minimumContrastRatio: 4.5,
      linkHandler: { activate: (_event, uri) => { if (officialUrl(uri)) window.open(uri, '_blank', 'noopener,noreferrer'); } },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      if (officialUrl(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
    }, { urlRegex: OFFICIAL_URL }));
    // Consume unsafe OSC 8 links as well as restricting plain-text link recognition.
    const links = terminal.parser.registerOscHandler(8, (data) => {
      const uri = data.slice(data.indexOf(';') + 1);
      return !!uri && !officialUrl(uri);
    });
    terminal.open(container.current);
    terminal.textarea?.setAttribute('aria-label', `${name} login terminal input`);
    terminal.textarea?.setAttribute('autocapitalize', 'off');
    terminal.textarea?.setAttribute('autocomplete', 'off');
    const fitTerminal = () => {
      fit.fit();
      const cols = Math.max(20, Math.min(300, terminal.cols));
      const rows = Math.max(5, Math.min(120, terminal.rows));
      if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
    };
    fitTerminal();

    const cancel = (id: string) => { void cliApi.cancelLogin(id).catch(() => {}); };
    const fail = (err: unknown) => {
      if (disposed || failed) return;
      failed = true;
      clearTimeout(timer);
      terminal.options.disableStdin = true;
      setState('failed');
      setError(err instanceof Error ? err.message : 'The login connection failed. Close this terminal and try again.');
      callbacks.current.onStateChange('failed');
      if (session) cancel(session.id);
    };
    const enqueue = (task: (id: string) => Promise<void>) => {
      queue = queue.then(async () => {
        if (!disposed && !failed && session?.state === 'running') await task(session.id);
      }).catch(async (err: unknown) => {
        if (disposed || failed) return;
        if (err instanceof ApiError && err.status === 409 && session) {
          try {
            const latest = await readSession();
            // The PTY stops accepting writes as verification begins. Keep its actual result.
            if (latest && latest.state !== 'running') return;
          } catch (readError) {
            if (!controller.signal.aborted) fail(readError);
            return;
          }
        }
        fail(err);
      });
    };
    const encoder = new TextEncoder();
    const input = terminal.onData((data) => {
      let chunk = '';
      let bytes = 0;
      for (const character of data) {
        const size = encoder.encode(character).length;
        if (bytes + size > 8192) {
          const part = chunk;
          enqueue((id) => cliApi.loginInput(id, part, controller.signal));
          chunk = ''; bytes = 0;
        }
        chunk += character; bytes += size;
      }
      if (chunk) enqueue((id) => cliApi.loginInput(id, chunk, controller.signal));
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => enqueue((id) => cliApi.resizeLogin(id, cols, rows, controller.signal)), 100);
    });
    const observer = new ResizeObserver(() => { if (!disposed && container.current?.clientWidth) fitTerminal(); });
    observer.observe(container.current);
    // Repaint the same terminal when appearance changes; never restart the login.
    const appearance = new MutationObserver(() => {
      if (!disposed && container.current) terminal.options.theme = terminalTheme(container.current);
    });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const apply = async (next: LoginSession) => {
      if (disposed || failed) return;
      session = next;
      if (next.reset) terminal.reset();
      // No local prompts, progress text, or keyboard echo: the PTY owns the terminal screen.
      if (next.output) await new Promise<void>((resolve) => terminal.write(next.output, resolve));
      if (disposed || failed) return;
      terminal.options.disableStdin = next.state !== 'running';
      setState(next.state);
      setError(next.error ?? null);
      setExitCode(next.exitCode ?? null);
      callbacks.current.onStateChange(next.state);
      if (next.state === 'connected' && !connectedNotified) {
        connectedNotified = true;
        callbacks.current.onConnected();
      }
    };
    const readSession = () => {
      // Polling and write-conflict reconciliation share one cursor and output stream.
      reads = reads.catch(() => null).then(async () => {
        if (disposed || failed || !session) return null;
        if (!active(session.state)) return session;
        const next = await cliApi.login(session.id, session.cursor, controller.signal);
        await apply(next);
        return next;
      });
      return reads;
    };
    const poll = async () => {
      if (disposed || failed || !session || !active(session.state)) return;
      try {
        await readSession();
        if (!disposed && !failed && session && active(session.state)) timer = setTimeout(poll, 200);
      } catch (err) { if (!controller.signal.aborted) fail(err); }
    };
    // Deferring creation avoids duplicate sessions during React StrictMode's effect rehearsal.
    const start = setTimeout(async () => {
      try {
        const next = await cliApi.startLogin(provider, terminal.cols, terminal.rows);
        if (disposed) { cancel(next.id); return; }
        await apply(next);
        if (disposed) return;
        enqueue((id) => cliApi.resizeLogin(id, terminal.cols, terminal.rows, controller.signal));
        terminal.focus();
        if (session && active(session.state)) timer = setTimeout(poll, 200);
      } catch (err) { fail(err); }
    }, 0);

    return () => {
      disposed = true;
      clearTimeout(start); clearTimeout(timer); clearTimeout(resizeTimer);
      controller.abort();
      observer.disconnect(); appearance.disconnect(); input.dispose(); resize.dispose(); links.dispose();
      if (session) cancel(session.id);
      terminal.dispose();
    };
  }, [provider]);

  const running = state === 'starting' || active(state);
  return (
    <section className="cli-login-terminal" data-state={state} aria-label={`${name} login terminal`}>
      <div className="cli-login-terminal__header">
        <SwarmMark size={24} />
        <span className="cli-login-terminal__title">{name} login</span>
        <span className="cli-login-terminal__state" role="status">{running && <span className="cfg-spinner" aria-hidden />}{state === 'starting' ? 'Starting' : LABELS[state]}</span>
        <button type="button" className="cfg-icon-btn" aria-label={running ? 'Cancel login and close terminal' : 'Close login terminal'} title={running ? 'Cancel login' : 'Close terminal'} onClick={onClose}><X size={16} aria-hidden /></button>
      </div>
      <div className="cli-login-terminal__screen" ref={container} onKeyDown={(event) => event.stopPropagation()} />
      <div className="cli-login-terminal__footer" role="status">
        {error ? <span className="cli-login-terminal__error">{error}{exitCode !== null ? ` (exit ${exitCode})` : ''} Close this terminal and try Login again.</span>
          : state === 'connected' ? 'Signed in. Your saved subscription login is ready for your Bots.'
            : state === 'cancelled' ? 'Login cancelled.'
              : state === 'failed' ? `Login failed${exitCode !== null ? ` (exit ${exitCode})` : ''}. Close this terminal and try Login again.`
                : state === 'verifying' ? 'Verifying your subscription login. The terminal is now read-only.'
                : 'Type or paste into the terminal. Open the official HTTPS sign-in link shown by the CLI, then return here to finish.'}
      </div>
    </section>
  );
}
