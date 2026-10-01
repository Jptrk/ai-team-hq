import { Check, CornerUpLeft, MessageSquareText, Pause } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Decision, WorkItem } from '../../shared/types';
import { TextEditor } from '../editor/TextEditor';
import { TEXT_LIMIT } from '../lib/markdownPaste';
import { useProjectId } from '../lib/projectContext';
import { useUnsavedDraft } from '../shell/draftGuard';
import { AttachButton, AttachmentTray } from '../ui/attachments/AttachmentTray';
import { useAttachments } from '../ui/attachments/useAttachments';

interface Props {
  item: WorkItem;
  ownerName: string;
  /** Resolves false when the decision did not go through, so the note and images stay. */
  onDecide: (id: string, decision: Decision, note?: string, attachments?: string[]) => Promise<boolean | void>;
  /** Small buttons for inbox rows. */
  compact?: boolean;
}

export function DecisionBar({ item, ownerName, onDecide, compact }: Props) {
  const [mode, setMode] = useState<'idle' | 'instruct' | 'send-back'>('idle');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const att = useAttachments(useProjectId());
  useUnsavedDraft(mode !== 'idle' && (note.trim().length > 0 || att.count > 0));

  /** With images (from att.take()), only those are removed afterwards; images added meanwhile stay. Approve and Hold reset the note box. */
  // A ref, not state: two key presses in the same moment both see busy as false.
  const sending = useRef(false);
  const run = async (decision: Decision, withNote?: string, images?: { ids: string[]; keys: string[] }) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const ok = await onDecide(item.id, decision, withNote, images?.ids ?? []);
      if (ok === false) return;
      setMode('idle');
      setNote('');
      if (images) att.removeKeys(images.keys);
      else att.clear();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const held = item.status === 'held';
  const size = compact ? ' btn-sm' : '';
  // Same rule for the button and Ctrl+Enter.
  const tooLong = note.length > TEXT_LIMIT;
  const canSend = !busy && !att.uploading && !tooLong && (mode !== 'instruct' || note.trim().length > 0 || att.ids.length > 0);

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
        <div className="decision-note" {...att.dropZone}>
          <AttachmentTray att={att} />
          <TextEditor
            autoFocus
            minHeight={56}
            value={note}
            label={mode === 'instruct' ? `Instruction for ${ownerName}` : `Note for ${ownerName}`}
            placeholder={mode === 'instruct' ? `Tell ${ownerName} what to change...` : `Why is it going back to ${ownerName}? (optional)`}
            onChange={setNote}
            onSubmit={() => {
              if (canSend) void run(mode, note.trim(), att.take());
            }}
            onFiles={att.add}
          />
          {tooLong && (
            <p className="field-hint bad">
              Too long: {note.length} of {TEXT_LIMIT} characters.
            </p>
          )}
          <div className="decision-row">
            <AttachButton att={att} />
            <span className="grow" />
            <button
              type="button"
              className={`btn btn-primary${size}`}
              disabled={!canSend}
              onClick={() => void run(mode, note.trim(), att.take())}
            >
              {att.uploading ? 'Uploading...' : mode === 'instruct' ? 'Send instruction' : 'Send back'}
            </button>
            <button
              type="button"
              className={`btn btn-ghost${size}`}
              disabled={busy}
              onClick={() => {
                setMode('idle');
                att.clear();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
