import { Check, CornerUpLeft, MessageSquareText, Pause } from 'lucide-react';
import { useState } from 'react';
import type { Decision, WorkItem } from '../../shared/types';

interface Props {
  item: WorkItem;
  ownerName: string;
  onDecide: (id: string, decision: Decision, note?: string) => Promise<void>;
  /** Small buttons for inbox rows. */
  compact?: boolean;
}

export function DecisionBar({ item, ownerName, onDecide, compact }: Props) {
  const [mode, setMode] = useState<'idle' | 'instruct' | 'send-back'>('idle');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (decision: Decision, withNote?: string) => {
    setBusy(true);
    try {
      await onDecide(item.id, decision, withNote);
      setMode('idle');
      setNote('');
    } finally {
      setBusy(false);
    }
  };

  const held = item.status === 'held';
  const size = compact ? ' btn-sm' : '';

  return (
    <div className={`decision${compact ? ' compact' : ''}`}>
      <div className="decision-row">
        <button type="button" className={`btn btn-success${size}`} disabled={busy} onClick={() => void run('approve')}>
          <Check size={compact ? 13 : 15} aria-hidden /> Approve
        </button>
        {!held && (
          <button type="button" className={`btn btn-outline${size}`} disabled={busy} onClick={() => void run('hold')}>
            <Pause size={compact ? 13 : 15} aria-hidden /> Hold
          </button>
        )}
        <button type="button" className={`btn btn-outline${size}`} aria-pressed={mode === 'send-back'} disabled={busy} onClick={() => setMode(mode === 'send-back' ? 'idle' : 'send-back')}>
          <CornerUpLeft size={compact ? 13 : 15} aria-hidden /> Send back{compact ? '' : ` to ${ownerName}`}
        </button>
        <button type="button" className={`btn btn-outline${size}`} aria-pressed={mode === 'instruct'} disabled={busy} onClick={() => setMode(mode === 'instruct' ? 'idle' : 'instruct')}>
          <MessageSquareText size={compact ? 13 : 15} aria-hidden /> Instruct
        </button>
      </div>
      {mode !== 'idle' && (
        <div className="decision-note">
          <textarea
            autoFocus
            rows={2}
            value={note}
            aria-label={mode === 'instruct' ? `Instruction for ${ownerName}` : `Note for ${ownerName}`}
            placeholder={mode === 'instruct' ? `Tell ${ownerName} what to change...` : `Why is it going back to ${ownerName}? (optional)`}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run(mode, note.trim());
            }}
          />
          <div className="decision-row">
            <button type="button" className={`btn btn-primary${size}`} disabled={busy || (mode === 'instruct' && !note.trim())} onClick={() => void run(mode, note.trim())}>
              {mode === 'instruct' ? 'Send instruction' : 'Send back'}
            </button>
            <button type="button" className={`btn btn-ghost${size}`} disabled={busy} onClick={() => setMode('idle')}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
