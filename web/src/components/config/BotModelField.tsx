import { useEffect, useState } from 'react';
import { cliApi, type CliStatus } from '../../lib/cliApi';
import { openrouterApi } from '../../lib/openrouterApi';
import { ModelPicker, refreshModels } from './ModelPicker';

/** Per-Bot model: a model id, or null for the server default. */
export function BotModelField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [fallback, setFallback] = useState<string>('');
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    cliApi.status(controller.signal).then((status) => {
      if (controller.signal.aborted) return;
      refreshModels();
      setCli(status);
      if (!status.selected) {
        openrouterApi.status(controller.signal).then((connection) => {
          if (!controller.signal.aborted) setFallback(connection.defaultModel);
        }).catch(() => {});
      }
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not check the selected provider.');
    });
    return () => controller.abort();
  }, [attempt]);

  const selected = cli?.selected;
  const defaultLabel = selected === 'codex' ? 'ChatGPT · Codex default' : selected === 'claude' ? 'Claude · CLI default' : fallback || 'server default';
  return (
    <>
      {cli ? <ModelPicker key={selected ?? 'api'} label="Bot model" value={selected && !value?.startsWith(`${selected}/`) ? null : value} onChange={onChange} defaultLabel={defaultLabel} />
        : <button type="button" className="model-picker__button text-input" aria-label="Bot model" disabled>{error ? 'Provider status unavailable' : 'Checking provider…'}</button>}
      {selected && <div className="cfg-field__hint">Models come from your connected CLI account. Model and supported effort selections use your plan; API fallback is disabled. {cli && (!cli.connected || !cli.providers[selected].installed || !cli.providers[selected].authenticated || !cli.providers[selected].subscription || cli.providers[selected].error) && 'The selected subscription is blocked until its bridge and CLI authentication are ready. No API fallback is used.'}</div>}
      {error && <div className="cfg-error" role="alert">{error} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setAttempt((current) => current + 1)}>Retry provider status</button></div>}
    </>
  );
}
