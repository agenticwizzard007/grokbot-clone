import { useEffect, useState } from 'react';
import { cliApi, type CliStatus } from '../../lib/cliApi';
import { openrouterApi } from '../../lib/openrouterApi';
import { ModelPicker, refreshModels } from './ModelPicker';
import { useStore } from '../../store';
import { useModels } from '../../lib/models';
import { modelDisplayName } from '../../lib/modelDisplay';

/** Per-Bot model: a model id, or null for the server default. */
export function BotModelField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const accountId = useStore(s => s.user?.id);
  return <AccountBotModelField key={accountId} value={value} onChange={onChange} />;
}

function AccountBotModelField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const catalog = useModels();
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
          if (!controller.signal.aborted) setFallback(connection.active ? connection.model : connection.defaultModel);
        }).catch(() => {});
      }
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not check the selected provider.');
    });
    return () => controller.abort();
  }, [attempt]);

  const selected = cli?.selected;
  const defaultModel = catalog.byId.get(catalog.defaultModel ?? '');
  const defaultLabel = selected ? defaultModel ? modelDisplayName(defaultModel.id, defaultModel.name) : selected === 'codex' ? 'ChatGPT' : 'Claude' : fallback ? modelDisplayName(fallback) : 'Account model';
  return (
    <>
      {cli ? <ModelPicker key={selected ?? 'api'} label="Bot model" value={selected && !value?.startsWith(`${selected}/`) ? null : value} onChange={onChange} defaultLabel={defaultLabel} />
        : <button type="button" className="model-picker__button text-input" aria-label="Bot model" disabled>{error ? 'Provider status unavailable' : 'Checking provider...'}</button>}
      {error && <div className="cfg-error" role="alert">{error} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setAttempt((current) => current + 1)}>Retry provider status</button></div>}
    </>
  );
}
