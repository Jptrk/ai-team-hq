import { ArrowLeft, CircleStop, Play, Star } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { HUDDLE_KIND_LABEL, HUDDLE_LANES, MAX_STEER } from '../../../shared/huddle';
import type { Agent, Huddle, HuddleCard, HuddleEntry, HuddleSummary, WorkItem } from '../../../shared/types';
import { api } from '../../api';
import { Markdown } from '../../markdown/Markdown';
import { Avatar } from '../../ui/Avatar';
import { Lozenge } from '../../ui/Lozenge';
import { agentById, timeAgo } from '../../util';
import { ProposalRow, type ProposalDecision } from './Proposals';
import { huddleStatus } from './status';

interface Props {
  pid: string;
  summary: HuddleSummary;
  agents: Agent[];
  items: WorkItem[];
  projectKey: string;
  /** The project sends the team notes with every run, so this huddle gets them too. */
  notesEveryRun: boolean;
  onBack: () => void;
  onOpenTicket: (key: string) => void;
  onStop: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  /** Throws so the box keeps its draft. */
  onSteer: (id: string, text: string) => Promise<void>;
  onDecide: ProposalDecision;
}

const ENTRY_LABEL: Partial<Record<HuddleEntry['kind'], string>> = { summary: 'Summary', steer: 'Your note' };

function Card({ card, agents }: { card: HuddleCard; agents: Agent[] }) {
  const by = agentById(agents, card.by);
  const owner = card.owner ? agentById(agents, card.owner) : undefined;
  return (
    <li className="huddle-card">
      <p className="huddle-card-title">{card.title}</p>
      {card.detail && <p className="huddle-card-detail">{card.detail}</p>}
      <div className="huddle-card-foot">
        <Avatar name={by?.name ?? card.by} color={by?.color} size={16} />
        <span>{by?.name ?? card.by}</span>
        {owner && owner.id !== card.by && <span>· for {owner.name}</span>}
        <span className="grow" />
        <span className="mono">R{card.round}</span>
      </div>
    </li>
  );
}

