import { useEffect, useLayoutEffect, useRef, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react';
import { useLayer } from '../hooks/useLayer';
import { addDialog, removeDialog } from './topLayer';

interface Props {
  open: boolean;
  /** Changes when the modal shows something else (another ticket or person); focus moves to the new title. */
  subjectKey: string;
  label: string;
  /** Asks to close. Return false to stay open, e.g. when you keep an unsaved draft. */
  onClose: () => boolean | void;
  /** Where to put focus back if the element that opened it is gone. */
  returnFocus?: string;
  children: ReactNode;
}

/**
 * Tickets and people open in this large centered dialog, like Jira's issue view. It stays in the
 * same place in the tree, so the 3-second poll updates it in place. The content brings its own
 * header (breadcrumbs, actions, close). Esc, the close button, or a click on the backdrop closes it.
 */
export function PanelModal({ open, subjectKey, label, onClose, returnFocus, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const shown = useRef(false);
  // The props drop the selector as the modal closes, so keep the last one.
  const lastReturn = useRef<string | undefined>(undefined);
  // What React last rendered, for the dialog's own events.
  const openRef = useRef(open);
  const asking = useRef(false);
  const answer = useRef(true);
  // A press that starts and ends on the backdrop closes; a text selection dragged in or out does not.
  const downOnBackdrop = useRef(false);
  const upOnBackdrop = useRef(false);

  // Esc, the cancel event and a native close can report the same close at once; ask the parent once.
  // True when the parent lets it close.
  const requestClose = (): boolean => {
    if (!openRef.current) return true;
    if (!asking.current) {
      asking.current = true;
      window.setTimeout(() => {
        asking.current = false;
      }, 0);
      answer.current = onClose() !== false;
    }
    return answer.current;
  };
  useLayer(open, requestClose);

  useLayoutEffect(() => {
    if (open && returnFocus) lastReturn.current = returnFocus;
  }, [open, returnFocus]);

  // Layout effect, so an empty dialog never paints for a frame.
  useLayoutEffect(() => {
    const d = ref.current;
    openRef.current = open;
    if (!d) return;
    if (open) {
      if (!d.open) {
        const active = document.activeElement;
        opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
        // StrictMode runs effects twice; showModal() on an open dialog throws.
        d.showModal();
      }
      shown.current = true;
      addDialog(d);
      return () => removeDialog(d);
    }
    if (d.open) d.close();
    if (!shown.current) return;
    shown.current = false;
    // Back to whatever opened it, else the card it was about, else the main area.
    const back = opener.current?.isConnected ? opener.current : null;
    const card = lastReturn.current ? document.querySelector<HTMLElement>(lastReturn.current) : null;
    opener.current = null;
    lastReturn.current = undefined;
    (back ?? card ?? document.getElementById('main'))?.focus();
  }, [open]);

  // Focus the title whenever the subject changes, so screen readers announce the new ticket or person.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => ref.current?.querySelector<HTMLElement>('[data-drawer-title]')?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, subjectKey]);

  const isBackdrop = (e: MouseEvent) => e.target === ref.current;
  // React passes a nested dialog's cancel and close events up to this one too; only its own count.
  const isOwn = (e: SyntheticEvent) => e.target === ref.current;

  return (
    <dialog
      ref={ref}
      className="modal modal-panel"
      aria-label={label}
      onCancel={(e) => {
        // Esc or Android back: stay open and let the parent decide. A cancel that cannot be
        // stopped is followed by a close event, handled below.
        if (!isOwn(e) || !e.cancelable) return;
        e.preventDefault();
        requestClose();
      }}
      onClose={(e) => {
        // The browser closed it on its own: tell the parent, or show it again if the parent keeps it open.
        const d = ref.current;
        if (!isOwn(e) || !d || !openRef.current) return;
        if (!requestClose() && !d.open) d.showModal();
      }}
      onMouseDown={(e) => {
        downOnBackdrop.current = isBackdrop(e);
      }}
      onMouseUp={(e) => {
        upOnBackdrop.current = isBackdrop(e);
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && upOnBackdrop.current && isBackdrop(e)) requestClose();
        downOnBackdrop.current = false;
        upOnBackdrop.current = false;
      }}
    >
      {open && <div className="modal-panel-inner">{children}</div>}
    </dialog>
  );
}
