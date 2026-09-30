import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../../shared/types';
import { AGENT_STATUS_COLOR } from '../util';

/** Skin, hair and clothes are the same in both themes. */
const PALETTE = { legs: '#33302a', skin: '#f0c9a2', hair: '#3a2b22', eyes: '#2b2b2b', crown: '#e0a83a' };

/** Isometric pixel office. Seats come from agent.seat; walking mode wanders the floor. */

const TW = 64; // tile width
const TH = 32; // tile height
const COLS = 8;
const ROWS = 6;
const OX = 320;
const OY = 96;
const GYM_SPOTS = [
  { col: 7.7, row: 5.3 },
  { col: 6.8, row: 5.9 },
  { col: 8.3, row: 6.1 },
  { col: 5.9, row: 6.5 },
  { col: 7.4, row: 6.8 },
];

interface Props {
  agents: Agent[];
  walking: boolean;
  saying?: Record<string, string>;
  onSelect: (id: string) => void;
}

type Pos = { col: number; row: number };

function toScreen(col: number, row: number) {
  return { x: OX + (col - row) * (TW / 2), y: OY + (col + row) * (TH / 2) };
}

/** Seed seats are a 4x3 block; spread them two tiles apart so tags have room. */
function deskOf(a: Agent): Pos {
  return { col: 1 + a.seat.col * 2, row: 1 + a.seat.row * 2 };
}

function randomTile(): Pos {
  return { col: Math.floor(Math.random() * COLS) + 0.5, row: Math.floor(Math.random() * ROWS) + 0.5 };
}

