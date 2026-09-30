import { useEffect, useRef, type ReactNode } from 'react';
import { useLayer } from '../hooks/useLayer';

interface Props {
  open: boolean;
  /** Changes when the panel shows something else; focus moves to the new title. */
  subjectKey: string;
  label: string;
  onClose: () => void;
  /** Under 720px the panel covers the page and behaves as a dialog. */
  modal: boolean;
  /** Where to put focus back if the element that opened the panel is gone. */
  returnFocus?: string;
  children: ReactNode;
}

/**
 * The right-side panel for tickets and people. It always renders in the same place in
 * the tree, so the 3-second poll updates it in place instead of remounting it.
 */
export function Drawer({ open, subjectKey, label, onClose, modal, returnFocus, children }: Props) {
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useLayer(open, onClose);

  useEffect(() => {
    if (!open) return;
    if (!opener.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const t = window.setTimeout(() => ref.current?.querySelector<HTMLElement>('[data-drawer-title]')?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, subjectKey]);

  useEffect(() => {
    if (open) return;
    const back = opener.current;
    opener.current = null;
    if (back && document.contains(back)) back.focus();
    else if (returnFocus) document.querySelector<HTMLElement>(returnFocus)?.focus();
  }, [open, returnFocus]);

  return (
    <aside
      ref={ref}
      className={`drawer${open ? ' open' : ''}`}
      role={modal ? 'dialog' : 'complementary'}
      aria-modal={modal && open ? true : undefined}
      aria-label={label}
      hidden={!open}
    >
      {open && children}
    </aside>
  );
}
