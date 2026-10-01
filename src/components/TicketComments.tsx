import { useEffect, useRef, useState } from 'react';
import type { Agent, Comment, WorkItem } from '../../shared/types';
import { TextEditor } from '../editor/TextEditor';
import { TEXT_LIMIT } from '../lib/markdownPaste';
import { Markdown } from '../markdown/Markdown';
import { useUnsavedDraft } from '../shell/draftGuard';
import { AttachmentGrid } from '../ui/attachments/AttachmentGrid';
import { AttachButton, AttachmentTray } from '../ui/attachments/AttachmentTray';
import { useAttachments } from '../ui/attachments/useAttachments';
import { Avatar } from '../ui/Avatar';
import { Lozenge } from '../ui/Lozenge';
import { NotesToggle } from '../ui/NotesToggle';
import { agentById, timeAgo } from '../util';

interface Props {
  pid: string;
  item: WorkItem;
  agents: Agent[];
  /** Throws so the box keeps its draft. */
  onComment: (itemId: string, text: string, attachments: string[], includeNotes?: boolean) => Promise<void>;
}

const KIND_LABEL: Record<NonNullable<Comment['kind']>, string> = { comment: '', note: 'Your note', decision: 'Asked for a decision', qa: 'QA' };

/** Comments on a ticket, newest first, with a box to add yours. */
export function TicketComments({ pid, item, agents, onComment }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [withNotes, setWithNotes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const att = useAttachments(pid);
  useUnsavedDraft(text.trim().length > 0 || att.count > 0);
  const owner = agentById(agents, item.assignee);
  const list = [...(item.comments ?? [])].reverse();
  const tooLong = text.length > TEXT_LIMIT;
  const canSend = (text.trim().length > 0 || att.ids.length > 0) && !att.uploading && !busy && !tooLong;

  // A ref, not state: two key presses in the same moment both see busy as false.
  const sending = useRef(false);
  const send = async () => {
    if (!canSend || sending.current) return;
    sending.current = true;
    // Only the images ready now go out; ones pasted while this sends stay.
    const { ids, keys } = att.take();
    setBusy(true);
    setError(null);
    try {
      await onComment(item.id, text.trim(), ids, withNotes);
      setText('');
      setWithNotes(false);
      att.removeKeys(keys);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The comment did not go through');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const nameOf = (id: string) => (id === 'you' ? 'You' : (agentById(agents, id)?.name ?? id));

  return (
    <div className="comments">
      <div className="comment-box" {...att.dropZone}>
        <TextEditor
          toolbar
          value={text}
          label="Add a comment"
          placeholder={owner && !owner.isHuman ? `Add a comment. ${owner.name} will answer. Paste images too.` : 'Add a comment. Paste images too.'}
          onChange={setText}
          onSubmit={() => void send()}
          onFiles={att.add}
        />
        <AttachmentTray att={att} />
        <div className="comment-box-row">
          <AttachButton att={att} />
          <NotesToggle checked={withNotes} onChange={setWithNotes} />
          <span className="field-hint">{error ? <span className="bad">{error}</span> : tooLong ? <span className="bad">Too long: {text.length} of {TEXT_LIMIT}</span> : 'Ctrl+Enter to send'}</span>
          <span className="grow" />
          <button type="button" className="btn btn-primary btn-sm" disabled={!canSend} onClick={() => void send()}>
            {busy ? 'Sending...' : att.uploading ? 'Uploading...' : 'Comment'}
          </button>
        </div>
      </div>

      {list.length === 0 ? (
        <p className="muted small">No comments yet.</p>
      ) : (
        <ul className="comment-list">
          {list.map((c) => {
            const a = c.from === 'you' ? agents.find((x) => x.isHuman) : agentById(agents, c.from);
            const label = c.kind ? KIND_LABEL[c.kind] : '';
            return (
              <li key={c.id} className={`comment${c.kind ? ` ${c.kind}` : ''}`}>
                <Avatar name={nameOf(c.from)} color={a?.color} size={26} />
                <div className="comment-body">
                  <div className="comment-head">
                    <strong>{nameOf(c.from)}</strong>
                    {label && <Lozenge tone={c.kind === 'decision' ? 'warning' : c.kind === 'qa' ? 'info' : 'neutral'}>{label}</Lozenge>}
                    <time className="comment-time" dateTime={c.ts} title={new Date(c.ts).toLocaleString()}>
                      {timeAgo(c.ts)}
                    </time>
                  </div>
                  {c.title && <p className="comment-title">{c.title}</p>}
                  {c.text && <Markdown source={c.text} variant="compact" breaks />}
                  <AttachmentGrid pid={pid} attachments={c.attachments} from={nameOf(c.from)} size="sm" />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Attach images to the ticket's description: pick, paste or drop, and they upload and attach. */
export function useDescriptionImages(pid: string, itemId: string, onAttach: (itemId: string, ids: string[]) => Promise<void>) {
  const att = useAttachments(pid);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const tried = useRef('');
  const key = att.ids.join(',');
  const settled = !att.uploading && att.count > 0;
  const { take, removeKeys } = att;
  // A failed upload stays worth mentioning after the good ones attach.
  const failedRef = useRef<string | undefined>(undefined);
  failedRef.current = att.drafts.find((d) => d.status === 'error')?.error;

  // Once every pick has finished uploading, attach the ones that worked, once. Picks added meanwhile wait for the next round.
  useEffect(() => {
    if (!settled || !key || saving || tried.current === key) return;
    tried.current = key;
    const { ids, keys } = take();
    setSaving(true);
    onAttach(itemId, ids).then(
      () => {
        const failed = failedRef.current;
        removeKeys(keys);
        setError(failed ? `Some images did not upload: ${failed}` : null);
        setSaving(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : 'Could not attach');
        setSaving(false);
      },
    );
  }, [settled, key, saving, itemId, onAttach, take, removeKeys]);

  return { att, error, saving };
}
