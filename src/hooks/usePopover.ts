import { useEffect, useRef, useState } from 'react';
import { useLayer } from './useLayer';

/** Open/close state for a menu or popover: outside click and Esc close it. */
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);
  useLayer(
    open,
    () => {
      // Esc from inside: back to the button that opened it (the anchor's first), not the page.
      const inside = Boolean(ref.current?.contains(document.activeElement));
      setOpen(false);
      if (inside) ref.current?.querySelector<HTMLElement>('button')?.focus();
    },
    { blurFirst: false },
  );
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return { open, setOpen, ref };
}