export function OfficeScene({ agents, walking, onSelect, saying = {} }: Props) {
  const [wander, setWander] = useState<Record<string, Pos>>({});
  const idKey = agents.map((a) => a.id).join(',');

  useEffect(() => {
    if (!walking) {
      setWander({});
      return;
    }
    const shuffle = () => {
      const next: Record<string, Pos> = {};
      for (const a of agents) if (a.status !== 'off') next[a.id] = randomTile();
      setWander(next);
    };
    shuffle();
    const handle = window.setInterval(shuffle, 2400);
    return () => window.clearInterval(handle);
    // agents identity changes every poll; keying on ids keeps the interval stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walking, idKey]);

  const positions = useMemo(() => {
    const map: Record<string, Pos> = {};
    let gym = 0;
    for (const a of agents) {
      if (wander[a.id]) map[a.id] = wander[a.id];
      else if (!a.isHuman && a.status === 'off') map[a.id] = GYM_SPOTS[gym++ % GYM_SPOTS.length];
      else map[a.id] = deskOf(a);
    }
    return map;
  }, [agents, wander]);

  const tiles = useMemo(() => {
    const out: Pos[] = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) out.push({ col: c, row: r });
    return out;
  }, []);

  // Draw order: floor, then desks and people sorted by depth so nearer things overlap farther ones.
  const layered = [
    ...agents.map((a) => {
      const pos = deskOf(a);
      return { kind: 'desk' as const, a, pos, depth: pos.col + pos.row };
    }),
    ...agents.map((a) => {
      const pos = positions[a.id];
      return { kind: 'person' as const, a, pos, depth: pos.col + pos.row + 0.4 };
    }),
  ].sort((l, r) => l.depth - r.depth);

  const corner = (c: number, r: number) => toScreen(c, r);
  const A = corner(0, 0);
  const B = corner(COLS, 0);
  const C = corner(COLS, ROWS);
  const D = corner(0, ROWS);
  const drop = 14;
  const gym = toScreen(7.2, 6);

  return (
    <svg className="office-svg" viewBox="0 0 640 400" role="img" aria-label="Office map">
      <defs>
        <linearGradient id="floorA" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="o-floor-top" />
          <stop offset="1" className="o-floor-bottom" />
        </linearGradient>
      </defs>

      {/* gym mat, outside the front-right edge */}
      <g>
        <polygon
          points={`${gym.x},${gym.y - 40} ${gym.x + 92},${gym.y + 6} ${gym.x},${gym.y + 52} ${gym.x - 92},${gym.y + 6}`}
          className="o-gym"
          strokeWidth="1.5"
        />
        <text x={gym.x} y={gym.y + 50} textAnchor="middle" className="office-sign">
          GYM
        </text>
      </g>

      {/* floor slab */}
      <polygon points={`${D.x},${D.y} ${C.x},${C.y} ${C.x},${C.y + drop} ${D.x},${D.y + drop}`} className="o-slab-front" />
      <polygon points={`${B.x},${B.y} ${C.x},${C.y} ${C.x},${C.y + drop} ${B.x},${B.y + drop}`} className="o-slab-side" />
      <polygon points={`${A.x},${A.y} ${B.x},${B.y} ${C.x},${C.y} ${D.x},${D.y}`} fill="url(#floorA)" />

      {/* tiles */}
      {tiles.map(({ col, row }) => {
        const p = toScreen(col, row);
        const pts = `${p.x},${p.y} ${p.x + TW / 2},${p.y + TH / 2} ${p.x},${p.y + TH} ${p.x - TW / 2},${p.y + TH / 2}`;
        return <polygon key={`${col}-${row}`} points={pts} className={(col + row) % 2 ? 'o-tile-b' : 'o-tile-a'} strokeWidth="0.6" />;
      })}

      {/* rug in the middle aisle */}
      {(() => {
        const p = toScreen(4, 3);
        return <polygon points={`${p.x},${p.y - 2} ${p.x + 30},${p.y + 13} ${p.x},${p.y + 28} ${p.x - 30},${p.y + 13}`} className="o-rug" opacity="0.8" />;
      })()}

      {/* plants in corners */}
      {[toScreen(0.4, 0.4), toScreen(COLS - 0.4, 0.4), toScreen(0.4, ROWS - 0.4)].map((p, i) => (
        <g key={i} transform={`translate(${p.x} ${p.y + TH / 2})`}>
          <rect x="-6" y="-8" width="12" height="10" className="o-plant-pot" />
          <circle cx="0" cy="-14" r="9" className="o-plant-leaf" />
          <circle cx="-6" cy="-10" r="6" className="o-plant-leaf-2" />
          <circle cx="6" cy="-10" r="6" className="o-plant-leaf-2" />
        </g>
      ))}

      {layered.map((l) => {
        const p = toScreen(l.pos.col + 0.5, l.pos.row + 0.5);
        if (l.kind === 'desk') {
          return <Desk key={`desk-${l.a.id}`} x={p.x} y={p.y} accent={l.a.color} />;
        }
        return (
          <Person
            key={`p-${l.a.id}`}
            agent={l.a}
            x={p.x}
            y={p.y - 4}
            walking={walking && l.a.status !== 'off'}
            saying={saying[l.a.id]}
            onClick={() => onSelect(l.a.id)}
          />
        );
      })}
    </svg>
  );
}

function Desk({ x, y, accent }: { x: number; y: number; accent: string }) {
  const w = 24;
  const d = 12;
  const h = 11;
  const top = `${x},${y - d} ${x + w},${y} ${x},${y + d} ${x - w},${y}`;
  const left = `${x - w},${y} ${x},${y + d} ${x},${y + d + h} ${x - w},${y + h}`;
  const right = `${x + w},${y} ${x},${y + d} ${x},${y + d + h} ${x + w},${y + h}`;
  return (
    <g transform="translate(0 10)">
      <polygon points={left} className="o-desk-left" />
      <polygon points={right} className="o-desk-right" />
      <polygon points={top} className="o-desk-top" strokeWidth="0.8" />
      <rect x={x - 8} y={y - 14} width="16" height="10" rx="1" className="o-monitor" />
      <rect x={x - 6.5} y={y - 12.5} width="13" height="7" fill={accent} opacity="0.85" />
      <rect x={x - 1} y={y - 4} width="2" height="4" className="o-monitor" />
    </g>
  );
}

function Person({ agent, x, y, walking, saying, onClick }: { agent: Agent; x: number; y: number; walking: boolean; saying?: string; onClick: () => void }) {
  const status = AGENT_STATUS_COLOR[agent.status];
  const tagW = Math.max(agent.name.length * 5.2, agent.role.length * 4.1) + 16;
  return (
    <g
      className={`person${walking ? ' walking' : ''}`}
      style={{ transform: `translate(${x}px, ${y}px)` }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      <title>{agent.currentTask ?? agent.role}</title>
      <ellipse cx="0" cy="2" rx="8" ry="3" className="o-shadow" />
      <rect x="-5" y="-9" width="4" height="9" fill={PALETTE.legs} />
      <rect x="1" y="-9" width="4" height="9" fill={PALETTE.legs} />
      <rect x="-6.5" y="-22" width="13" height="14" rx="2" fill={agent.color} />
      <rect x="-8.5" y="-21" width="3" height="9" rx="1" fill={agent.color} />
      <rect x="5.5" y="-21" width="3" height="9" rx="1" fill={agent.color} />
      <rect x="-5.5" y="-34" width="11" height="12" rx="2" fill={PALETTE.skin} />
      <rect x="-5.5" y="-34" width="11" height="4" fill={PALETTE.hair} />
      <rect x="-3" y="-28.5" width="2" height="2" fill={PALETTE.eyes} />
      <rect x="1" y="-28.5" width="2" height="2" fill={PALETTE.eyes} />
      {agent.isHuman && <polygon points="-5,-35 -2,-40 0,-36 2,-40 5,-35" fill={PALETTE.crown} />}
      <circle cx="0" cy="-40" r="3" style={{ fill: status }} className="o-status-ring" strokeWidth="1" />
      {saying && (
        <g className="speech" transform="translate(10 -50)">
          <rect x="0" y="-12" width={Math.max(30, saying.length * 5.4 + 12)} height="14" rx="4" className="o-speech" />
          <polygon points="4,2 10,2 3,7" className="o-speech" />
          <text x="6" y="-2" className="speech-text">
            {saying}
          </text>
        </g>
      )}
      {agent.running && !saying && (
        <g className="bubble" transform="translate(12 -44)">
          <rect x="0" y="-10" width="22" height="12" rx="6" className="o-bubble" />
          <circle cx="6" cy="-4" r="1.6" className="o-bubble-dot" />
          <circle cx="11" cy="-4" r="1.6" className="o-bubble-dot" />
          <circle cx="16" cy="-4" r="1.6" className="o-bubble-dot" />
        </g>
      )}
      <g transform="translate(0 -64)">
        <rect x={-tagW / 2} y="0" width={tagW} height="21" rx="3" className="o-tag" />
        <text x="0" y="9" textAnchor="middle" className="tag-name">
          {agent.name.toUpperCase()}
        </text>
        <text x="0" y="17" textAnchor="middle" className="tag-role">
          {agent.role}
        </text>
        <polygon points="-3.5,21 3.5,21 0,25" className="o-tag-pointer" />
      </g>
    </g>
  );
}
