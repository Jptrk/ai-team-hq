import { useEffect, useMemo, useState } from 'react';
import { estimateHuddleRuns, HUDDLE_KIND_HINT, HUDDLE_KIND_LABEL, MAX_HUDDLE_DESKS, MAX_HUDDLE_ROUNDS, MAX_HUDDLE_TOPIC, MIN_HUDDLE_DESKS } from '../../../shared/huddle';
import type { Agent, HuddleKind } from '../../../shared/types';
import type { HuddleBody } from '../../api';
import { Modal } from '../../shell/Modal';
import { Avatar } from '../../ui/Avatar';
import { NotesToggle } from '../../ui/NotesToggle';
import { Segmented } from '../../ui/Segmented';

interface Props {
  open: boolean;
  agents: Agent[];
  live: boolean;
  /** Huddles started today, and the daily limit. */
  startedToday: number;
  limit: number;
  onClose: () => void;
  /** Throws so the form keeps what you typed and shows why. */
  onStart: (body: HuddleBody) => Promise<void>;
}

const KINDS: HuddleKind[] = ['retro', 'brainstorm', 'planning'];
const PLACEHOLDER: Record<HuddleKind, string> = {
  retro: 'The last two weeks of the landing page work',
  brainstorm: 'Ways to get the first 100 newsletter subscribers',
  planning: 'Ship the pricing page by the end of the month',
};

/** The desks a new huddle starts with: the lead first, then whoever is on shift, up to four. */
function defaultDesks(agents: Agent[]): string[] {
  const desks = agents.filter((a) => !a.isHuman && a.status !== 'off').sort((a, b) => Number(Boolean(b.lead)) - Number(Boolean(a.lead)));
  return desks.slice(0, 4).map((a) => a.id);
}

/** Start a huddle: what kind, about what, with whom, for how many rounds. Shows what it will cost before it starts. */
export function HuddleSetup({ open, agents, live, startedToday, limit, onClose, onStart }: Props) {
  const [kind, setKind] = useState<HuddleKind>('retro');
  const [topic, setTopic] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [rounds, setRounds] = useState(2);
  const [withNotes, setWithNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked(defaultDesks(agents));
    setError(null);
    // Only when it opens: the 3-second poll must not reset your picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const desks = useMemo(() => agents.filter((a) => !a.isHuman), [agents]);
  // A desk removed while the form is open drops out of your picks.
  useEffect(() => {
    setPicked((list) => (list.every((id) => desks.some((a) => a.id === id)) ? list : list.filter((id) => desks.some((a) => a.id === id))));
  }, [desks]);
  const lead = desks.find((a) => a.lead);
  const facilitator = lead && picked.includes(lead.id) ? lead : desks.find((a) => a.id === picked[0]);
  const runs = estimateHuddleRuns(picked.length, rounds);
  const left = Math.max(0, limit - startedToday);
  const topicOk = topic.trim().length >= 3 && topic.length <= MAX_HUDDLE_TOPIC;
  const countOk = picked.length >= MIN_HUDDLE_DESKS && picked.length <= MAX_HUDDLE_DESKS;
  const canStart = topicOk && countOk && left > 0 && !busy;

  const toggle = (id: string) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const submit = async () => {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      await onStart({ kind, topic: topic.trim(), participants: picked, rounds, includeNotes: withNotes });
      setTopic('');
      setWithNotes(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The huddle did not start');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start a huddle"
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!canStart} onClick={() => void submit()}>
            {busy ? 'Starting...' : `Start ${HUDDLE_KIND_LABEL[kind].toLowerCase()}`}
          </button>
        </>
      }
    >
      <form
        className="form huddle-setup"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <span className="label">Kind</span>
          <Segmented label="Kind of huddle" value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: HUDDLE_KIND_LABEL[k] }))} />
          <span className="field-hint">{HUDDLE_KIND_HINT[kind]}</span>
        </div>

        <label className="field">
          <span className="label">{kind === 'planning' ? 'Goal' : 'Topic'}</span>
          <textarea rows={2} value={topic} maxLength={MAX_HUDDLE_TOPIC} placeholder={PLACEHOLDER[kind]} onChange={(e) => setTopic(e.target.value)} />
        </label>

        <fieldset className="field">
          <legend className="label">
            Desks <span className="muted">({picked.length} of {MIN_HUDDLE_DESKS}-{MAX_HUDDLE_DESKS})</span>
          </legend>
          <ul className="huddle-desks">
            {desks.map((a) => {
              const on = picked.includes(a.id);
              const off = a.status === 'off';
              const full = !on && picked.length >= MAX_HUDDLE_DESKS;
              // A ticked desk that went off shift can still be unticked.
              const locked = (off && !on) || full;
              return (
                <li key={a.id}>
                  <label className={`huddle-desk${on ? ' on' : ''}${locked ? ' disabled' : ''}`}>
                    <input type="checkbox" checked={on} disabled={locked} onChange={() => toggle(a.id)} />
                    <Avatar name={a.name} color={a.color} size={22} />
                    <span className="huddle-desk-name">
                      {a.name}
                      {a.lead && <span className="chip lead-chip">lead</span>}
                    </span>
                    <span className="huddle-desk-role">{off ? 'off shift' : a.role}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <span className="field-hint">
            {facilitator ? `${facilitator.name} facilitates: sums up each round and writes the proposals.` : 'Pick at least two desks.'}
          </span>
        </fieldset>

        <div className="field">
          <span className="label">Rounds</span>
          <Segmented
            label="Rounds"
            value={String(rounds)}
            onChange={(v) => setRounds(Number(v))}
            options={Array.from({ length: MAX_HUDDLE_ROUNDS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
          />
          <span className="field-hint">Each round, every desk adds its part, then the facilitator sums up. Later rounds react to the summary.</span>
        </div>

        <NotesToggle checked={withNotes} onChange={setWithNotes} />

        <div className={`huddle-cost${left === 0 ? ' over' : ''}`} role="status">
          <strong>
            About {runs} desk run{runs === 1 ? '' : 's'}
          </strong>
          <span>
            {picked.length} desk{picked.length === 1 ? '' : 's'} × {rounds} round{rounds === 1 ? '' : 's'}, plus {rounds} summar{rounds === 1 ? 'y' : 'ies'}.{' '}
            {live ? 'Each run is short (a few turns) and spends your Claude usage.' : 'Sim mode: canned replies, no Claude calls.'}
          </span>
          <span className="muted">
            {limit <= 0 ? 'Huddles are turned off (HQ_HUDDLES_PER_DAY=0).' : left > 0 ? `${left} of ${limit} huddles left today.` : `No huddles left today (limit ${limit}).`}
          </span>
        </div>

        {error && <p className="banner danger">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
