import type { UiConfig } from '../../../server/src/ui-config/schema';
/** CSS declares local faces; the browser only fetches a face when it is selected. */
export function ensureFonts(font: UiConfig['theme']['font']) {
  if (font.ui === 'atkinson' || font.heading === 'atkinson') {
    void document.fonts?.load('14px "Atkinson Hyperlegible"').catch(() => {});
  }
}
