import { Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MAX_DESCRIPTION, MAX_EPIC_TITLE, type Epic, type WorkItem } from '../../../shared/types';
import { TextEditor } from '../../editor/TextEditor';
import { Modal } from '../../shell/Modal';
import { Lozenge } from '../../ui/Lozenge';
import { ticketKey } from '../../util';
import { EPIC_STATUS_LABEL, EPIC_STATUS_TONE, progressText, sortEpics } from './epicInfo';
import { ProgressBar } from './ProgressBar';

interface Props {
  epics: Epic[];
  items: WorkItem[];
  projectKey: string;
  onOpen: (key: string) => void;
  onNew: () => void;
}

/** The Epics page: every epic with its progress. One opens in the ticket modal. */
export function EpicList({ epics, items, projectKey, onOpen, onNew }: Props) {
  if (!epics.length) {
    return (
      <div className="empty">
        <Zap size={28} className="epic-icon" aria-hidden />
        <p className="empty-title">No epics yet</p>
        <p className="muted">An epic groups tickets toward one bigger piece of work, and shows how far along it is. The lead can make them too, when it plans toward the goal.</p>
        <button type="button" className="btn btn-primary" onClick={onNew}>
          New epic
        </button>
      </div>
    );
  }
  return (
    <ul className="epic-list">
      {sortEpics(epics, items).map(({ epic, progress }) => {
        const key = ticketKey(epic, projectKey);
        return (
          <li key={epic.id} className={`epic-row${progress.status === 'done' ? ' is-done' : ''}`}>
            <span className="epic-dot lg" style={{ background: epic.color }} aria-hidden />
            <span className="ticket-key">{key}</span>
            <button type="button" className="epic-row-title" onClick={() => onOpen(key)}>
              {epic.title}
            </button>
            <Lozenge tone={EPIC_STATUS_TONE[progress.status]}>{EPIC_STATUS_LABEL[progress.status]}</Lozenge>
            <span className="epic-row-progress">
              <ProgressBar progress={progress} compact />
              <span className="muted small">{progressText(progress)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** New epic: a title, and optionally what it is for. Opens it once made. */
export function NewEpicModal({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (title: string, summary: string) => Promise<unknown> }) {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    if (open) {
      setTitle('');
      setSummary('');
      setError(null);
    }
  }, [open]);

  const titleLong = title.trim().length > MAX_EPIC_TITLE;
  const tooLong = titleLong || summary.length > MAX_DESCRIPTION;
  const canSubmit = Boolean(title.trim()) && !tooLong && !busy;
  const submit = async () => {
    if (!canSubmit || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCreate(title.trim(), summary);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not make the epic');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New epic"
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? 'Creating...' : 'Create epic'}
          </button>
        </>
      }
    >
      <form
        className="create-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span className="label">Title</span>
          <input autoFocus value={title} placeholder="Checkout on mobile" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <TextEditor toolbar minHeight={100} value={summary} label="Description" placeholder="What this epic is for, and what done looks like (optional)" onChange={setSummary} onSubmit={() => void submit()} />
        {error ? (
          <p className="banner danger">{error}</p>
        ) : (
          <p className={`field-hint${tooLong ? ' bad' : ''}`}>{titleLong ? `Too long: a title can be at most ${MAX_EPIC_TITLE} characters.` : tooLong ? `Too long: the description can be at most ${MAX_DESCRIPTION} characters.` : 'Add tickets from the epic, or pick it on a ticket.'}</p>
        )}
      </form>
    </Modal>
  );
}
