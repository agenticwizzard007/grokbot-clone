import { effectiveConfig, type UiConfig } from '@shared/ui-config/index';
import { DEFAULT_CONFIG } from '@shared/ui-config/schema';
import { useCustomization } from '../../../customization/store';
export { refreshUiConfig as refreshAppearance, loadPreview as showAppearancePreview } from '../../../customization/store';

/** Applied cards compare a captured base without writing the saved config or cache. */
export function compareAppliedAppearance(before: UiConfig | null) {
  const state = useCustomization.getState();
  const doc = state.safe || state.status === 'disabled' ? DEFAULT_CONFIG : before ?? state.preview?.result ?? state.saved;
  useCustomization.setState({ effective: effectiveConfig(doc, state.phone), showBefore: before !== null });
}
