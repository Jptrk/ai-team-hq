import { Check, ChevronDown, CirclePause, Link as LinkIcon, MessagesSquare, Pencil, Play, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { canEditDescription, hasQa, MAX_DESCRIPTION, signoffOn, type Decision, type ItemStatus, type StateResponse, type WorkItem } from '../../shared/types';
import { TextEditor } from '../editor/TextEditor';
import { usePopover } from '../hooks/usePopover';
import { needsPlainEditor } from '../lib/markdownPaste';
import { Markdown } from '../markdown/Markdown';
import { useUnsavedDraft } from '../shell/draftGuard';
import { AttachmentGrid } from '../ui/attachments/AttachmentGrid';
import { AttachButton, AttachmentTray } from '../ui/attachments/AttachmentTray';
import { Avatar } from '../ui/Avatar';
import { Segmented } from '../ui/Segmented';
import { StatusLozenge } from '../ui/Lozenge';
import { TypeIcon, TYPE_LABEL } from '../ui/TypeIcon';
import { agentById, awaitsSignoff, doneSummary, holdText, ITEM_STATUS_LABEL, latestDecision, signoffVerdict, ticketKey, timeAgo, waitingTitle } from '../util';
import { DecisionBar } from './DecisionBar';
import { ProjectAvatar } from './ProjectAvatar';
import { ReportList } from './ReportList';
import { TicketComments, useDescriptionImages } from './TicketComments';

interface Props {
  item: WorkItem;
  state: StateResponse;
  live: boolean;
  onClose: () => void;
  /** Resolves false when the decision did not go through. */
  onDecide: (id: string, decision: Decision, note?: string, attachments?: string[], includeNotes?: boolean) => Promise<boolean | void>;
  /** Throws so the comment box keeps its draft. */
  onComment: (itemId: string, text: string, attachments: string[], includeNotes?: boolean) => Promise<void>;
  /** Throws so the panel can show the error. */
  onAttach: (itemId: string, attachments: string[]) => Promise<void>;
  /** Throws so the editor keeps the draft. Only To do tickets. */
  onEditDescription: (itemId: string, summary: string) => Promise<void>;
  onRun: (id: string) => Promise<void>;
  onMove: (id: string, status: ItemStatus) => Promise<void>;
  onOpenAgent: (id: string) => void;
  onOpenThread: (id: string) => void;
  onDiscuss: (itemId: string) => void;
}

const MOVE_TO: ItemStatus[] = ['todo', 'in-progress', 'needs-you', 'held', 'done'];
// Menu order. The current status always shows, checked, even one you do not move to by hand (approved, sent back).
const MENU_ORDER: ItemStatus[] = ['todo', 'in-progress', 'sent-back', 'approved', 'qa', 'signoff', 'needs-you', 'held', 'done'];

/** qa: dev-team projects can send a ticket to QA by hand. signoff: projects with sign-off can put it in sign-off. */
function StatusMenu({ item, onMove, qa, signoff }: { item: WorkItem; onMove: Props['onMove']; qa: boolean; signoff: boolean }) {
  const pop = usePopover<HTMLDivElement>();
  const moves: ItemStatus[] = [...MOVE_TO, ...(qa ? (['qa'] as const) : []), ...(signoff ? (['signoff'] as const) : [])];
  const rows = MENU_ORDER.filter((s) => moves.includes(s) || s === item.status);
  return (
    <div className="popover-anchor" ref={pop.ref}>
      <button type="button" className="status-btn" aria-haspopup="menu" aria-expanded={pop.open} onClick={() => pop.setOpen((o) => !o)} title="Change status">
        <StatusLozenge status={item.status} />
        <ChevronDown size={14} aria-hidden />
      </button>
      {pop.open && (
        <div className="popover menu" role="menu" aria-label="Move to">
          <p className="menu-label">Move to</p>
          {rows.map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={item.status === s}
              className={`menu-row${item.status === s ? ' on' : ''}`}
              onClick={() => {
                pop.setOpen(false);
                if (s !== item.status) void onMove(item.id, s);
              }}
            >
              <StatusLozenge status={s} />
              {item.status === s && <Check size={14} className="menu-check" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The description, editable only while the ticket is in To do. */
function Description({ item, onEdit, onComment, onFiles }: { item: WorkItem; onEdit: Props['onEditDescription']; onComment: Props['onComment']; onFiles: (files: File[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.summary);
  const [plain, setPlain] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const sending = useRef(false);
  const editable = canEditDescription(item.status);
  const dirty = draft !== item.summary;
  useUnsavedDraft(editing && dirty);

  // Work started while you were editing: the description locks, nothing is saved, and a changed
  // draft stays to post as a comment. Not while a save is on its way; this runs again once it ends.
  useEffect(() => {
    if (editing && !editable && !sending.current) {
      setEditing(false);
      setError(null);
      setLocked(dirty);
    }
  }, [editing, editable, saving, dirty]);

  const start = () => {
    setDraft(item.summary);
    // Images, HTML and footnotes would not survive the rich editor, so those are edited as markdown.
    setPlain(needsPlainEditor(item.summary));
    setError(null);
    setLocked(false);
    setEditing(true);
  };
  const tooLong = draft.length > MAX_DESCRIPTION;
  const save = async () => {
    if (sending.current) return;
    // Nothing changed: close without saving the text again.
    if (!dirty) {
      setEditing(false);
      return;
    }
    if (tooLong) return;
    sending.current = true;
    setSaving(true);
    setError(null);
    try {
      await onEdit(item.id, draft);
      setEditing(false);
      setLocked(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the description');
    } finally {
      sending.current = false;
      setSaving(false);
    }
  };
  const postAsComment = async () => {
    if (sending.current) return;
    sending.current = true;
    setSaving(true);
    setError(null);
    try {
      await onComment(item.id, draft, []);
      setLocked(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post the comment');
    } finally {
      sending.current = false;
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="description-edit">
        {plain && <p className="field-hint">This description has images or HTML, so it is edited as plain markdown.</p>}
        <TextEditor autoFocus toolbar plain={plain} minHeight={140} value={draft} label="Description" placeholder="What needs doing, and what done looks like" onChange={setDraft} onSubmit={() => void save()} onFiles={onFiles} />
        <div className="form-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={saving || tooLong || !dirty} onClick={() => void save()}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </button>
          <span className={`field-hint${error || tooLong ? ' bad' : ''}`}>{error ?? (tooLong ? `Too long: ${draft.length} of ${MAX_DESCRIPTION} characters.` : 'Ctrl+Enter to save. Locks once the ticket is in progress.')}</span>
        </div>
      </div>
    );
  }
  return (
    <>
      {item.summary.trim() ? <Markdown source={item.summary} breaks /> : !item.attachments?.length && <p className="muted">No description.</p>}
      {editable && (
        <button type="button" className="btn btn-ghost btn-sm description-edit-btn" onClick={start}>
          <Pencil size={13} aria-hidden /> Edit description
        </button>
      )}
      {locked && (
        <div>
          <p className="field-hint">Work started on this ticket, so the description is locked and your edit was not saved. Add a comment instead.</p>
          <pre className="report-raw">{draft}</pre>
          <div className="form-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={saving || !draft.trim()} onClick={() => void postAsComment()}>
              {saving ? 'Posting...' : 'Post as comment'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setLocked(false)}>
              Discard
            </button>
            {error && <span className="field-hint bad">{error}</span>}
          </div>
        </div>
      )}
    </>
  );
}

export function TicketView({ item, state, live, onClose, onDecide, onComment, onAttach, onEditDescription, onRun, onMove, onOpenAgent, onOpenThread, onDiscuss }: Props) {
  const key = ticketKey(item, state.project.key);
  const agents = state.agents;
  const assignee = agentById(agents, item.assignee);
  const from = agentById(agents, item.from);
  const thread = item.threadId ? state.threads.find((t) => t.id === item.threadId) : undefined;
  const decidable = item.status === 'needs-you' || item.status === 'held' || item.status === 'signoff';
  const qaProject = hasQa(state.project.template) || item.status === 'qa';
  const signoff = signoffOn(state.project);
  // In QA, the QA desk is the one to put on it; otherwise the owner.
  const qaDesk = agents.find((a) => a.qa && !a.isHuman);
  const worker = item.status === 'qa' ? qaDesk : assignee;
  const runnable = live && worker && !worker.isHuman && !worker.running && ['todo', 'in-progress', 'sent-back', 'approved', 'qa'].includes(item.status);
  const checker = item.qa?.by ? agentById(agents, item.qa.by) : undefined;
  // Waiting for your sign-off (held there too): QA's pass from this round, or, when QA did not check it, what the owner said it finished.
  const signoffWait = awaitsSignoff(item);
  const verdict = signoffVerdict(item);
  const finished = signoffWait && !verdict ? doneSummary(item) : undefined;
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<'comments' | 'history'>('comments');
  const pid = state.project.id;
  const desc = useDescriptionImages(pid, item.id, onAttach);
  const ask = latestDecision(item);
  const commentCount = item.comments?.length ?? 0;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const person = (id: string | undefined, fallback: string) => {
    const a = id ? agentById(agents, id) : undefined;
    if (!a) return <span>{fallback}</span>;
    return (
      <button type="button" className="person-link" onClick={() => !a.isHuman && onOpenAgent(a.id)} disabled={a.isHuman}>
        <Avatar name={a.name} color={a.color} size={22} running={a.running} />
        <span>{a.isHuman ? `${a.name} (you)` : a.name}</span>
      </button>
    );
  };

  return (
    <div className="panel-view">
      <header className="panel-head">
        <nav className="crumbs" aria-label="Breadcrumb">
          <span className="crumb">
            <ProjectAvatar project={state.project} size={18} />
            {state.project.name}
          </span>
          <span className="crumb">
            <TypeIcon kind={item.kind} />
            <button type="button" className="ticket-key key-btn" onClick={() => void copyLink()} title="Copy link to this ticket">
              {key}
            </button>
          </span>
        </nav>
        <div className="panel-head-actions">
          <button type="button" className="icon-btn sm" onClick={() => void copyLink()} aria-label="Copy link" title="Copy link">
            {copied ? <Check size={16} /> : <LinkIcon size={16} />}
          </button>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close panel" title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="panel-scroll">
        <h2 className="panel-title" tabIndex={-1} data-drawer-title>
          {item.title}
        </h2>

        <div className="ticket-actions">
          <StatusMenu item={item} onMove={onMove} qa={qaProject} signoff={signoff} />
          {worker?.running && <span className="running-note">{worker.name} is {item.status === 'qa' ? 'checking it' : 'working on it'}</span>}
          {runnable && (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => void onRun(item.id)}>
              <Play size={13} aria-hidden /> Put {worker!.name} on it
            </button>
          )}
          {thread ? (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => onOpenThread(thread.id)}>
              <MessagesSquare size={13} aria-hidden /> Thread · {thread.count}
              {thread.status === 'paused' ? ' · paused' : ''}
            </button>
          ) : (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => onDiscuss(item.id)}>
              <MessagesSquare size={13} aria-hidden /> Discuss in chat
            </button>
          )}
        </div>
        {item.autoHold && (
          <p className="banner warning hold-note">
            <CirclePause size={15} aria-hidden /> {holdText(item.autoHold)}
            {runnable ? ` Or put ${worker!.name} on it now.` : ''}
          </p>
        )}
        {item.autoSkip && (
          <p className="banner hold-note">
            <CirclePause size={15} aria-hidden /> Autopilot left this for you: {item.autoSkip.why}
          </p>
        )}

        <div className="ticket-grid">
          <div className="ticket-main">
            {decidable && (
              <section className="callout" aria-label="Your decision">
                <h3 className="callout-title">{waitingTitle(item, checker?.name)}</h3>
                {verdict?.text && (
                  <div className="callout-ask">
                    <Markdown source={verdict.text} variant="compact" breaks />
                  </div>
                )}
                {/* Without a Done summary, the description below says what it was for. */}
                {finished && (
                  <div className="callout-ask">
                    <p>{finished}</p>
                  </div>
                )}
                {!signoffWait && ask && (
                  <div className="callout-ask">
                    {ask.title && <p className="comment-title">{ask.title}</p>}
                    <Markdown source={ask.text} variant="compact" breaks />
                  </div>
                )}
                <DecisionBar item={item} ownerName={assignee?.name ?? 'the desk'} onDecide={onDecide} />
              </section>
            )}

            <section className="ticket-section" {...desc.att.dropZone}>
              <div className="section-head">
                <h3 className="section-label">Description</h3>
                <AttachButton att={desc.att} label="Attach images to the description" />
              </div>
              <Description item={item} onEdit={onEditDescription} onComment={onComment} onFiles={desc.att.add} />
              <AttachmentGrid pid={pid} attachments={item.attachments} from={from?.name ?? (item.from === 'you' ? 'you' : undefined)} />
              <AttachmentTray att={desc.att} />
              {desc.error && <p className="field-hint bad">{desc.error}</p>}
            </section>

            <ReportList pid={pid} item={item} agents={agents} />

            {item.changedFiles && item.changedFiles.length > 0 && (
              <section className="ticket-section">
                <h3 className="section-label">
                  Files changed <span className="muted">({item.changedFiles.length})</span>
                </h3>
                <ul className="changed-files">
                  {[...item.changedFiles].reverse().map((f) => (
                    <li key={f} className="mono small">
                      {f}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="ticket-section">
              <div className="section-head">
                <h3 className="section-label">Activity</h3>
                <Segmented
                  as="tabs"
                  label="Activity"
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'comments', label: commentCount ? `Comments ${commentCount}` : 'Comments' },
                    { value: 'history', label: 'History' },
                  ]}
                />
              </div>
              {tab === 'comments' ? (
                <TicketComments pid={pid} item={item} agents={agents} onComment={onComment} />
              ) : item.history.length ? (
                <ul className="timeline">
                  {[...item.history].reverse().map((h, i) => (
                    <li key={i}>
                      <span className="when">{timeAgo(h.ts)}</span>
                      <span>{h.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">Nothing yet.</p>
              )}
            </section>
          </div>

          <aside className="ticket-details" aria-label="Details">
            <h3 className="section-label">Details</h3>
            <dl className="details">
              <dt>Assignee</dt>
              <dd>{person(item.assignee, item.assignee)}</dd>
              <dt>From</dt>
              <dd>{person(item.from, item.from === 'you' ? 'You' : item.from)}</dd>
              <dt>Status</dt>
              <dd>{ITEM_STATUS_LABEL[item.status]}</dd>
              {qaProject && (
                <>
                  <dt>QA</dt>
                  <dd>
                    {item.status === 'qa' && checker ? (
                      <>Checking: {person(checker.id, checker.name)}</>
                    ) : item.qa?.result ? (
                      `${item.qa.result === 'pass' ? 'Passed' : 'Failed'}${checker ? ` (${checker.name})` : ''}${item.qa.fails ? `, failed ${item.qa.fails} time${item.qa.fails === 1 ? '' : 's'}` : ''}`
                    ) : signoffWait ? (
                      'Not checked by QA this time. You sign it off'
                    ) : qaDesk ? (
                      `Not checked yet. ${qaDesk.name} checks it when it is finished`
                    ) : signoff ? (
                      'No QA desk. You sign it off'
                    ) : (
                      'No QA desk'
                    )}
                  </dd>
                </>
              )}
              <dt>Type</dt>
              <dd className="with-icon">
                <TypeIcon kind={item.kind} /> {TYPE_LABEL[item.kind]}
              </dd>
              <dt>Client</dt>
              <dd>{item.client ?? 'None'}</dd>
              <dt>Dated</dt>
              <dd className="mono small">{item.dated}</dd>
              {thread && (
                <>
                  <dt>Thread</dt>
                  <dd>
                    <button type="button" className="link-btn" onClick={() => onOpenThread(thread.id)}>
                      {thread.count} message{thread.count === 1 ? '' : 's'}
                    </button>
                  </dd>
                </>
              )}
              {from && item.handoffFrom && (
                <>
                  <dt>Handed off by</dt>
                  <dd>{person(item.handoffFrom, item.handoffFrom)}</dd>
                </>
              )}
            </dl>
          </aside>
        </div>
      </div>
    </div>
  );
}
