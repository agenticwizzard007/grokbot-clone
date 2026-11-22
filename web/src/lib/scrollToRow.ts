/**
 * Bring a transcript row into view once the chat has rendered it (search results, Tasks deep links).
 * Rows carry `data-row-seq`; card rows use a `display: contents` wrapper, so scroll its first child.
 */
export function scrollToRow(seq: number, opts: { tries?: number; delayMs?: number } = {}) {
  let tries = 0;
  const max = opts.tries ?? 30;
  const find = () => {
    const anchor = document.querySelector<HTMLElement>(`.transcript [data-row-seq="${seq}"]`);
    const target = anchor && getComputedStyle(anchor).display === 'contents' ? anchor.firstElementChild as HTMLElement | null : anchor;
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('is-search-hit');
      setTimeout(() => target.classList.remove('is-search-hit'), 1600);
    } else if (++tries < max) setTimeout(find, opts.delayMs ?? 100);
  };
  setTimeout(find, 50);
}
