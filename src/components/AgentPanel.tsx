import { X } from 'lucide-react';
import { useState } from 'react';
import { HUDDLE_KIND_LABEL } from '../../shared/huddle';
import type { Agent, Run, StateResponse, WorkItem } from '../../shared/types';
import { hasQa } from '../../shared/types';
import { Avatar } from '../ui/Avatar';
import { Lozenge, StatusLozenge } from '../ui/Lozenge';
import { TypeIcon } from '../ui/TypeIcon';
import { AGENT_STATUS_LABEL, ticketKey, timeAgo, type Tone } from '../util';

interface Props {
  agent: Agent;
  state: StateResponse;
  onClose: () => void;
  onOpenTicket: (key: string) => void;
  onOpenThread: (id: string) => void;
  onOpenHuddle: (id: string) => void;
  onMakeLead: (id: string) => Promise<void>;
  /** Dev-team projects: make this desk the QA desk, or stop. */
  onSetQa: (id: string, on: boolean) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

const GROUPS: { label: string; match: (i: WorkItem) => boolean }[] = [
  { label: 'Waiting on you', match: (i) => i.status === 'needs-you' || i.status === 'held' || i.status === 'signoff' },
  { label: 'In progress', match: (i) => i.status === 'in-progress' || i.status === 'sent-back' || i.status === 'approved' },
  { label: 'In QA', match: (i) => i.status === 'qa' },
  { label: 'Queued', match: (i) => i.status === 'todo' },
  { label: 'Done', match: (i) => i.status === 'done' },
];

const RUN_REASON: Record<Run['reason'], string> = {
  instruction: 'new instruction',
  'send-back': 'sent back',
  instruct: 'your note',
  approved: 'approved, finalizing',
  manual: 'started by you',
  message: 'teammate message',
  huddle: 'huddle turn',
  handoff: 'handed off',
  comment: 'your comment',
  qa: 'QA check',
  'qa-fail': 'fixing QA issues',
};

const STATUS_TONE: Record<Agent['status'], Tone> = { working: 'success', waiting: 'warning', idle: 'neutral', off: 'neutral' };

export function AgentPanel({ agent, state, onClose, onOpenTicket, onOpenThread, onOpenHuddle, onMakeLead, onSetQa, onRemove }: Props) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = state.project.key;
  const mine = state.items.filter((i) => i.assignee === agent.id);
  const qaProject = hasQa(state.project.template);
  // The QA desk's own queue: other desks' tickets it is checking.
  const checking = agent.qa ? state.items.filter((i) => i.status === 'qa' && i.assignee !== agent.id) : [];
  const recent = state.activity.filter((a) => a.agentId === agent.id).slice(0, 8);
  const runs = state.runs.filter((r) => r.agentId === agent.id).slice(0, 6);
  const connections = (state.connections ?? []).filter((c) => c.enabled && c.desks.includes(agent.id));

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  };

  return (
    <div className="panel-view">
      <header className="panel-head">
        <nav className="crumbs" aria-label="Breadcrumb">
          <span className="crumb">{state.project.name}</span>
          <span className="crumb">Team</span>
        </nav>
        <div className="panel-head-actions">
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close panel" title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="panel-scroll">
        <div className="agent-hero">
          <Avatar name={agent.name} color={agent.color} size={56} running={agent.running} square />
          <div className="agent-hero-text">
            <h2 className="panel-title" tabIndex={-1} data-drawer-title>
              {agent.name}
              {agent.lead && <span className="chip lead-chip">lead</span>}
              {agent.qa && qaProject && <span className="chip qa-chip">QA</span>}
            </h2>
            <p className="muted">
              {agent.role} · {agent.desk}
            </p>
            <Lozenge tone={agent.running ? 'success' : STATUS_TONE[agent.status]}>{agent.isHuman ? 'you' : agent.running ? 'running' : AGENT_STATUS_LABEL[agent.status]}</Lozenge>
          </div>
        </div>

        {!agent.isHuman && (
          <section className="ticket-section">
            <h3 className="section-label">On it now</h3>
            <p>{agent.currentTask ?? 'Nothing assigned.'}</p>
            <p className="muted small">
              Last active {timeAgo(agent.lastActive)}
              {agent.spentUsd !== undefined && ` · about $${agent.spentUsd.toFixed(2)} used`}
            </p>
          </section>
        )}

        {!agent.isHuman && (
          <section className="ticket-section">
            <h3 className="section-label">Handles</h3>
            {agent.skills.length ? (
              <p className="chips">
                {agent.skills.map((s) => (
                  <span key={s} className="chip mono">
                    {s}
                  </span>
                ))}
              </p>
            ) : (
              <p className="muted small">No routing keywords. Reach this desk with @{agent.name}{agent.lead ? ', or anything nobody else matches' : ''}.</p>
            )}
          </section>
        )}

        {!agent.isHuman && (
          <section className="ticket-section">
            <h3 className="section-label">Connections</h3>
            {connections.length ? (
              <p className="chips">
                {connections.map((c) => (
                  <span key={c.name} className="chip mono" title={c.mode === 'read' ? 'Read only' : c.mode === 'auto' ? 'Changes run on their own; deletes need your approval' : 'Changes need your approval'}>
                    {c.name} · {c.mode === 'read' ? 'read only' : c.mode}
                  </span>
                ))}
              </p>
            ) : (
              <p className="muted small">None. Turn them on under Connections.</p>
            )}
          </section>
        )}

        {[...(checking.length ? [{ label: 'Checking for QA', items: checking }] : []), ...GROUPS.map((g) => ({ label: g.label, items: mine.filter(g.match) }))].map((g) => {
          const items = g.items;
          if (!items.length) return null;
          return (
            <section key={g.label} className="ticket-section">
              <h3 className="section-label">
                {g.label} <span className="muted">({items.length})</span>
              </h3>
              <ul className="mini-list">
                {items.map((i) => (
                  <li key={i.id}>
                    <button type="button" className="mini-item" onClick={() => onOpenTicket(ticketKey(i, key))}>
                      <TypeIcon kind={i.kind} />
                      <span className="ticket-key">{ticketKey(i, key)}</span>
                      <span className="mini-title">{i.title}</span>
                      <StatusLozenge status={i.status} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {runs.length > 0 && (
          <section className="ticket-section">
            <h3 className="section-label">Runs</h3>
            <ul className="runs">
              {runs.map((r) => {
                const item = r.itemId ? state.items.find((i) => i.id === r.itemId) : undefined;
                const thread = r.threadId ? state.threads.find((t) => t.id === r.threadId) : undefined;
                const huddle = r.huddleId ? state.huddles.find((h) => h.id === r.huddleId) : undefined;
                const label =
                  r.reason === 'message' && thread
                    ? `Chat: ${thread.title}`
                    : huddle
                      ? `${HUDDLE_KIND_LABEL[huddle.kind]} #${huddle.number}: ${huddle.topic.length > 60 ? `${huddle.topic.slice(0, 59)}…` : huddle.topic}`
                      : r.huddleId
                        ? 'Huddle (no longer kept)'
                        : item
                          ? `${ticketKey(item, key)} ${item.title}`
                          : (r.itemId ?? r.id);
                const open = () =>
                  r.reason === 'message' && thread ? onOpenThread(thread.id) : huddle ? onOpenHuddle(huddle.id) : item ? onOpenTicket(ticketKey(item, key)) : undefined;
                return (
                  <li key={r.id} className={`run run-${r.status}`}>
                    <button type="button" className="run-title" onClick={open}>
                      <span className={`dot${r.status === 'running' ? ' pulse' : ''}`} />
                      {label}
                    </button>
                    <span className="run-meta">
                      {RUN_REASON[r.reason]} · {r.status}
                      {r.turns !== undefined && ` · ${r.turns} turns`}
                      {r.costUsd !== undefined && ` · est. $${r.costUsd.toFixed(3)}`} · {timeAgo(r.startedAt)}
                    </span>
                    {r.error && <span className="run-error">{r.error}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {recent.length > 0 && (
          <section className="ticket-section">
            <h3 className="section-label">Recent</h3>
            <ul className="timeline">
              {recent.map((a) => (
                <li key={a.id}>
                  <span className="when">{timeAgo(a.ts)}</span>
                  <span>{a.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!agent.isHuman && (
          <section className="ticket-section agent-actions">
            {!agent.lead && (
              <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void act(() => onMakeLead(agent.id))}>
                Make lead
              </button>
            )}
            {qaProject && (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={busy}
                title={agent.qa ? 'Finished tickets then come straight to you to sign off' : 'This desk checks finished tickets before you sign them off'}
                onClick={() => void act(() => onSetQa(agent.id, !agent.qa))}
              >
                {agent.qa ? 'Stop QA' : 'Make QA desk'}
              </button>
            )}
            <button
              type="button"
              className={`btn btn-sm ${confirmRemove ? 'btn-danger' : 'btn-outline'}`}
              disabled={busy || agent.running}
              title={agent.running ? 'Wait for the run to finish' : undefined}
              onClick={() => (confirmRemove ? void act(() => onRemove(agent.id)) : setConfirmRemove(true))}
            >
              {confirmRemove ? `Click again to remove ${agent.name}` : 'Remove from team'}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
