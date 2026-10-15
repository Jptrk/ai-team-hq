import { Check, Link as LinkIcon, Pencil, Trash2, X, Zap } from 'lucide-react';
import { useState } from 'react';
import { epicProgress, MAX_DESCRIPTION, MAX_EPIC_TITLE, type Epic, type StateResponse, type WorkItem } from '../../../shared/types';
import { TextEditor } from '../../editor/TextEditor';
import { needsPlainEditor } from '../../lib/markdownPaste';
import { Markdown } from '../../markdown/Markdown';
import { useUnsavedDraft } from '../../shell/draftGuard';
import { Avatar } from '../../ui/Avatar';
import { ConfirmInline } from '../../ui/ConfirmInline';
import { Lozenge } from '../../ui/Lozenge';
import { agentById, ticketKey } from '../../util';
import { ProjectAvatar } from '../ProjectAvatar';
import { blockedTitle, EPIC_STATUS_LABEL, EPIC_STATUS_TONE, epicTicketChoices, progressText } from './epicInfo';
import { ProgressBar } from './ProgressBar';
import { TicketRow } from './TicketLinks';

interface Props {
  epic: Epic;
  state: StateResponse;
  onClose: () => void;
  /** Opens a ticket by its key. */
  onOpen: (key: string) => void;
  onOpenAgent: (id: string) => void;
  /** A ticket's epic: this one's id, or null to take it out. */
  onSetEpic: (itemId: string, epicId: string | null) => Promise<void>;
  /** Throws so the editor keeps the draft. */
  onUpdate: (id: string, body: { title?: string; summary?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/** Open tickets first, oldest first, then the done ones. */
function ordered(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || (a.number ?? 0) - (b.number ?? 0));
}

/** One epic in the ticket modal: its progress, description and tickets. */
export function EpicView({ epic, state, onClose, onOpen, onOpenAgent, onSetEpic, onUpdate, onDelete }: Props) {
  const key = ticketKey(epic, state.project.key);
  const progress = epicProgress(epic.id, state.items);
  const tickets = ordered(state.items.filter((i) => i.epicId === epic.id));
  const choices = epicTicketChoices(epic.id, state.items);
  const maker = agentById(state.agents, epic.from);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(epic.title);
  const [summary, setSummary] = useState(epic.summary);
  const [plain, setPlain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const dirty = editing && (title !== epic.title || summary !== epic.summary);
  useUnsavedDraft(dirty);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const startEdit = () => {
    setTitle(epic.title);
    setSummary(epic.summary);
    setPlain(needsPlainEditor(epic.summary));
    setError(null);
    setEditing(true);
  };
  const tooLong = title.trim().length > MAX_EPIC_TITLE || summary.length > MAX_DESCRIPTION;
  const save = async () => {
    if (busy) return;
    if (!dirty) return setEditing(false);
    if (!title.trim() || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      await onUpdate(epic.id, { title: title.trim(), summary });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the epic');
    } finally {
      setBusy(false);
    }
  };

  const move = async (itemId: string, epicId: string | null) => {
    setBusy(true);
    try {
      await onSetEpic(itemId, epicId);
    } finally {
      setBusy(false);
    }
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
            <Zap size={14} className="epic-icon" aria-hidden />
            <button type="button" className="ticket-key key-btn" onClick={() => void copyLink()} title="Copy link to this epic">
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
        {editing ? (
          <div className="epic-edit">
            <label className="field">
              <span className="label">Title</span>
              <input autoFocus value={title} maxLength={MAX_EPIC_TITLE + 20} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <TextEditor toolbar plain={plain} minHeight={120} value={summary} label="Description" placeholder="What this epic is for, and what done looks like" onChange={setSummary} onSubmit={() => void save()} />
            <div className="form-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy || !title.trim() || tooLong || !dirty} onClick={() => void save()}>
                {busy ? 'Saving...' : 'Save'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
              <span className={`field-hint${error || tooLong ? ' bad' : ''}`}>{error ?? (tooLong ? 'Too long.' : 'Ctrl+Enter to save.')}</span>
            </div>
          </div>
        ) : (
          <h2 className="panel-title" tabIndex={-1} data-drawer-title>
            <span className="epic-dot lg" style={{ background: epic.color }} aria-hidden /> {epic.title}
          </h2>
        )}

        <div className="ticket-actions">
          <Lozenge tone={EPIC_STATUS_TONE[progress.status]}>{EPIC_STATUS_LABEL[progress.status]}</Lozenge>
          <span className="muted small">{progressText(progress)}</span>
          {!editing && (
            <button type="button" className="btn btn-outline btn-sm" onClick={startEdit}>
              <Pencil size={13} aria-hidden /> Edit
            </button>
          )}
        </div>
        <ProgressBar progress={progress} />

        <div className="ticket-grid">
          <div className="ticket-main">
            {!editing && (
              <section className="ticket-section">
                <h3 className="section-label">Description</h3>
                {epic.summary.trim() ? <Markdown source={epic.summary} breaks /> : <p className="muted">No description.</p>}
              </section>
            )}

            <section className="ticket-section">
              <h3 className="section-label">
                Tickets <span className="muted">({tickets.length})</span>
              </h3>
              {tickets.length ? (
                <ul className="link-list">
                  {tickets.map((t) => (
                    <TicketRow
                      key={t.id}
                      item={t}
                      projectKey={state.project.key}
                      agents={state.agents}
                      onOpen={onOpen}
                      busy={busy}
                      blocked={blockedTitle(t, state.items, state.project.key)}
                      removeLabel={`Take ${ticketKey(t, state.project.key)} out of this epic`}
                      onRemove={() => void move(t.id, null)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="muted small">No tickets yet. Add one below, or pick this epic on a ticket.</p>
              )}
              <label className="link-add">
                <span className="sr-only">Add a ticket to {epic.title}</span>
                <select
                  className="input"
                  value=""
                  disabled={busy || !choices.length}
                  onChange={(e) => {
                    if (e.target.value) void move(e.target.value, epic.id);
                  }}
                >
                  <option value="">{choices.length ? 'Add a ticket…' : 'Every open ticket is in it'}</option>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {ticketKey(c, state.project.key)} {c.title}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          </div>

          <aside className="ticket-details" aria-label="Details">
            <h3 className="section-label">Details</h3>
            <dl className="details">
              <dt>Status</dt>
              <dd>{EPIC_STATUS_LABEL[progress.status]}</dd>
              <dt>Progress</dt>
              <dd>
                {progress.done} done · {progress.active} in progress · {progress.todo} to do
              </dd>
              <dt>Made by</dt>
              <dd>
                {maker && !maker.isHuman ? (
                  <button type="button" className="person-link" onClick={() => onOpenAgent(maker.id)}>
                    <Avatar name={maker.name} color={maker.color} size={22} running={maker.running} />
                    <span>{maker.name}</span>
                  </button>
                ) : (
                  'You'
                )}
              </dd>
              <dt>Created</dt>
              <dd className="mono small">{epic.createdAt.slice(0, 10)}</dd>
            </dl>
            {asking ? (
              <ConfirmInline
                title={`Delete ${key}?`}
                confirmLabel="Delete epic"
                busy={busy}
                onCancel={() => setAsking(false)}
                onConfirm={() => {
                  setBusy(true);
                  void onDelete(epic.id).finally(() => setBusy(false));
                }}
              >
                {tickets.length === 0 ? 'It has no tickets.' : tickets.length === 1 ? 'Its ticket stays on the board, in no epic.' : `Its ${tickets.length} tickets stay on the board, in no epic.`}
              </ConfirmInline>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm epic-delete" onClick={() => setAsking(true)}>
                <Trash2 size={13} aria-hidden /> Delete epic
              </button>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
