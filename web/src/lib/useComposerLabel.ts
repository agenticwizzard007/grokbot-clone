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
      // Keep a useful input and both 44px action targets. This budget selects a
      // complete label; it never constrains or clips the resulting chip.
      // 210px = 88px actions + 24px gaps + 18px padding/border + 80px input.
      const available = Math.max(48, Math.min(width * 0.44, width - 210));
      const gap = parseFloat(style.columnGap) || 4;
      const chosen = fittingComposerLabel(steps, available, step => {
        const texts = [step.name, step.billing, step.effort].filter(Boolean);
        return 16 + 8 + gap * texts.length
          + (step.name ? textWidth(step.name, '.model-pill__name', '500') : 0)
          + (step.billing ? textWidth(step.billing, '.model-billing', '400') + 10 : 0)
          + (step.effort ? textWidth(step.effort, '.model-pill__effort', '400') : 0)
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
