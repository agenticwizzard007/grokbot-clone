import { useEffect, useRef, type RefObject } from 'react';
import { useStore } from '../store';

/**
 * R2F-031: after a card in the chat resolves (approval, question, draft), typing goes back to the composer.
 * Only takes focus when it would otherwise be lost (on the page body or inside the card), never on phones.
 */
export function refocusComposer(card?: Element | null) {
  requestAnimationFrame(() => {
    if (useStore.getState().mobile) return;
    const active = document.activeElement;
    const lost = !active || active === document.body || (!!card && card.contains(active)) || !active.isConnected;
    if (!lost) return;
    const composer = document.querySelector<HTMLTextAreaElement>('.chat .composer__input');
    if (composer && composer.getClientRects().length && !composer.closest('[inert]')) composer.focus({ preventScroll: true });
  });
}

/** Refocus the composer when `pending` turns false while the user was acting on this card. */
export function useRefocusOnResolve(pending: boolean, card: RefObject<HTMLElement | null>) {
  const was = useRef(pending);
  const acted = useRef(false);
  useEffect(() => {
    const element = card.current;
    if (!element) return;
    const mark = () => { acted.current = true; };
    element.addEventListener('pointerdown', mark);
    element.addEventListener('keydown', mark);
    return () => { element.removeEventListener('pointerdown', mark); element.removeEventListener('keydown', mark); };
  }, [card]);
  useEffect(() => {
    if (was.current && !pending && acted.current) refocusComposer(card.current);
    was.current = pending;
  }, [pending, card]);
}
