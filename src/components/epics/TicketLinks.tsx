import { X } from 'lucide-react';
import { useState } from 'react';
import { blockedByThis, MAX_BLOCKERS, type Agent, type WorkItem } from '../../../shared/types';
import { Avatar } from '../../ui/Avatar';
import { StatusLozenge } from '../../ui/Lozenge';
import { agentById, ticketKey } from '../../util';
import { blockerChoices } from './epicInfo';

interface RowProps {
  item: WorkItem;
  projectKey: string;
  agents: Agent[];
  onOpen: (key: string) => void;
  /** Shown as an X button that takes the ticket off this list. */
  onRemove?: () => void;
  removeLabel?: string;
  busy?: boolean;
  /** Tickets it is blocked by that are not done yet, in words for a Blocked tag. */
  blocked?: string | null;
}

/** One linked ticket: its key (opens it), title, status and owner. */
export function TicketRow({ item, projectKey, agents, onOpen, onRemove, removeLabel, busy, blocked }: RowProps) {
  const key = ticketKey(item, projectKey);
  const owner = agentById(agents, item.assignee);
  return (
    <li className={`link-row${item.status === 'done' ? ' is-done' : ''}`}>
      <button type="button" className="ticket-key key-btn" onClick={() => onOpen(key)} title={`Open ${key}`}>
        {key}
      </button>
      <button type="button" className="link-row-title" onClick={() => onOpen(key)}>
        {item.title}
      </button>
      {blocked && (
        <span className="chip blocked-chip" title={blocked}>
          Blocked
        </span>
      )}
      <StatusLozenge status={item.status} />
      {owner && <Avatar name={owner.name} color={owner.color} size={20} title={`Assignee: ${owner.name}`} />}
      {onRemove && (
        <button type="button" className="icon-btn sm" onClick={onRemove} disabled={busy} aria-label={removeLabel} title={removeLabel}>
          <X size={14} />
        </button>
      )}
    </li>
  );
}

interface Props {
  item: WorkItem;
  items: WorkItem[];
  agents: Agent[];
  projectKey: string;
  onOpen: (key: string) => void;
  /** The whole new list of blockers (ids). Resolves false when it was refused. */
  onSetBlockers: (itemId: string, blockedBy: string[]) => Promise<boolean>;
}

/** What blocks this ticket (you can add and take off), and what it blocks. */
export function TicketLinks({ item, items, agents, projectKey, onOpen, onSetBlockers }: Props) {
  const [busy, setBusy] = useState(false);
  const blockers = (item.blockedBy ?? []).map((id) => items.find((i) => i.id === id)).filter((i): i is WorkItem => Boolean(i));
  const blocks = blockedByThis(item.id, items);
  const choices = blockerChoices(item, items);
  const full = (item.blockedBy?.length ?? 0) >= MAX_BLOCKERS;
  const key = ticketKey(item, projectKey);

  const change = async (next: string[]) => {
    setBusy(true);
    try {
      await onSetBlockers(item.id, next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ticket-section" aria-label="Blocked by and blocks">
      <h3 className="section-label">
        Blocked by {blockers.length > 0 && <span className="muted">({blockers.length})</span>}
      </h3>
      {blockers.length > 0 ? (
        <ul className="link-list">
          {blockers.map((b) => (
            <TicketRow
              key={b.id}
              item={b}
              projectKey={projectKey}
              agents={agents}
              onOpen={onOpen}
              busy={busy}
              removeLabel={`${ticketKey(b, projectKey)} no longer blocks ${key}`}
              onRemove={() => void change((item.blockedBy ?? []).filter((id) => id !== b.id))}
            />
          ))}
        </ul>
      ) : (
        <p className="muted small">Nothing. A desk can start it any time.</p>
      )}
      {item.status !== 'done' && (
        <label className="link-add">
          <span className="sr-only">Add a ticket that blocks {key}</span>
          <select
            className="input"
            value=""
            disabled={busy || !choices.length}
            onChange={(e) => {
              if (e.target.value) void change([...(item.blockedBy ?? []), e.target.value]);
            }}
          >
            <option value="">{full ? `At most ${MAX_BLOCKERS} tickets can block it` : choices.length ? 'Add a ticket it waits for…' : 'No other open ticket can block it'}</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {ticketKey(c, projectKey)} {c.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {blocks.length > 0 && (
        <>
          <h3 className="section-label link-sub">
            Blocks <span className="muted">({blocks.length})</span>
          </h3>
          <ul className="link-list">
            {blocks.map((b) => (
              <TicketRow key={b.id} item={b} projectKey={projectKey} agents={agents} onOpen={onOpen} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