function Board({ h, agents }: { h: Huddle; agents: Agent[] }) {
  return (
    <div className={`huddle-board kind-${h.kind}`}>
      {HUDDLE_LANES[h.kind].map((l) => {
        const cards = h.cards.filter((c) => c.lane === l.lane);
        return (
          <section key={l.lane} className={`huddle-lane lane-${l.lane}`} aria-label={l.label}>
            <h3 className="huddle-lane-title">
              {l.label} <span className="badge muted">{cards.length}</span>
            </h3>
            {cards.length ? (
              <ul className="huddle-cards">
                {cards.map((c) => (
                  <Card key={c.id} card={c} agents={agents} />
                ))}
              </ul>
            ) : (
              <p className="muted small huddle-lane-empty">{h.status === 'running' ? 'Waiting for the first turns...' : 'Nothing here.'}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Transcript({ h, agents }: { h: Huddle; agents: Agent[] }) {
  const owner = agents.find((a) => a.isHuman);
  const rounds = Array.from({ length: h.round }, (_, i) => i + 1).filter((r) => h.entries.some((e) => e.round === r));
  if (!rounds.length) return <p className="muted small">Nothing said yet.</p>;
  return (
    <ol className="huddle-transcript">
      {rounds.map((r) => (
        <li key={r} className="huddle-round">
          <h3 className="huddle-round-title">Round {r}</h3>
          <ul className="huddle-entries">
            {h.entries
              .filter((e) => e.round === r)
              .map((e) => {
                const a = e.from === 'you' ? owner : agentById(agents, e.from);
                const name = e.from === 'you' ? 'You' : e.from === 'hq' ? 'HQ' : (a?.name ?? e.from);
                const label = ENTRY_LABEL[e.kind];
                return (
                  <li key={e.id} className={`huddle-entry ${e.kind}`}>
                    <Avatar name={name} color={a?.color} size={26} />
                    <div className="huddle-entry-body">
                      <div className="comment-head">
                        <strong>{name}</strong>
                        {label && <Lozenge tone={e.kind === 'summary' ? 'info' : 'accent'}>{label}</Lozenge>}
                        <time className="comment-time" dateTime={e.ts} title={new Date(e.ts).toLocaleString()}>
                          {timeAgo(e.ts)}
                        </time>
                      </div>
                      <Markdown source={e.text} variant="compact" breaks />
                    </div>
                  </li>
                );
              })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function SteerBox({ h, onSteer }: { h: Huddle; onSteer: Props['onSteer'] }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooLong = text.length > MAX_STEER;
  const canSend = text.trim().length > 0 && !tooLong && !busy;
  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await onSteer(h.id, text.trim());
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The note did not go through');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comment-box huddle-steer">
      <label className="sr-only" htmlFor={`steer-${h.id}`}>
        Note to the huddle
      </label>
      <textarea
        id={`steer-${h.id}`}
        rows={2}
        value={text}
        placeholder="Steer the huddle: a question, a constraint, what to focus on..."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="comment-box-row">
        <span className="field-hint">
          {error ? <span className="bad">{error}</span> : tooLong ? <span className="bad">Too long: {text.length} of {MAX_STEER}</span> : 'Desks see it from their next turn. It wakes nobody.'}
        </span>
        <span className="grow" />
        <button type="button" className="btn btn-primary btn-sm" disabled={!canSend} onClick={() => void send()}>
          {busy ? 'Sending...' : 'Send note'}
        </button>
      </div>
    </div>
  );
}

/** One huddle: the board it fills, what it proposes, and the transcript, with Stop, Resume and a box to steer it. */
export function HuddleView({ pid, summary, agents, items, projectKey, notesEveryRun, onBack, onOpenTicket, onStop, onResume, onSteer, onDecide }: Props) {
  const [h, setH] = useState<Huddle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  // The poll carries the summary; the full huddle loads when it changes.
  useEffect(() => {
    const ticket = ++latest.current;
    api
      .huddle(pid, summary.id)
      .then((full) => {
        if (ticket === latest.current) {
          setH(full);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (ticket === latest.current) setError(e instanceof Error ? e.message : 'Could not load the huddle');
      });
  }, [pid, summary.id, summary.updatedAt]);

  const status = huddleStatus(summary, agents);
  const act = async (fn: (id: string) => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn(summary.id);
    } finally {
      setBusy(false);
    }
  };
  // Status comes from the poll, which is always fresher. It drops the text of decided proposals; the full huddle has it.
  const proposals = summary.proposals.map((x) => (x.text !== undefined ? x : { ...x, text: h?.proposals.find((y) => y.id === x.id)?.text }));
  const pending = proposals.filter((x) => x.status === 'pending').length;

  return (
    <div className="huddle-view">
      <div className="huddle-head">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden /> Huddles
        </button>
        <div className="huddle-head-main">
          <h2 className="huddle-title">
            {HUDDLE_KIND_LABEL[summary.kind]} #{summary.number}
            <Lozenge tone={status.tone}>{status.label}</Lozenge>
          </h2>
          <p className="huddle-topic">{summary.topic}</p>
          <p className="huddle-progress muted small">
            {status.detail} · {summary.usedRuns} of about {summary.estimate} desk runs{summary.includeNotes || notesEveryRun ? ' · with team notes' : ''}
          </p>
        </div>
        <div className="huddle-head-actions">
          {summary.status === 'running' && (
            <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void act(onStop)}>
              <CircleStop size={14} aria-hidden /> Stop
            </button>
          )}
          {summary.status === 'stopped' && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(onResume)}>
              <Play size={14} aria-hidden /> Resume
            </button>
          )}
        </div>
      </div>

      <div className="huddle-desks-row">
        {summary.participants.map((id) => {
          const a = agentById(agents, id);
          const waiting = summary.status === 'running' && (summary.phase === 'contribute' ? summary.waiting.includes(id) : summary.facilitator === id);
          return (
            <span key={id} className={`huddle-who${waiting ? ' waiting' : ''}`} title={waiting ? 'Taking a turn' : undefined}>
              <Avatar name={a?.name ?? id} color={a?.color} size={20} running={waiting} />
              {a?.name ?? id}
              {summary.facilitator === id && <span className="chip">facilitator</span>}
            </span>
          );
        })}
      </div>

      {error && <p className="banner danger">{error}</p>}
      {!h && !error && <p className="muted">Loading...</p>}

      {h && (
        <>
          {h.pick && (
            <div className="banner accent huddle-pick">
              <Star size={16} aria-hidden />
              <span>
                <strong>Pick: {h.pick.title}.</strong> {h.pick.reason}
              </span>
            </div>
          )}
          <Board h={h} agents={agents} />
        </>
      )}

      {proposals.length > 0 && (
        <section className="huddle-section">
          <h3 className="inbox-heading">
            Proposals {pending > 0 && <span className="badge">{pending}</span>}
          </h3>
          <p className="field-hint">Approved tickets go to To do for you to start. Approved notes go into the team notes.</p>
          <ul className="inbox-list proposal-list">
            {proposals.map((pr) => (
              <ProposalRow key={pr.id} huddleId={summary.id} proposal={pr} agents={agents} items={items} projectKey={projectKey} onDecide={onDecide} onOpenTicket={onOpenTicket} />
            ))}
          </ul>
        </section>
      )}

      {h && (
        <section className="huddle-section">
          <h3 className="inbox-heading">Transcript</h3>
          <Transcript h={h} agents={agents} />
          {h.status !== 'done' && <SteerBox h={h} onSteer={onSteer} />}
        </section>
      )}
    </div>
  );
}
