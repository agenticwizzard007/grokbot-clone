import { COMPONENTS, type ComponentId } from '../../../server/src/ui-config/registry-components';
import { useCustomization, patchUiConfig, applyPreview, discardPreview, setShowBefore } from './store';
export function useUiConfig() {
  const saved = useCustomization(s => s.saved), revision = useCustomization(s => s.revision), status = useCustomization(s => s.status);
  return { saved, revision, status };
}
export const useEffectiveConfig = () => useCustomization(s => s.effective);
export function useComponentVisible(id: ComponentId) {
  return useCustomization(s => {
    const entry = COMPONENTS.find(component => component.id === id), value = s.effective.components[id];
    return entry && value && entry.allowed.includes(value) ? value : entry?.default ?? 'show';
  });
}
export const useUiPatch = () => patchUiConfig;
export function usePreview() {
  const preview = useCustomization(s => s.preview), showBefore = useCustomization(s => s.showBefore);
  return { preview, apply: applyPreview, discard: discardPreview, showBefore, setShowBefore };
}
