import { useEffect, useState } from 'react';
import type { Agent } from '../../shared/types';
import { Segmented } from '../ui/Segmented';
import { addMention, MentionChips } from '../ui/MentionChips';
import { Modal } from './Modal';

export type CreateKind = 'task' | 'thread';

interface Props {
  open: boolean;
  initialKind: CreateKind;
  agents: Agent[];
  projectName: string;
  onClose: () => void;
  onTask: (text: string) => Promise<void>;
  onThread: (text: string) => Promise<void>;
}

/** "+ Create": give the team an instruction (a ticket) or start a chat thread. */
export function CreateModal({ open, initialKind, agents, projectName, onClose, onTask, onThread }: Props) {
  const [kind, setKind] = useState<CreateKind>(initialKind);
  const [text, setText] = useState('');
  const [another, setAnother] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setError(null);
    }
  }, [open, initialKind]);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await (kind === 'task' ? onTask(value) : onThread(value));
      setText('');
      if (!another || kind === 'thread') onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through');
    } finally {
      setBusy(false);
    }
  };

  const desk = agents.find((a) => !a.isHuman && !a.lead)?.name ?? 'Leo';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Create in ${projectName}`}
      footer={
        <>
          {kind === 'task' && (
            <label className="check">
              <input type="checkbox" checked={another} onChange={(e) => setAnother(e.target.checked)} /> Create another
            </label>
          )}
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void submit()}>
            {busy ? 'Sending...' : kind === 'task' ? 'Create ticket' : 'Start thread'}
          </button>
        </>
      }
    >
      <div className="create-form">
        <Segmented
          label="What to create"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'task', label: 'Instruction' },
            { value: 'thread', label: 'Chat thread' },
          ]}
        />
        <p className="field-hint">
          {kind === 'task'
            ? `Becomes a ticket. @${desk} sends it to one desk; otherwise the router picks by keywords and the lead catches the rest.`
            : 'Starts a conversation. @mention the desks you want in it; your messages never count toward the loop limit.'}
        </p>
        <textarea
          autoFocus
          rows={5}
          value={text}
          aria-label={kind === 'task' ? 'Instruction' : 'First message'}
          placeholder={kind === 'task' ? `Fix the checkout page on mobile, or @${desk} ...` : `@${desk} who owns the checkout page?`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        <MentionChips agents={agents} onPick={(name) => setText((t) => addMention(t, name))} />
        {error ? <p className="banner danger">{error}</p> : <p className="field-hint">Ctrl+Enter to send.</p>}
      </div>
    </Modal>
  );
}
