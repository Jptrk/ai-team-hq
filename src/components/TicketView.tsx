import { Check, ChevronDown, ExternalLink, FileText, Link as LinkIcon, MessagesSquare, Play, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Decision, ItemStatus, StateResponse, WorkItem } from '../../shared/types';
import { usePopover } from '../hooks/usePopover';
import { Markdown } from '../markdown/Markdown';
import { ReportViewer } from '../markdown/ReportViewer';
import { isReportUrl } from '../markdown/reportLinks';
import { Avatar } from '../ui/Avatar';
import { StatusLozenge } from '../ui/Lozenge';
import { TypeIcon, TYPE_LABEL } from '../ui/TypeIcon';
import { agentById, ITEM_STATUS_LABEL, ticketKey, timeAgo } from '../util';
import { DecisionBar } from './DecisionBar';
import { ProjectAvatar } from './ProjectAvatar';

interface Props {
  item: WorkItem;
  state: StateResponse;
  live: boolean;
  onClose: () => void;
  onDecide: (id: string, decision: Decision, note?: string) => Promise<void>;
  onRun: (id: string) => Promise<void>;
  onMove: (id: string, status: ItemStatus) => Promise<void>;
  onOpenAgent: (id: string) => void;
  onOpenThread: (id: string) => void;
  onDiscuss: (itemId: string) => void;
}

const MOVE_TO: ItemStatus[] = ['todo', 'in-progress', 'needs-you', 'held', 'done'];

function StatusMenu({ item, onMove }: { item: WorkItem; onMove: Props['onMove'] }) {
  const pop = usePopover<HTMLDivElement>();
  return (
    <div className="popover-anchor" ref={pop.ref}>
      <button type="button" className="status-btn" aria-haspopup="menu" aria-expanded={pop.open} onClick={() => pop.setOpen((o) => !o)} title="Change status">
        <StatusLozenge status={item.status} />
        <ChevronDown size={14} aria-hidden />
      </button>
      {pop.open && (
        <div className="popover menu" role="menu" aria-label="Move to">
          <p className="menu-label">Move to</p>
          {MOVE_TO.map((s) => (
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

export function TicketView({ item, state, live, onClose, onDecide, onRun, onMove, onOpenAgent, onOpenThread, onDiscuss }: Props) {
  const key = ticketKey(item, state.project.key);
  const agents = state.agents;
  const assignee = agentById(agents, item.assignee);
  const from = agentById(agents, item.from);
  const thread = item.threadId ? state.threads.find((t) => t.id === item.threadId) : undefined;
  const decidable = item.status === 'needs-you' || item.status === 'held';
  const runnable = live && assignee && !assignee.isHuman && !assignee.running && ['todo', 'in-progress', 'sent-back'].includes(item.status);
  const reports = useMemo(() => item.links.filter((l) => isReportUrl(l.url)), [item.links]);
  const [active, setActive] = useState<string | null>(reports[0]?.url ?? null);
  const activeReport = active && reports.some((r) => r.url === active) ? active : (reports[0]?.url ?? null);
  const [copied, setCopied] = useState(false);

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
          <StatusMenu item={item} onMove={onMove} />
          {assignee?.running && <span className="running-note">{assignee.name} is working on it</span>}
          {runnable && (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => void onRun(item.id)}>
              <Play size={13} aria-hidden /> Put {assignee!.name} on it
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

        <div className="ticket-grid">
          <div className="ticket-main">
            {decidable && (
              <section className="callout" aria-label="Your decision">
                <h3 className="callout-title">{item.status === 'held' ? 'On hold. Decide when ready' : 'Needs your decision'}</h3>
                <DecisionBar item={item} ownerName={assignee?.name ?? 'the desk'} onDecide={onDecide} />
              </section>
            )}

            <section className="ticket-section">
              <h3 className="section-label">Description</h3>
              {item.summary.trim() ? <Markdown source={item.summary} breaks /> : <p className="muted">No description.</p>}
            </section>

            {item.links.length > 0 && (
              <section className="ticket-section">
                <h3 className="section-label">Reports</h3>
                <div className="attachments">
                  {item.links.map((l) =>
                    isReportUrl(l.url) ? (
                      <button key={l.url + l.label} type="button" className={`attachment${activeReport === l.url ? ' on' : ''}`} aria-pressed={activeReport === l.url} onClick={() => setActive(l.url)}>
                        <FileText size={14} aria-hidden /> {l.label}
                      </button>
                    ) : /^https?:/i.test(l.url) ? (
                      <a key={l.url + l.label} className="attachment" href={l.url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={14} aria-hidden /> {l.label}
                      </a>
                    ) : (
                      <span key={l.url + l.label} className="attachment disabled" title="Sim mode placeholder, no file behind it">
                        <FileText size={14} aria-hidden /> {l.label}
                      </span>
                    ),
                  )}
                </div>
                {activeReport && <ReportViewer key={activeReport} url={activeReport} />}
              </section>
            )}

            {item.history.length > 0 && (
              <section className="ticket-section">
                <h3 className="section-label">Activity</h3>
                <ul className="timeline">
                  {[...item.history].reverse().map((h, i) => (
                    <li key={i}>
                      <span className="when">{timeAgo(h.ts)}</span>
                      <span>{h.text}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
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
