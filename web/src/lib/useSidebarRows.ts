import { useLayoutEffect, useRef } from 'react';

/** Move boundary-crossing targets outside the scrollport until the whole row
 * fits. Focus restores the natural position and scrolls the complete row in. */
export function useSidebarRows() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroll = ref.current;
    if (!scroll) return;
    const rows = () => [...scroll.querySelectorAll<HTMLElement>('button, a[href], [role="button"]')];
    const measure = () => {
      const box = scroll.getBoundingClientRect(), top = box.top + scroll.clientTop, bottom = top + scroll.clientHeight;
      for (const row of rows()) {
        const rect = row.getBoundingClientRect();
        const shift = row.dataset.sidebarClipped === 'start' ? -rect.height : row.dataset.sidebarClipped === 'end' ? rect.height : 0;
        const start = rect.top - shift, end = rect.bottom - shift;
        if (start < top - 1 && end > top + 1) row.dataset.sidebarClipped = 'start';
        else if (end > bottom + 1 && start < bottom - 1) row.dataset.sidebarClipped = 'end';
        else delete row.dataset.sidebarClipped;
      }
    };
    const focus = (event: FocusEvent) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('button, a[href], [role="button"]');
      if (row && scroll.contains(row)) { delete row.dataset.sidebarClipped; row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); measure(); }
    };
    const observer = new ResizeObserver(measure);
    const observe = () => { observer.disconnect(); observer.observe(scroll); for (const row of rows()) observer.observe(row); measure(); };
    const mutation = new MutationObserver(observe);
    mutation.observe(scroll, { childList: true, subtree: true });
    scroll.addEventListener('scroll', measure, { passive: true });
    scroll.addEventListener('focusin', focus);
    observe();
    return () => { observer.disconnect(); mutation.disconnect(); scroll.removeEventListener('scroll', measure); scroll.removeEventListener('focusin', focus); };
  });
  return ref;
}
