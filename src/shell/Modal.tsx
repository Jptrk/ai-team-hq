import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useLayer } from '../hooks/useLayer';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: 'md' | 'wide';
  children: ReactNode;
  footer?: ReactNode;
}

/** Native <dialog>: focus trap, backdrop and top layer for free. Esc goes through the layer stack. */
export function Modal({ open, onClose, title, size = 'md', children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayer(open, onClose);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    // StrictMode runs effects twice; showModal() on an open dialog throws.
    if (open && !d.open) {
      d.showModal();
      // showModal() focuses the first button (Close). Start in the first text field instead, if there is one.
      d.querySelector<HTMLElement>('.modal-body textarea:not(:disabled), .modal-body input:not([type=checkbox]):not([type=radio]):not(:disabled)')?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className={`modal modal-${size}`} aria-labelledby={titleId} onCancel={(e) => e.preventDefault()}>
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
