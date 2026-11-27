import { Row, ButtonGroup } from '../layout';
import { SettingsMenu } from './SettingsControls';
import { ProviderMark } from '../ProviderMark';
import { useEffect, useRef, useState } from 'react';
import { accessApi, verifyAccessAccount } from '../../lib/accessApi';
import { needsReauth } from '../../lib/api';
import { useStore } from '../../store';
import { refreshModels } from './ModelPicker';
import { useAccessPanel } from './useAccessPanel';

type Keys = Awaited<ReturnType<typeof accessApi.credentials>>['keys'];
export function PrivateKeysSettings({ accountId, onReauth }: { accountId: string; onReauth: (error: Error) => void }) {
  const [editing, setEditing] = useState<'direct' | 'voice' | null>(null);
  const [removing, setRemoving] = useState<'direct' | 'voice' | null>(null);
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
      setNote(message); setEditing(null); setRemoving(null);
      setKeys(null); setAttempt(value => value + 1);
    } catch (e) {
      if (current()) {
        if (needsReauth(e)) onReauth(e);
        else setError((e as Error).message);
      }
    } finally { running.current = false; if (current()) setBusy(false); }
  }

  return <div className="private-keys-settings">
    {keys && (['direct', 'voice'] as const).map(provider => {
      const saved = keys.find(item => item.provider === provider);
      const title = provider === 'voice' ? 'xAI voice' : 'Model API';
      return <div key={provider} className="settings-key-row">
        <Row leading={<ProviderMark provider={provider === 'voice' ? 'xai' : 'direct'} />} title={<span className="settings-provider">{title}<span className="cfg-chip">{saved?.connected ? 'Key saved' : 'Not connected'}</span></span>} trailing={<button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} aria-expanded={editing === provider} onClick={() => setEditing(editing === provider ? null : provider)}>{saved?.connected ? 'Replace' : 'Add key'}</button>} />
        {editing === provider && <form className="settings-inline-form" onSubmit={event => {
          event.preventDefault(); const key = values[provider].trim(); if (!key || running.current) return;
          setValues(previous => ({ ...previous, [provider]: '' }));
          void act(() => accessApi.saveCredential(provider, key), 'Key saved.');
        }}>
          <label htmlFor={`private-${provider}-key`}>{title} API key</label>
          <input id={`private-${provider}-key`} className="text-input" type="password" autoComplete="off" spellCheck={false} value={values[provider]} onChange={event => setValues(previous => ({ ...previous, [provider]: event.target.value }))} disabled={busy} autoFocus />
          <ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || !values[provider].trim()}>Save</button></ButtonGroup>
          {!!saved?.connected && <SettingsMenu label="Manage" ariaLabel={`Manage ${title}`} disabled={busy} items={[
            { label: 'Remove key', onSelect: () => setRemoving(provider), danger: true },
            ...(provider === 'direct' ? [{ label: 'Use for models', onSelect: () => void act(accessApi.selectPrivateModels, 'Model API selected.') }] : []),
          ]} />}
          {removing === provider && <ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setRemoving(null)}>Cancel</button><button type="button" className="cfg-btn cfg-btn--danger" disabled={busy} onClick={() => void act(() => accessApi.removeCredential(provider), 'Key removed.')}>Remove key</button></ButtonGroup>}
        </form>}
      </div>;
    })}
    {error && <div className="cfg-error" role="alert">{error} {!keys && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setAttempt(value => value + 1)}>Retry</button>}</div>}
    {note && <p role="status">{note}</p>}
  </div>;
}
