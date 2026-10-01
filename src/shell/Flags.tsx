import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Flag } from '../hooks/useFlags';
import { useTopDialog } from './topLayer';

const ICON = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle };

function FlagItem({ flag, onDismiss }: { flag: Flag; onDismiss: () => void }) {
  const [held, setHeld] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (held) return;
    timer.current = window.setTimeout(onDismiss, 4500);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [held, onDismiss]);
  const Icon = ICON[flag.tone];
  return (
    <div
      className={`flag ${flag.tone}`}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <Icon size={16} className="flag-icon" aria-hidden />
      <span className="flag-text">{flag.text}</span>
      {flag.action && (
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            flag.action!.onClick();
            onDismiss();
          }}
        >
          {flag.action.label}
        </button>
      )}
      <button type="button" className="icon-btn sm" onClick={onDismiss} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * Always mounted, so screen readers hear every flag. An open modal dialog makes the rest of the page
 * inert and covers it, so while one is open the flags render inside the topmost dialog.
 */
export function Flags({ flags, dismiss }: { flags: Flag[]; dismiss: (id: number) => void }) {
  const topDialog = useTopDialog();
  return createPortal(
    <div className="flags" role="status" aria-live="polite">
      {flags.map((f) => (
        <FlagItem key={f.id} flag={f} onDismiss={() => dismiss(f.id)} />
      ))}
    </div>,
    topDialog ?? document.body,
  );
}
