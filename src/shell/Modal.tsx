import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, type ReactNode, type SyntheticEvent } from 'react';
import { useLayer } from '../hooks/useLayer';
import { addDialog, removeDialog } from './topLayer';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** md: forms; wide: one wide document; xl: a full-size reader with its own layout. */
  size?: 'md' | 'wide' | 'xl';
  children: ReactNode;
  footer?: ReactNode;
}

/** Native <dialog>: focus trap, backdrop and top layer for free. Esc goes through the layer stack. */
export function Modal({ open, onClose, title, size = 'md', children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const shown = useRef(false);
  // What React last rendered, for the dialog's own events.
  const openRef = useRef(open);
  const asking = useRef(false);
  const titleId = useId();

  // Esc, the cancel event and a native close can report the same close at once; close once.
  const requestClose = () => {
    if (!openRef.current || asking.current) return;
    asking.current = true;
    window.setTimeout(() => {
      asking.current = false;
    }, 0);
    onClose();
  };
  useLayer(open, requestClose);

  // Layout effect, so an empty dialog never paints for a frame.
  useLayoutEffect(() => {
    const d = ref.current;
    openRef.current = open;
    if (!d) return;
    if (open) {
      // StrictMode runs effects twice; showModal() on an open dialog throws.
      if (!d.open) {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        d.showModal();
        // showModal() focuses the first button (Close). Start in the first text field instead, if there is one.
        d.querySelector<HTMLElement>('.modal-body [contenteditable="true"], .modal-body textarea:not(:disabled), .modal-body input:not([type=checkbox]):not([type=radio]):not(:disabled)')?.focus();
      }
      shown.current = true;
      addDialog(d);
      return () => removeDialog(d);
    }
    if (d.open) d.close();
    if (!shown.current) return;
    shown.current = false;
    // Back to whatever opened it, e.g. the thumbnail, so keyboard users keep their place.
    const back = opener.current;
    opener.current = null;
    if (back && document.contains(back)) back.focus();
  }, [open]);

  // React passes a nested dialog's cancel and close events up to this one too; only its own count.
  const isOwn = (e: SyntheticEvent) => e.target === ref.current;

  return (
    <dialog
      ref={ref}
      className={`modal modal-${size}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Esc or Android back: close through React. A cancel that cannot be stopped is followed by a close event.
        if (!isOwn(e) || !e.cancelable) return;
        e.preventDefault();
        requestClose();
      }}
      onClose={(e) => {
        // The browser closed it on its own: bring React along.
        if (isOwn(e)) requestClose();
      }}
    >
      {open && (
        <div className="modal-inner">
          <header className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </header>
          <div className="modal-body">{children}</div>
          {footer && <footer className="modal-foot">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
