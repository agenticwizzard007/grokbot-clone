import { useLayoutEffect, useState, type RefObject } from 'react';
import { fittingComposerLabel, type ComposerLabel } from './composerModelLabel';

/** Measure text at its real font size. Typing does not participate in label selection. */
export function useComposerLabel(trigger: RefObject<HTMLButtonElement>, steps: ComposerLabel[]) {
  const [index, setIndex] = useState(0);
  const key = JSON.stringify(steps);
  useLayoutEffect(() => {
    const button = trigger.current;
    const composer = button?.closest('.composer');
    if (!button) return;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    const measure = () => {
      const style = getComputedStyle(button);
      const textWidth = (text: string, selector: string, fallbackWeight: string) => {
        const font = getComputedStyle(button.querySelector(selector) ?? button);
        context.font = `${fallbackWeight} ${font.fontSize} ${font.fontFamily}`;
        return context.measureText(text).width + text.length * (parseFloat(font.letterSpacing) || 0);
      };
      const width = composer?.getBoundingClientRect().width ?? innerWidth;
      // Phones always use the complete short model name. Wider layouts keep
      // one row and reserve enough field space for a readable prompt.
      const phone = matchMedia('(max-width: 480px)').matches;
      const available = Math.max(0, width - 102 - (phone ? 0 : 160));
      const gap = parseFloat(style.columnGap) || 4;
      const chosen = fittingComposerLabel(phone ? steps.slice(1) : steps, available, step => {
        const texts = [step.name, step.billing, step.effort].filter(Boolean);
        return 16 + 20 + gap * texts.length
          + (step.name ? textWidth(step.name, '.model-pill__name', '600') : 0)
          + (step.billing ? textWidth(step.billing, '.model-billing', '500') + 16 : 0)
          + (step.effort ? textWidth(step.effort, '.model-pill__effort', '500') : 0)
          + (step.compact ? 0 : 14 + gap)
          + (button.querySelector('.model-pill__fast') ? 16 : 0) + 2;
      });
      setIndex(steps.indexOf(chosen));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (composer) observer.observe(composer);
    window.addEventListener('resize', measure);
    document.fonts.addEventListener('loadingdone', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); document.fonts.removeEventListener('loadingdone', measure); };
  }, [trigger, key]);
  return steps[Math.min(index, steps.length - 1)];
}
