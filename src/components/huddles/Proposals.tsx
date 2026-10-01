import { Check, NotebookPen, SquareKanban, X } from 'lucide-react';
import { useState } from 'react';
import type { Agent, HuddleProposalSummary, WorkItem } from '../../../shared/types';
import { Markdown } from '../../markdown/Markdown';
import { plainText } from '../../markdown/plainText';
import { Avatar } from '../../ui/Avatar';
import { Lozenge } from '../../ui/Lozenge';
import { agentById, ticketKey } from '../../util';

export type ProposalDecision = (huddleId: string, proposalId: string, decision: 'approve' | 'decline') => Promise<void>;

interface Props {
  huddleId: string;
  /** Decided ones may come without their text (the poll drops it); they then show the title only. */
  proposal: HuddleProposalSummary;
  agents: Agent[];
  items: WorkItem[];
  projectKey: string;
  onDecide: ProposalDecision;
  onOpenTicket: (key: string) => void;
  /** Inbox rows: one line of the text, small buttons. */
  compact?: boolean;
  /** Inbox rows: where it came from, as a link. */
  source?: { label: string; onOpen: () => void };
}

/** One thing a huddle proposed: a ticket for a desk, or a line for the team notes. Nothing happens until you approve it. */
export function ProposalRow({ huddleId, proposal: pr, agents, items, projectKey, onDecide, onOpenTicket, compact, source }: Props) {
  const [busy, setBusy] = useState(false);
  const owner = pr.owner ? agentById(agents, pr.owner) : undefined;
  const ticket = pr.itemId ? items.find((i) => i.id === pr.itemId) : undefined;
  const key = ticket ? ticketKey(ticket, projectKey) : undefined;
  const size = compact ? ' btn-sm' : '';
  const approveLabel = pr.type === 'ticket' ? 'Add to To do' : 'Add to notes';
  // The title of a note is its first 80 characters; show the whole line you are approving.
  const noteText = pr.type === 'note' && pr.text && pr.text !== pr.title ? pr.text : undefined;

  const decide = async (decision: 'approve' | 'decline') => {
    if (busy) return;
    setBusy(true);
    try {
      await onDecide(huddleId, pr.id, decision);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`proposal ${pr.status}${compact ? ' inbox-row' : ''}`}>
      <div className="proposal-main">
        <div className="proposal-line">
          {pr.type === 'ticket' ? <SquareKanban size={15} aria-hidden className="proposal-icon" /> : <NotebookPen size={15} aria-hidden className="proposal-icon" />}
          <span className="proposal-type">{pr.type === 'ticket' ? 'Ticket' : 'Team note'}</span>
          <span className="proposal-title">{pr.title}</span>
        </div>
        {pr.type === 'ticket' && pr.text && (compact ? <p className="inbox-summary">{plainText(pr.text, 180)}</p> : <Markdown source={pr.text} variant="compact" breaks />)}
        {noteText && <p className="proposal-note">{noteText}</p>}
        <div className="inbox-meta">
          {owner && (
            <span className="person-link small">
              <Avatar name={owner.name} color={owner.color} size={18} />
              {owner.name}
            </span>
          )}
          {source && (
            <button type="button" className="link-btn small" onClick={source.onOpen}>
              {source.label}
            </button>
          )}
        </div>
      </div>
      <div className="proposal-actions">
        {pr.status === 'pending' ? (
          <div className="decision-row">
            <button type="button" className={`btn btn-success${size}`} disabled={busy} aria-label={`${approveLabel}: ${pr.title}`} onClick={() => void decide('approve')}>
              <Check size={compact ? 13 : 15} aria-hidden /> {approveLabel}
            </button>
            <button type="button" className={`btn btn-outline${size}`} disabled={busy} aria-label={`Decline: ${pr.title}`} onClick={() => void decide('decline')}>
              <X size={compact ? 13 : 15} aria-hidden /> Decline
            </button>
          </div>
        ) : pr.status === 'approved' ? (
          key ? (
            <button type="button" className="link-btn" onClick={() => onOpenTicket(key)}>
              <Lozenge tone="success">Approved</Lozenge> {key}
            </button>
          ) : (
            <Lozenge tone="success">{pr.type === 'note' ? 'Added to notes' : 'Approved'}</Lozenge>
          )
        ) : (
          <Lozenge>Declined</Lozenge>
        )}
      </div>
    </li>
  );
}
