import { MessagesSquare, Play, Plus } from 'lucide-react';
import type { Agent, Decision, Thread, WorkItem } from '../../shared/types';
import { plainText } from '../markdown/plainText';
import { Avatar } from '../ui/Avatar';
import { TypeIcon } from '../ui/TypeIcon';
import { agentById, ticketKey } from '../util';
import { DecisionBar } from './DecisionBar';

interface Props {
  items: WorkItem[];
  agents: Agent[];
  projectKey: string;
  paused: Thread[];
  onOpen: (key: string) => void;
  onDecide: (id: string, decision: Decision, note?: string) => Promise<void>;
  onOpenAgent: (id: string) => void;
  onOpenThread: (id: string) => void;
  onResumeThread: (id: string) => Promise<void>;
  onCreate: () => void;
}

function Row({ item, agents, projectKey, onOpen, onDecide, onOpenAgent }: { item: WorkItem } & Pick<Props, 'agents' | 'projectKey' | 'onOpen' | 'onDecide' | 'onOpenAgent'>) {
  const owner = agentById(agents, item.assignee);
  const key = ticketKey(item, projectKey);
  return (
    <li className="inbox-row">
      <div className="inbox-main">
        <div className="inbox-line">
          <TypeIcon kind={item.kind} />
          <span className="ticket-key">{key}</span>
          <button type="button" className="inbox-title" onClick={() => onOpen(key)}>
            {item.title}
          </button>
        </div>
        {item.summary && <p className="inbox-summary">{plainText(item.summary, 180)}</p>}
        <div className="inbox-meta">
          {owner && (
            <button type="button" className="person-link small" onClick={() => onOpenAgent(owner.id)}>
              <Avatar name={owner.name} color={owner.color} size={18} running={owner.running} />
              {owner.name}
            </button>
          )}
          {item.client && <span>{item.client}</span>}
          <span className="mono">{item.dated}</span>
        </div>
      </div>
      <div className="inbox-actions">
        <DecisionBar item={item} ownerName={owner?.name ?? 'the desk'} onDecide={onDecide} compact />
      </div>
    </li>
  );
}

/** Everything waiting on Patrick: decisions, holds, and paused chat threads. */
export function NeedsYou(p: Props) {
  const decide = p.items.filter((i) => i.status === 'needs-you').sort((a, b) => b.dated.localeCompare(a.dated) || (b.number ?? 0) - (a.number ?? 0));
  const held = p.items.filter((i) => i.status === 'held');

  if (!decide.length && !held.length && !p.paused.length) {
    return (
      <div className="empty inbox-empty">
        <p className="empty-title">Inbox zero.</p>
        <p>Nothing needs you right now. The team keeps working.</p>
        <button type="button" className="btn btn-primary" onClick={p.onCreate}>
          <Plus size={15} aria-hidden /> Give the team an instruction
        </button>
      </div>
    );
  }

  return (
    <div className="inbox">
      {decide.length > 0 && (
        <section className="inbox-group">
          <h2 className="inbox-heading">
            Needs your decision <span className="badge muted">{decide.length}</span>
          </h2>
          <ul className="inbox-list">
            {decide.map((i) => (
              <Row key={i.id} item={i} {...p} />
            ))}
          </ul>
        </section>
      )}
      {p.paused.length > 0 && (
        <section className="inbox-group">
          <h2 className="inbox-heading">
            Paused threads <span className="badge amber">{p.paused.length}</span>
          </h2>
          <ul className="inbox-list">
            {p.paused.map((t) => (
              <li key={t.id} className="inbox-row">
                <div className="inbox-main">
                  <div className="inbox-line">
                    <MessagesSquare size={16} className="inbox-thread-icon" aria-hidden />
                    <button type="button" className="inbox-title" onClick={() => p.onOpenThread(t.id)}>
                      {t.title}
                    </button>
                  </div>
                  {t.last && <p className="inbox-summary">{plainText(t.last.text, 160)}</p>}
                  <div className="inbox-meta">
                    <span>{t.agentHops} desk messages, then paused</span>
                  </div>
                </div>
                <div className="inbox-actions">
                  <div className="decision-row">
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void p.onResumeThread(t.id)}>
                      <Play size={13} aria-hidden /> Resume
                    </button>
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => p.onOpenThread(t.id)}>
                      Open thread
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {held.length > 0 && (
        <section className="inbox-group">
          <h2 className="inbox-heading">
            On hold <span className="badge muted">{held.length}</span>
          </h2>
          <ul className="inbox-list">
            {held.map((i) => (
              <Row key={i.id} item={i} {...p} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
