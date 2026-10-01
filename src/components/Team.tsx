import { Plus } from 'lucide-react';
import { useState } from 'react';
import { MAX_TEAM, type Agent, type WorkItem } from '../../shared/types';
import type { AgentBody } from '../api';
import { Modal } from '../shell/Modal';
import { Avatar } from '../ui/Avatar';
import { Lozenge } from '../ui/Lozenge';
import { AGENT_ORDER, AGENT_STATUS_LABEL, type Tone } from '../util';

interface Props {
  agents: Agent[];
  items: WorkItem[];
  onSelect: (id: string) => void;
  onAdd: (body: AgentBody) => Promise<void>;
}

const TONE: Record<Agent['status'], Tone> = { working: 'success', waiting: 'warning', idle: 'neutral', off: 'neutral' };

function AddTeammate({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: Props['onAdd'] }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [skills, setSkills] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || !role.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd({ name: name.trim(), role: role.trim(), skills });
      setName('');
      setRole('');
      setSkills('');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a teammate"
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !name.trim() || !role.trim()} onClick={() => void submit()}>
            {busy ? 'Adding...' : 'Add to team'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field-row">
          <label className="field grow">
            <span className="label">Name</span>
            <input autoFocus value={name} maxLength={40} placeholder="Kai" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field grow">
            <span className="label">Role</span>
            <input value={role} maxLength={60} placeholder="Mobile Engineer" onChange={(e) => setRole(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span className="label">Handles (routing keywords)</span>
          <input className="mono" value={skills} placeholder="ios, android, react-native, mobile" onChange={(e) => setSkills(e.target.value)} />
          <span className="field-hint">Instructions containing these words go to this desk. Anyone can be reached directly with @Name.</span>
        </label>
        {error && <p className="banner danger">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function Team({ agents, items, onSelect, onAdd }: Props) {
  const [adding, setAdding] = useState(false);
  const sorted = [...agents].sort((a, b) => {
    if (a.isHuman !== b.isHuman) return a.isHuman ? -1 : 1;
    if (Boolean(a.lead) !== Boolean(b.lead)) return a.lead ? -1 : 1;
    if (Boolean(a.running) !== Boolean(b.running)) return a.running ? -1 : 1;
    return AGENT_ORDER[a.status] - AGENT_ORDER[b.status] || a.name.localeCompare(b.name);
  });
  const full = agents.length >= MAX_TEAM;

  return (
    <>
      <ul className="team-grid">
        {sorted.map((a) => {
          const open = items.filter((i) => i.assignee === a.id && i.status !== 'done').length;
          return (
            <li key={a.id}>
              <button type="button" className="team-card" onClick={() => onSelect(a.id)} disabled={a.isHuman}>
                <div className="team-card-head">
                  <Avatar name={a.name} color={a.color} size={40} running={a.running} square />
                  <div className="team-card-name">
                    <span className="team-name">
                      {a.name}
                      {a.lead && <span className="chip lead-chip">lead</span>}
                    </span>
                    <span className="team-role">{a.role}</span>
                  </div>
                </div>
                <Lozenge tone={a.running ? 'success' : TONE[a.status]}>{a.isHuman ? 'you' : a.running ? 'running' : AGENT_STATUS_LABEL[a.status]}</Lozenge>
                {!a.isHuman && <p className="team-task">{a.currentTask ?? 'Nothing assigned'}</p>}
                <div className="team-card-foot">
                  {a.skills.slice(0, 3).map((s) => (
                    <span key={s} className="chip mono">
                      {s}
                    </span>
                  ))}
                  {a.skills.length > 3 && <span className="chip">+{a.skills.length - 3}</span>}
                  {!a.isHuman && <span className="team-open">{open} open</span>}
                </div>
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className="team-card add" onClick={() => setAdding(true)} disabled={full}>
            <Plus size={20} aria-hidden />
            <span>{full ? `Office is full (${MAX_TEAM} desks)` : 'Add teammate'}</span>
          </button>
        </li>
      </ul>
      <AddTeammate open={adding} onClose={() => setAdding(false)} onAdd={onAdd} />
    </>
  );
}
