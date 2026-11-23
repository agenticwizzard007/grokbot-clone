/** Show a quiet scrollbar while a scroll surface is moving, including touch scrolling. */
export function installOverlayScrollbars() {
  const timers = new Map<HTMLElement, number>();
  const onScroll = (event: Event) => {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    const previous = timers.get(element);
    if (previous !== undefined) window.clearTimeout(previous);
    element.dataset.scrolling = 'true';
    timers.set(element, window.setTimeout(() => {
      delete element.dataset.scrolling;
      timers.delete(element);
    }, 900));
  };
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    document.removeEventListener('scroll', onScroll, true);
    for (const [element, timer] of timers) { window.clearTimeout(timer); delete element.dataset.scrolling; }
    timers.clear();
  };
}
