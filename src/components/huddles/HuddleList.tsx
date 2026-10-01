import { Plus } from 'lucide-react';
import { HUDDLE_KIND_HINT, HUDDLE_KIND_LABEL } from '../../../shared/huddle';
import type { Agent, HuddleKind, HuddleSummary } from '../../../shared/types';
import { Avatar } from '../../ui/Avatar';
import { Lozenge } from '../../ui/Lozenge';
import { agentById, timeAgo } from '../../util';
import { huddleStatus } from './status';

interface Props {
  huddles: HuddleSummary[];
  agents: Agent[];
  onOpen: (id: string) => void;
  onStart: () => void;
}

const KINDS: HuddleKind[] = ['retro', 'brainstorm', 'planning'];

/** Every huddle on the project, newest first. */
export function HuddleList({ huddles, agents, onOpen, onStart }: Props) {
  if (!huddles.length) {
    return (
      <div className="empty huddle-empty">
        <p className="empty-title">No huddles yet.</p>
        <p>A huddle gets a few desks thinking about one thing together. You approve anything it proposes.</p>
        <ul className="huddle-kinds">
          {KINDS.map((k) => (
            <li key={k}>
              <strong>{HUDDLE_KIND_LABEL[k]}</strong> {HUDDLE_KIND_HINT[k]}
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-primary" onClick={onStart}>
          <Plus size={15} aria-hidden /> Start a huddle
        </button>
      </div>
    );
  }

  return (
    <ul className="inbox-list huddle-list">
      {huddles.map((h) => {
        const status = huddleStatus(h, agents);
        const pending = h.proposals.filter((p) => p.status === 'pending').length;
        return (
          <li key={h.id} className="inbox-row">
            <div className="inbox-main">
              <div className="inbox-line">
                <Lozenge tone="neutral">{HUDDLE_KIND_LABEL[h.kind]}</Lozenge>
                <span className="ticket-key">#{h.number}</span>
                <button type="button" className="inbox-title" onClick={() => onOpen(h.id)}>
                  {h.topic}
                </button>
              </div>
              <div className="inbox-meta">
                <span className="huddle-avatars">
                  {h.participants.map((id) => {
                    const a = agentById(agents, id);
                    return <Avatar key={id} name={a?.name ?? id} color={a?.color} size={18} />;
                  })}
                  <span className="sr-only">With {h.participants.map((id) => agentById(agents, id)?.name ?? id).join(', ')}</span>
                </span>
                <span>{status.detail}</span>
                <span className="mono">{timeAgo(h.createdAt)}</span>
              </div>
            </div>
            <div className="inbox-actions huddle-row-status">
              {pending > 0 && <span className="badge">{pending}</span>}
              <Lozenge tone={status.tone}>{status.label}</Lozenge>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
