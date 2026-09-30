import { X } from 'lucide-react';
import { useState } from 'react';
import type { Agent, Run, StateResponse, WorkItem } from '../../shared/types';
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
  onMakeLead: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

const GROUPS: { label: string; match: (i: WorkItem) => boolean }[] = [
  { label: 'Waiting on you', match: (i) => i.status === 'needs-you' || i.status === 'held' },
  { label: 'In progress', match: (i) => i.status === 'in-progress' || i.status === 'sent-back' || i.status === 'approved' },
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
  handoff: 'handed off',
};

const STATUS_TONE: Record<Agent['status'], Tone> = { working: 'success', waiting: 'warning', idle: 'neutral', off: 'neutral' };

export function AgentPanel({ agent, state, onClose, onOpenTicket, onOpenThread, onMakeLead, onRemove }: Props) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = state.project.key;
  const mine = state.items.filter((i) => i.assignee === agent.id);
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
                  <span key={c.name} className="chip mono" title={c.mode === 'read' ? 'Read only' : 'Changes need your approval'}>
                    {c.name} · {c.mode === 'read' ? 'read only' : 'ask'}
                  </span>
                ))}
              </p>
            ) : (
              <p className="muted small">None. Turn them on under Connections.</p>
            )}
          </section>
        )}

        {GROUPS.map((g) => {
          const items = mine.filter(g.match);
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
                const label = r.reason === 'message' && thread ? `Chat: ${thread.title}` : item ? `${ticketKey(item, key)} ${item.title}` : (r.itemId ?? r.id);
                const open = () => (r.reason === 'message' && thread ? onOpenThread(thread.id) : item ? onOpenTicket(ticketKey(item, key)) : undefined);
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
