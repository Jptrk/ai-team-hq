import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useLayer } from '../hooks/useLayer';

interface Props {
  /** The question, e.g. "Allow scripts for brand?" */
  title: string;
  /** What saying yes means. */
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Only the yes waits while something is busy; Cancel always works. */
  busy?: boolean;
}

/** Give focus back to `el` once it can take it (a switch stays disabled while its change is saving). */
function refocus(el: Element | null): void {
  if (!(el instanceof HTMLElement)) return;
  let tries = 0;
  const attempt = () => {
    // Only when nothing else has taken focus meanwhile.
    const free = !document.activeElement || document.activeElement === document.body;
    if (!free || !document.contains(el)) return;
    el.focus();
    if (document.activeElement !== el && tries++ < 30) window.setTimeout(attempt, 100);
  };
  window.setTimeout(attempt, 0);
}

/**
 * Asks for a yes right in the page, under the control that needs it. Used instead of the browser's
 * confirm(), which a browser can silently turn off ("prevent this page from creating dialogs"),
 * and then the switch just never turns on. Focus starts on Cancel; Esc cancels (it sits on top of
 * the app's Esc layers, so inside a modal Esc answers this first); focus goes back afterwards.
 */
export function ConfirmInline({ title, children, confirmLabel, onConfirm, onCancel, busy }: Props) {
  const titleId = useId();
  const bodyId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  // What had focus when the question opened, read on the first render: in dev, React runs effects twice,
  // and by the second run focus is already on Cancel.
  const opener = useRef<Element | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = document.activeElement;
  useLayer(true, onCancel, { blurFirst: false });

  useEffect(() => {
    cancel.current?.focus();
    return () => refocus(opener.current ?? null);
  }, []);

  return (
    <div className="confirm-inline" role="alertdialog" aria-labelledby={titleId} aria-describedby={bodyId}>
      <p id={titleId} className="confirm-inline-title">
        {title}
      </p>
      <p id={bodyId} className="confirm-inline-body">
        {children}
      </p>
      <div className="confirm-inline-actions">
        <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button ref={cancel} type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
