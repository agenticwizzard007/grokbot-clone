import { tsImport } from 'tsx/esm/api';
import { requireModules } from './harness.mjs';

export async function contracts() {
  requireModules('server/src/ui-config/index.ts');
  return tsImport('../../../server/src/ui-config/index.ts', import.meta.url);
}
export async function presetDocument(id) {
  const { REGISTRY } = await contracts();
  const presets = Array.isArray(REGISTRY.presets) ? REGISTRY.presets : Object.values(REGISTRY.presets);
  const preset = presets.find(item => item.id === id);
  if (!preset) throw new Error(`Contract registry is missing preset ${id}`);
  // UC-A owns the preset representation; support its metadata envelope or a partial document.
  const doc = preset.doc ?? preset.config ?? preset.value ?? preset;
  return Object.fromEntries(['theme', 'layout', 'components', 'keybindings'].filter(key => key in doc).map(key => [key, doc[key]]));
}
