import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../shared/types';
import { TextEditor, type EditorHandle } from '../editor/TextEditor';
import { TEXT_LIMIT } from '../lib/markdownPaste';
import { useProjectId } from '../lib/projectContext';
import { AttachButton, AttachmentTray } from '../ui/attachments/AttachmentTray';
import { useAttachments } from '../ui/attachments/useAttachments';
import { Segmented } from '../ui/Segmented';
import { MentionChips } from '../ui/MentionChips';
import { Modal } from './Modal';

export type CreateKind = 'task' | 'thread';

interface Props {
  open: boolean;
  initialKind: CreateKind;
  agents: Agent[];
  projectName: string;
  onClose: () => void;
  onTask: (text: string, attachments: string[]) => Promise<void>;
  onThread: (text: string, attachments: string[]) => Promise<void>;
}

/** "+ Create": give the team an instruction (a ticket) or start a chat thread. */
export function CreateModal({ open, initialKind, agents, projectName, onClose, onTask, onThread }: Props) {
  const [kind, setKind] = useState<CreateKind>(initialKind);
  const [text, setText] = useState('');
  const [another, setAnother] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const att = useAttachments(useProjectId());
  const box = useRef<EditorHandle>(null);

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setError(null);
    }
  }, [open, initialKind]);

  const tooLong = text.length > TEXT_LIMIT;
  const canSubmit = (text.trim().length > 0 || att.ids.length > 0) && !att.uploading && !busy && !tooLong;
  const close = () => {
    att.clear();
    onClose();
  };

  // A ref, not state: two key presses in the same moment both see busy as false.
  const sending = useRef(false);
  const submit = async () => {
    const value = text.trim();
    if (!canSubmit || sending.current) return;
    sending.current = true;
    // Only the images ready now go out; ones pasted while this sends stay.
    const { ids, keys } = att.take();
    setBusy(true);
    setError(null);
    try {
      await (kind === 'task' ? onTask(value, ids) : onThread(value, ids));
      setText('');
      att.removeKeys(keys);
      // Closing drops anything still in the tray, so it never reappears next time Create opens.
      if (!another || kind === 'thread') close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const desk = agents.find((a) => !a.isHuman && !a.lead)?.name ?? 'Leo';

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Create in ${projectName}`}
      footer={
        <>
          {kind === 'task' && (
            <label className="check">
              <input type="checkbox" checked={another} onChange={(e) => setAnother(e.target.checked)} /> Create another
            </label>
          )}
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? 'Sending...' : att.uploading ? 'Uploading...' : kind === 'task' ? 'Create ticket' : 'Start thread'}
          </button>
        </>
      }
    >
      <div className="create-form" {...att.dropZone}>
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
        <TextEditor
          ref={box}
          autoFocus
          toolbar
          minHeight={120}
          value={text}
          label={kind === 'task' ? 'Instruction' : 'First message'}
          placeholder={kind === 'task' ? `Fix the checkout page on mobile, or @${desk} ...` : `@${desk} who owns the checkout page?`}
          onChange={setText}
          onSubmit={() => void submit()}
          onFiles={att.add}
        />
        <AttachmentTray att={att} />
        <div className="create-tools">
          <AttachButton att={att} />
          <MentionChips
            agents={agents}
            onPick={(name) => {
              // Once per desk, where the caret is.
              if (!text.includes(`@${name}`)) box.current?.insertText(`@${name} `);
            }}
          />
        </div>
        {error ? (
          <p className="banner danger">{error}</p>
        ) : tooLong ? (
          <p className="field-hint bad">
            Too long: {text.length} of {TEXT_LIMIT} characters.
          </p>
        ) : (
          <p className="field-hint">Type markdown or use the buttons. Paste or drop images to attach them. Ctrl+Enter to send.</p>
        )}
      </div>
    </Modal>
  );
}
