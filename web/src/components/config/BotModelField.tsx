import { useEffect, useState } from 'react';
import { configApi } from '../../lib/configApi';
import { ModelPicker } from './ModelPicker';

/** Per-Bot model: a model id, or null for the server default. */
export function BotModelField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [fallback, setFallback] = useState<string>('');
  useEffect(() => {
    configApi.keys().then((k) => setFallback(k.provider.value === 'openrouter' ? k.openrouterModel.value : k.model.value)).catch(() => {});
  }, []);
  return <ModelPicker label="Bot model" value={value} onChange={onChange} defaultLabel={fallback || 'server default'} />;
}
