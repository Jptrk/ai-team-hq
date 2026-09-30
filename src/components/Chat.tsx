import { MessageSquarePlus } from 'lucide-react';
import type { Agent, StateResponse, Thread } from '../../shared/types';
import { plainText } from '../markdown/plainText';
import { Avatar } from '../ui/Avatar';
import { agentById, ticketKey, timeAgo } from '../util';

export function speakerName(agents: Agent[], id: string): string {
  if (id === 'you') return 'You';
  if (id === 'hq') return 'HQ';
  return agentById(agents, id)?.name ?? id;
}

function order(t: Thread): number {
  return t.status === 'paused' ? 0 : t.status === 'open' ? 1 : 2;
}

interface Props {
  state: StateResponse;
  selectedId?: string;
  onOpen: (threadId: string) => void;
  onNew: () => void;
}

/** The thread list: paused first, then most recent. */
export function ThreadList({ state, selectedId, onOpen, onNew }: Props) {
  const threads = [...state.threads].sort((a, b) => order(a) - order(b) || b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="thread-list-pane">
      <div className="thread-list-head">
        <h2 className="pane-title">Threads</h2>
        <button type="button" className="btn btn-outline btn-sm" onClick={onNew}>
          <MessageSquarePlus size={14} aria-hidden /> New thread
        </button>
      </div>
      {threads.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No threads yet.</p>
          <p>Desks start threads when they need each other. You can start one too.</p>
        </div>
      ) : (
        <ul className="thread-list">
          {threads.map((t) => {
            const unread = t.count > t.youSeen && t.status !== 'closed';
            const active = t.waiting.length > 0;
            const item = t.itemId ? state.items.find((i) => i.id === t.itemId) : undefined;
            const people = t.participants.filter((id) => id !== 'you').map((id) => agentById(state.agents, id)).filter(Boolean) as Agent[];
            return (
              <li key={t.id}>
                <button type="button" className={`thread-row${t.id === selectedId ? ' selected' : ''}${t.status === 'closed' ? ' closed' : ''}`} aria-current={t.id === selectedId ? 'true' : undefined} onClick={() => onOpen(t.id)}>
                  <span className="thread-avatars" aria-hidden>
                    {people.slice(0, 2).map((a) => (
                      <Avatar key={a.id} name={a.name} color={a.color} size={24} />
                    ))}
                    {people.length === 0 && <Avatar name="HQ" size={24} />}
                  </span>
                  <span className="thread-body">
                    <span className="thread-top">
                      <span className={`thread-title${unread ? ' unread' : ''}`}>{t.title}</span>
                      <span className="thread-time">{timeAgo(t.updatedAt)}</span>
                    </span>
                    {t.last && (
                      <span className="thread-preview">
                        <strong>{speakerName(state.agents, t.last.from)}:</strong> {plainText(t.last.text, 90)}
                      </span>
                    )}
                    <span className="thread-meta">
                      {item && <span className="ticket-key">{ticketKey(item, state.project.key)}</span>}
                      {t.status === 'paused' && <span className="lozenge warning">paused</span>}
                      {t.status === 'closed' && <span className="lozenge">closed</span>}
                      {active && <span className="thread-replying">{t.waiting.map((id) => speakerName(state.agents, id)).join(', ')} replying…</span>}
                      {unread && !active && <span className="unread-dot" aria-label="Unread" />}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
