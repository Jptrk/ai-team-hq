import { Armchair, Footprints } from 'lucide-react';
import { useState } from 'react';
import type { Agent } from '../../shared/types';
import { OfficeScene } from '../office/OfficeScene';

interface Props {
  agents: Agent[];
  /** Desk id -> who it just messaged, for a speech bubble. */
  saying?: Record<string, string>;
  onSelect: (id: string) => void;
}

export function Office({ agents, onSelect, saying = {} }: Props) {
  const [walking, setWalking] = useState(false);
  const bots = agents.filter((a) => !a.isHuman);
  const working = bots.filter((a) => a.status === 'working').length;
  const waiting = bots.filter((a) => a.status === 'waiting').length;
  const idle = bots.filter((a) => a.status === 'idle').length;
  const off = bots.filter((a) => a.status === 'off').length;

  return (
    <div className="office">
      <div className="office-bar">
        <p className="muted small">Everyone at their desk. Click someone to open their panel.</p>
        <button type="button" className="btn btn-outline btn-sm" aria-pressed={walking} onClick={() => setWalking((w) => !w)}>
          {walking ? <Armchair size={14} aria-hidden /> : <Footprints size={14} aria-hidden />}
          {walking ? 'Back to desks' : 'Walk around'}
        </button>
      </div>
      <div className="office-stage">
        <OfficeScene agents={agents} walking={walking} onSelect={onSelect} saying={saying} />
      </div>
      <div className="stats">
        <div className="stat">
          <span className="stat-n">{working}</span>
          <span className="stat-l">Working</span>
        </div>
        <div className="stat">
          <span className="stat-n">{waiting}</span>
          <span className="stat-l">Waiting on you</span>
        </div>
        <div className="stat">
          <span className="stat-n">{off > 0 ? `${idle} + ${off}` : idle}</span>
          <span className="stat-l">{off > 0 ? 'Free + in the gym' : 'Free'}</span>
        </div>
      </div>
    </div>
  );
}
