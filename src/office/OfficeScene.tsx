import { useLayoutEffect, useMemo, useRef, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { depthOf, grow, LAYER, personDepth, spriteBox, toScreen, type Box } from './geometry';
import { hitBox, headOf, labelSpots, nameWidth, offShiftSpots, PILL_H, pinBoxes, TAG_H, TAG_W } from './overlay';
import { PERSON_H, PERSON_W, personColours, personRuns } from './person';
import { ACTIVITY_LABEL, pinOrder, returnTime, type OfficePlan, type Placed } from './placement';
import { SPRITES } from './sprites';
import type { OfficeLayout, Placement } from './types';

/**
 * The office floor: the design team's pixel sprites placed on the 2:1 grid (spec v3, ATHD-18),
 * people on their slots, and a final pass for tags, names and labels so nothing hides them.
 * Coordinates are screen pixels with the room's top corner at (0, 0); the viewBox frames it all.
 *
 * People are drawn in painter's order, which changes as they move, so the keyboard doesn't use those nodes:
 * each person also gets a focus target in a last layer, in a fixed order (you, then desk number). React never
 * moves a target when others change places, so focus stays put, and its focus ring draws above every pin.
 */

export interface PersonPoint {
  id: string;
  /** In viewBox coordinates, for the hover card: centre x, the top of the name pill, and the feet. */
  x: number;
  y: number;
  feet: number;
}

interface Props {
  layout: OfficeLayout;
  plan: OfficePlan;
  ownerName: string;
  /** How many wait on you; over 2 hours of waiting shows !!. */
  waitingCount: number;
  longWait: boolean;
  /** Activate (click, Enter, Space). `pointerType` is what pressed it (none for the keyboard); touch and pen pin the card. */
  onActivate: (id: string, pointerType: string | undefined) => void;
  /** Show the card for this person, or start closing it. */
  onHover: (id: string | null) => void;
  /** Where everyone is now, so the card follows its person when they move. */
  onPoints?: (points: Map<string, PersonPoint>) => void;
  /** The open hover card's element id and who it describes (aria-describedby). */
  described?: { id: string; agentId: string } | null;
  /** Whole-number scale: pixel art never blurs (spec memory note: integer scaling only). */
  scale: number;
  /** The scene's frame in viewBox units, so the stage can pick a scale and place the card. */
  onFrame?: (box: Box) => void;
}

/** The lamp sits on top of the founder's 40 px wall, above the door (Figma 109:2). */
const LAMP_LIFT = 38;

type Drawable = { depth: number; layer: number; order: number; node: ReactNode };
/** A keyboard focus target: who, what a screen reader hears, and the box its ring goes round. */
type Target = { id: string; rank: number; label: string; box: Box };

function use(p: Placement, key: string, className?: string): ReactNode {
  const s = SPRITES[p.sprite];
  if (!s) return null;
  const b = spriteBox(p, s);
  return <use key={key} href={`#spr-${p.sprite}`} x={b.x} y={b.y} width={b.w} height={b.h} className={className} />;
}

/** No duration here: a label that changed every minute would be re-read every minute. The card and the list have it. */
function personLabel(p: Placed, ownerName: string): string {
  if (p.agent.isHuman) return ownerName === p.agent.name ? `${p.agent.name} (you), in your room` : `${p.agent.name}, founder, in their room`;
  return `${p.agent.name}, ${p.agent.role}: ${ACTIVITY_LABEL[p.activity.activity]}`;
}

export function OfficeScene({ layout, plan, ownerName, waitingCount, longWait, onActivate, onHover, onPoints, described, scale, onFrame }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  // Click reads this: on older Safari and Firefox a click is a plain MouseEvent with no pointerType.
  const pressedWith = useRef<string | undefined>(undefined);

  const frame = useMemo(() => {
    const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const items: Drawable[] = [];
    let order = 0;
    const floor: ReactNode[] = [];

    for (const [i, p] of layout.floor.entries()) {
      const s = SPRITES[p.sprite];
      if (!s) continue;
      const b = spriteBox(p, s);
      grow(box, b.x, b.y, b.w, b.h);
      floor.push(use(p, `f${i}`));
    }
    for (const [i, p] of layout.walls.entries()) {
      const s = SPRITES[p.sprite];
      if (!s) continue;
      const b = spriteBox(p, s);
      grow(box, b.x, b.y, b.w, b.h);
      items.push({ depth: depthOf(p), layer: LAYER.wall, order: order++, node: use(p, `w${i}`) });
    }
    for (const [i, p] of layout.furniture.entries()) {
      const s = SPRITES[p.sprite];
      if (!s) continue;
      const b = spriteBox(p, s);
      grow(box, b.x, b.y, b.w, b.h);
      // Rugs lie flat: they go with the floor, under everyone standing on them.
      if (p.sprite.startsWith('rug-')) floor.push(use(p, `r${i}`));
      else items.push({ depth: depthOf(p), layer: LAYER.furniture, order: order++, node: use(p, `o${i}`) });
    }
    return { box, items, floor, order };
  }, [layout]);

  const scene = useMemo(() => {
    const box = { ...frame.box };
    const items = [...frame.items];
    let order = frame.order;
    const top: ReactNode[] = [];
    const points = new Map<string, PersonPoint>();
    const targets: Target[] = [];
    const rankOf = (a: { isHuman?: boolean; deskNo?: number }) => (a.isHuman ? 0 : (a.deskNo ?? 999));

    // The pointer works on what you see; the keyboard on the targets (see the note at the top).
    const press = (e: PointerEvent) => {
      pressedWith.current = e.pointerType;
    };
    const activate = (id: string) => {
      const how = pressedWith.current;
      pressedWith.current = undefined;
      // Focus its target, so a panel opened from here gives focus back to this person when it closes.
      svg.current?.querySelector<SVGGElement>(`.o-target[data-agent="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      onActivate(id, how);
    };
    const enter = (id: string) => (e: PointerEvent) => e.pointerType === 'mouse' && onHover(id);
    const leave = (e: PointerEvent) => e.pointerType === 'mouse' && onHover(null);

    // Owned desks whose owner is elsewhere keep a dimmed nameplate. Under the pins, so it never hides a name.
    for (const { slot, agent } of plan.plates) {
      const c = toScreen(slot.u, slot.v);
      const w = nameWidth(agent.name);
      top.push(
        <g key={`plate-${agent.id}`} className="o-name o-plate" aria-hidden>
          <rect x={c.x - w / 2} y={c.y - 24} width={w} height={PILL_H} rx={4} />
          <text x={c.x} y={c.y - 24 + 10.5} textAnchor="middle">
            {agent.name}
          </text>
        </g>,
      );
    }

    // People, in painter's order with the room.
    for (const p of plan.people) {
      const id = p.agent.id;
      const head = headOf(p.slot);
      const x0 = head.x - PERSON_W / 2;
      const runs = personRuns(personColours(id, p.agent.color));
      // The hit area covers the person, the tag and the name above.
      const hit = hitBox(p.slot);
      points.set(id, { id, x: head.x, y: hit.y0, feet: hit.y1 });
      targets.push({ id, rank: rankOf(p.agent), label: personLabel(p, ownerName), box: hit });
      grow(box, x0 - 20, hit.y0, PERSON_W + 40, head.y + PERSON_H - hit.y0);
      items.push({
        depth: personDepth(p.slot.u, p.slot.v),
        layer: LAYER.person,
        order: order++,
        node: (
          <g key={`p-${id}`} className="o-person" data-agent={id} onPointerDown={press} onClick={() => activate(id)} onPointerEnter={enter(id)} onPointerLeave={leave}>
            <polygon className="o-shadow" points={`${head.x},${head.y + PERSON_H - 1} ${head.x + 12},${head.y + PERSON_H + 4} ${head.x},${head.y + PERSON_H + 9} ${head.x - 12},${head.y + PERSON_H + 4}`} />
            <g transform={`translate(${x0} ${head.y})`}>
              {runs.map((r, i) => (
                <rect key={i} x={r.x} y={r.y} width={r.w} height={2} fill={r.fill} />
              ))}
            </g>
            <rect className="o-hit" x={hit.x0} y={hit.y0} width={hit.x1 - hit.x0} height={hit.y1 - hit.y0} rx={4} />
          </g>
        ),
      });
    }

    // Final pass: tag, then the name pill above it, in pinOrder (front to back, people waiting on you last).
    // The door goes in before them (below), so its count never sits on a name in the queue.
    const pinStart = top.length;
    for (const p of pinOrder(plan.people)) {
      const { tag, pill } = pinBoxes(p.slot, p.agent.name, p.tag !== null);
      top.push(
        <g key={`pin-${p.agent.id}`} aria-hidden>
          {p.tag && tag && <use href={`#spr-status-tag-${p.tag}`} x={tag.x0} y={tag.y0} width={TAG_W} height={TAG_H} />}
          <g className="o-name">
            <rect x={pill.x0} y={pill.y0} width={pill.x1 - pill.x0} height={PILL_H} rx={4} />
            <text x={(pill.x0 + pill.x1) / 2} y={pill.y0 + 10.5} textAnchor="middle">
              {p.agent.name}
            </text>
          </g>
        </g>,
      );
    }

    // Room labels, outside the floor and upright.
    const labels = labelSpots(layout, ownerName);
    for (const l of labels) {
      grow(box, l.box.x0, l.box.y0, l.box.x1 - l.box.x0, l.box.y1 - l.box.y0);
      top.push(
        <text key={l.key} className="o-label" x={l.x} y={l.y} aria-hidden>
          {l.text}
        </text>,
      );
    }
    const labelBoxes = labels.map((l) => l.box);

    // The founder's door: the lamp is lit while someone waits, with a count; !! after two hours.
    const door = toScreen(layout.door.u, layout.door.v);
    const lamp = SPRITES['lamp-lit'];
    if (lamp) {
      const lx = Math.round(door.x - lamp.ax * 2);
      const ly = Math.round(door.y - LAMP_LIFT - lamp.ay * 2);
      const beyond = plan.waitingHidden.length;
      const caption = waitingCount ? `In, ${waitingCount} waiting${beyond ? ` (${beyond} beyond the queue)` : ''}` : 'In, nobody waiting';
      top.splice(
        pinStart,
        0,
        <g key="door" className={`o-door${waitingCount ? ' lit' : ''}${longWait ? ' long' : ''}`} role="img" aria-label={caption}>
          <title>{caption}</title>
          {waitingCount > 0 && <circle className="o-halo" cx={door.x} cy={door.y - LAMP_LIFT} r={9} />}
          <use href="#spr-lamp-lit" x={lx} y={ly} width={lamp.w} height={lamp.h} className="o-lamp" />
          {waitingCount > 0 && (
            <g className="o-badge">
              <circle cx={door.x + 12} cy={door.y - LAMP_LIFT - 14} r={8} />
              <text x={door.x + 12} y={door.y - LAMP_LIFT - 10.5} textAnchor="middle">
                {longWait ? '!!' : waitingCount > 9 ? '9+' : String(waitingCount)}
              </text>
            </g>
          )}
        </g>,
      );
      grow(box, door.x - 12, door.y - LAMP_LIFT - 24, 32, 30);
    }

    // Off shift: outside the floor, in front of the play area. Chips flow down three to a column, then wrap
    // into the next column; the name sits beside each chip, the return time under it.
    const chip = SPRITES['off-shift-chip'];
    if (plan.offShift.length && chip) {
      const backs = plan.offShift.map(({ agent }) => returnTime(agent.currentTask));
      const spots = offShiftSpots(layout, plan.offShift.map(({ agent }, i) => ({ name: agent.name, back: backs[i] })), chip, labelBoxes);
      top.push(
        <text key="off-label" className="o-off-label" x={spots[0].x} y={spots[0].y - 6} aria-hidden>
          OFF SHIFT (outside)
        </text>,
      );
      grow(box, spots[0].x, spots[0].y - 18, spots[0].w, 18);
      plan.offShift.forEach(({ agent }, i) => {
        const { x, y, w, name, back: backAt } = spots[i];
        const back = backs[i];
        const id = agent.id;
        const hit: Box = { x0: x - 3, y0: y - 3, x1: x + w + 3, y1: y + chip.h + 3 };
        points.set(id, { id, x: x + chip.w / 2, y, feet: y + chip.h });
        targets.push({ id, rank: rankOf(agent), label: `${agent.name}, ${agent.role}: off shift${back ? `, back ${back}` : ''}`, box: hit });
        grow(box, hit.x0, hit.y0, hit.x1 - hit.x0, hit.y1 - hit.y0);
        top.push(
          <g key={`off-${id}`} className="o-person o-off" data-agent={id} aria-hidden onPointerDown={press} onClick={() => activate(id)} onPointerEnter={enter(id)} onPointerLeave={leave}>
            <use href="#spr-off-shift-chip" x={x} y={y} width={chip.w} height={chip.h} />
            {/* Name beside the chip (Figma 109:2); the return time under it, so the strip stays narrow. */}
            <text className="o-off-name" x={name.x} y={name.y}>
              {agent.name}
            </text>
            {back && backAt && (
              <text className="o-off-back" x={backAt.x} y={backAt.y}>
                {back}
              </text>
            )}
            <rect className="o-hit" x={hit.x0} y={hit.y0} width={hit.x1 - hit.x0} height={hit.y1 - hit.y0} rx={4} />
          </g>,
        );
      });
    }

    items.sort((a, b) => a.depth - b.depth || a.layer - b.layer || a.order - b.order);
    targets.sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
    return { box, items, top, points, targets };
  }, [frame, plan, layout, ownerName, waitingCount, longWait, onActivate, onHover]);

  const pad = 16;
  const vb = { x: Math.floor(scene.box.x0 - pad), y: Math.floor(scene.box.y0 - pad), w: Math.ceil(scene.box.x1 - scene.box.x0 + pad * 2), h: Math.ceil(scene.box.y1 - scene.box.y0 + pad * 2) };
  useLayoutEffect(() => {
    onFrame?.({ x0: vb.x, y0: vb.y, x1: vb.x + vb.w, y1: vb.y + vb.h });
  }, [vb.x, vb.y, vb.w, vb.h, onFrame]);
  useLayoutEffect(() => {
    onPoints?.(scene.points);
  }, [scene.points, onPoints]);

  const used = new Set<string>([...layout.floor, ...layout.walls, ...layout.furniture].map((p) => p.sprite));
  for (const t of ['code', 'work', 'chat', 'idle', 'wait', 'off']) used.add(`status-tag-${t}`);
  used.add('lamp-lit');
  used.add('off-shift-chip');

  const keyDown = (id: string) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onActivate(id, undefined);
  };
  // The card opens for keyboard focus only: focus put back by script after a click (a panel closing) stays quiet.
  const focus = (id: string) => (e: FocusEvent<SVGGElement>) => e.currentTarget.matches(':focus-visible') && onHover(id);

  return (
    <svg ref={svg} className="office-svg" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} width={vb.w * scale} height={vb.h * scale} shapeRendering="crispEdges" aria-label="Office floor">
      <defs>
        {[...used].map((name) => {
          const s = SPRITES[name];
          return s ? <symbol key={name} id={`spr-${name}`} viewBox={s.viewBox} dangerouslySetInnerHTML={{ __html: s.body }} /> : null;
        })}
      </defs>
      <g className="o-floor" aria-hidden>
        {frame.floor}
      </g>
      <g className="o-room" aria-hidden>
        {scene.items.map((i) => i.node)}
      </g>
      <g className="o-top">{scene.top}</g>
      <g className="o-targets">
        {scene.targets.map((t) => (
          <g
            key={`t-${t.id}`}
            className="o-target"
            role="button"
            tabIndex={0}
            aria-label={t.label}
            aria-describedby={described?.agentId === t.id ? described.id : undefined}
            data-agent={t.id}
            onKeyDown={keyDown(t.id)}
            onFocus={focus(t.id)}
            onBlur={() => onHover(null)}
          >
            {/* Two rings, dark outside and light inside, so focus shows on every floor tone and on the dark stage. */}
            <rect className="o-ring o-ring-out" x={t.box.x0} y={t.box.y0} width={t.box.x1 - t.box.x0} height={t.box.y1 - t.box.y0} rx={4} />
            <rect className="o-ring o-ring-in" x={t.box.x0} y={t.box.y0} width={t.box.x1 - t.box.x0} height={t.box.y1 - t.box.y0} rx={4} />
          </g>
        ))}
      </g>
    </svg>
  );
}
