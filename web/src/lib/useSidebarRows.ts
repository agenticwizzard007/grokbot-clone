import { useLayoutEffect, useRef } from 'react';

/** Paint complete targets only at either scroll edge. Keep every row in the tab
 * order: focusing an edge row scrolls its whole target into view before paint. */
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
        row.toggleAttribute('data-sidebar-clipped', rect.height > 0 && (rect.top < top - 1 || rect.bottom > bottom + 1));
      }
    };
    const focus = (event: FocusEvent) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('button, a[href], [role="button"]');
      if (row && scroll.contains(row)) { row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); measure(); }
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
