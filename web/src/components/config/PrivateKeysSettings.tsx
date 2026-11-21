import { useEffect, useRef, useState } from 'react';
import { accessApi, verifyAccessAccount } from '../../lib/accessApi';
import { needsReauth } from '../../lib/api';
import { useStore } from '../../store';
import { AccessRow } from './AccessRow';
import { ConfirmButton } from './ui';
import { refreshModels } from './ModelPicker';
import { useAccessPanel } from './useAccessPanel';

type Keys = Awaited<ReturnType<typeof accessApi.credentials>>['keys'];
export function PrivateKeysSettings({ accountId, onReauth }: { accountId: string; onReauth: (error: Error) => void }) {
  const [keys, setKeys] = useState<Keys | null>(null);
  const [values, setValues] = useState({ direct: '', voice: '' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);
  const current = useAccessPanel(accountId);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void verifyAccessAccount(accountId, controller.signal).then(async () => {
      if (!current() || controller.signal.aborted) return;
      const result = await accessApi.credentials(controller.signal);
      if (current() && !controller.signal.aborted) setKeys(result.keys);
    }).catch(e => { if (current() && !controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [accountId, attempt, current]);

  async function act(action: () => Promise<unknown>, message: string) {
    if (running.current || !current()) return;
    running.current = true; setBusy(true); setError(''); setNote('');
    try {
      await verifyAccessAccount(accountId);
      if (!current()) return;
      await action();
      if (useStore.getState().user?.id === accountId) refreshModels();
      if (!current()) return;
      setNote(message);
      setKeys(null); setAttempt(value => value + 1);
    } catch (e) {
      if (current()) {
        if (needsReauth(e)) onReauth(e);
        else setError((e as Error).message);
      }
    } finally { running.current = false; if (current()) setBusy(false); }
  }

  return <section className="cfg-section private-keys-settings">
    <h2 className="cfg-section__label">Your private API credentials</h2>
    <p className="cfg-field__hint">These credentials belong only to your account. Saving a key doesn’t change model billing.</p>
    {!keys && !error && <p role="status">Checking private credentials…</p>}
    {keys && (['direct', 'voice'] as const).map(provider => {
      const saved = keys.find(item => item.provider === provider);
      const title = provider === 'voice' ? 'xAI voice' : 'Model API';
      return <form className="openrouter-settings__key" key={provider} onSubmit={event => {
        event.preventDefault();
        const key = values[provider].trim();
        if (!key || running.current) return;
        setValues(previous => ({ ...previous, [provider]: '' }));
        void act(() => accessApi.saveCredential(provider, key), `${title} key verified and saved.`);
      }}>
        <label htmlFor={`private-${provider}-key`}>{title}</label>
        <input id={`private-${provider}-key`} className="text-input" type="password" autoComplete="off" spellCheck={false} value={values[provider]} onChange={event => setValues(previous => ({ ...previous, [provider]: event.target.value }))} disabled={busy} />
        <AccessRow title={saved?.connected ? `Connected ${saved.hint ?? ''}` : 'No credential configured'} description={provider === 'voice' ? 'Used for supported voice features.' : 'Verify the key before selecting it for models.'}>
          <button type="submit" className="cfg-btn cfg-btn--secondary" disabled={busy || !values[provider].trim()}>Save &amp; verify key</button>
          {!!saved?.connected && <ConfirmButton className="cfg-btn cfg-btn--secondary" disabled={busy} confirmLabel="Remove key" onConfirm={() => act(() => accessApi.removeCredential(provider), `${title} key removed.`)}>Disconnect</ConfirmButton>}
          {provider === 'direct' && !!saved?.connected && <ConfirmButton className="cfg-btn cfg-btn--secondary" disabled={busy} confirmLabel="Switch to API billing" onConfirm={() => act(accessApi.selectPrivateModels, 'Private model API selected.')}>Use for models</ConfirmButton>}
        </AccessRow>
      </form>;
    })}
    {error && <div className="cfg-error" role="alert">{error} {!keys && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setAttempt(value => value + 1)}>Retry credentials</button>}</div>}
    {note && <p role="status">{note}</p>}
  </section>;
}
