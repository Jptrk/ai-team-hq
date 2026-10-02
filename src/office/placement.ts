import type { Activity, AgentActivity } from '../../shared/activity';
import type { Agent } from '../../shared/types';
import { pinCovers } from './overlay';
import type { OfficeLayout, Slot, SlotZone } from './types';

/**
 * Who stands where on the office floor. Pure: the scene draws what this returns, and the tests check it.
 * Spec §2 and §9: zone, colour and glyph always agree; states change by moving slot to slot (no walking).
 */

/** The status tag sprite for an activity: status-tag-<tag>.svg. */
export type Tag = 'code' | 'work' | 'chat' | 'idle' | 'wait' | 'off';

export const TAG_OF: Record<Activity, Tag> = { coding: 'code', working: 'work', chatting: 'chat', idle: 'idle', waiting: 'wait', off: 'off' };

export const ACTIVITY_LABEL: Record<Activity, string> = {
  coding: 'Coding',
  working: 'Working',
  chatting: 'Chatting',
  idle: 'Idle',
  waiting: 'Waiting on you',
  off: 'Off shift',
};

/** Text glyphs for the hover card (spec §4), so state never relies on colour alone. */
export const ACTIVITY_GLYPH: Record<Activity, string> = { coding: '</>', working: '✎', chatting: '••', idle: '◆', waiting: '!', off: 'zZ' };

export interface Placed {
  agent: Agent;
  activity: AgentActivity;
  slot: Slot;
  /** The founder has no tag: HQ doesn't know what you're doing. */
  tag: Tag | null;
}

export interface OfficePlan {
  people: Placed[];
  /** Off shift: chips outside the floor, in desk order. */
  offShift: { agent: Agent; activity: AgentActivity }[];
  /** Waiting on you beyond the bench and queue: they wait off the floor, and the door says how many. */
  waitingHidden: Agent[];
  /** Owned desks whose owner is elsewhere (lounge, meeting, bench, off shift): the desk keeps a dimmed nameplate (spec §1). */
  plates: { slot: Slot; agent: Agent }[];
  /** Lounge, meeting and founder spots taken this time, agent id → slot key, so the next call keeps people where they are. */
  sticky: Map<string, string>;
}

const keyOf = (s: Slot) => `${s.zone}:${s.n}`;
const IDLE: AgentActivity = { activity: 'idle', since: '' };

/**
 * Meeting seats in fill order: the middle of the table first (as in the approved preview), then the row by the
 * queue, then the standing huddle spots; side a before side b.
 */
const pairRank = (pair: string | undefined) => (pair === 'meet-01' ? 900 : pair === 'meet-04' ? 990 : Number(pair?.replace(/\D/g, '')) || 500);
const bySeatOrder = (x: Slot, y: Slot) => pairRank(x.pair) - pairRank(y.pair) || Number(x.side === 'b') - Number(y.side === 'b') || x.n - y.n;

/**
 * Place everyone. `sticky` is what the last call returned. Spots are sticky (spec §1.1): whoever still holds a
 * lounge spot, a meeting seat (a pair as the same pair of chairs) or a place on the bench or in the queue keeps it
 * while their state lasts, and only then do newcomers take what is free. Nobody moves because someone else arrived.
 */
export function placePeople(layout: OfficeLayout, agents: Agent[], office: Record<string, AgentActivity>, sticky: Map<string, string> = new Map()): OfficePlan {
  const slots = new Map(layout.slots.map((s) => [keyOf(s), s]));
  const taken = new Set<string>();
  const placed = new Set<string>();
  const people: Placed[] = [];
  const offShift: OfficePlan['offShift'] = [];
  const waitingHidden: Agent[] = [];
  const nextSticky = new Map<string, string>();

  const act = (a: Agent) => office[a.id] ?? IDLE;
  const put = (agent: Agent, slot: Slot, tag: Tag | null) => {
    taken.add(keyOf(slot));
    placed.add(agent.id);
    people.push({ agent, activity: act(agent), slot, tag });
    if (slot.zone !== 'desks' && !slot.occupant) nextSticky.set(agent.id, keyOf(slot));
  };
  const isFree = (s: Slot) => !taken.has(keyOf(s)) && !s.occupant;
  const free = (zone: SlotZone) => layout.slots.filter((s) => s.zone === zone && isFree(s)).sort((a, b) => a.n - b.n);
  /** The spot this desk held last time, if it's in this zone and still free. */
  const remembered = (a: Agent, zone: SlotZone) => {
    const s = slots.get(sticky.get(a.id) ?? '');
    return s && s.zone === zone && isFree(s) ? s : undefined;
  };

  const founder = agents.find((a) => a.isHuman);
  const desks = agents.filter((a) => !a.isHuman).sort((a, b) => (a.deskNo ?? 99) - (b.deskNo ?? 99));
  const doing = (activity: Activity) => desks.filter((a) => act(a).activity === activity);
  const deskSlot = (a: Agent) => (a.deskNo ? slots.get(`desks:${a.deskNo}`) : undefined);
  // At your own desk. A number the floor has no desk for (hand-edited data) takes a lounge spot, still with its own tag.
  const atDesk = (a: Agent, tag: Tag) => {
    const slot = deskSlot(a) ?? free('lounge')[0];
    if (slot) put(a, slot, tag);
  };

  if (founder) {
    const chair = layout.slots.find((s) => s.occupant === 'founder');
    if (chair) put(founder, chair, null);
  }

  // Waiting on you. Newcomers, oldest first, take the bench, the two spots beside it, then the queue; the rest
  // wait off the floor. Placed first so the meeting room knows whose tags not to cover.
  const waiting = doing('waiting').sort((x, y) => (act(x).since || '').localeCompare(act(y).since || ''));
  for (const a of waiting) {
    const kept = remembered(a, 'founder');
    if (kept) put(a, kept, 'wait');
  }
  for (const a of waiting) {
    if (placed.has(a.id)) continue;
    const spot = free('founder')[0];
    if (spot) put(a, spot, 'wait');
    else waitingHidden.push(a);
  }
  const waitingSpots = people.filter((p) => p.tag === 'wait').map((p) => p.slot);
  // A meeting seat whose tag or name would sit on someone waiting on you is used only when nothing else is free.
  const clearOf = (a: Agent, s: Slot) => !pinCovers(s, a.name, waitingSpots);

  // Chats at the table: pairs (two desks that each name the other; the lower id on side a) and huddles.
  const pairs: [Agent, Agent][] = [];
  for (const a of desks) {
    const me = act(a);
    if (me.activity !== 'chatting' || me.huddleId || me.with?.length !== 1 || pairs.some((p) => p.includes(a))) continue;
    const partner = desks.find((d) => d.id === me.with![0]);
    const them = partner && act(partner);
    if (!partner || !them || them.activity !== 'chatting' || them.huddleId || them.with?.length !== 1 || them.with[0] !== a.id) continue;
    pairs.push(a.id < partner.id ? [a, partner] : [partner, a]);
  }
  // Huddle by huddle, so each one's people sit together.
  const huddles = new Map<string, Agent[]>();
  for (const a of desks) {
    const h = act(a).huddleId;
    if (act(a).activity === 'chatting' && h) huddles.set(h, [...(huddles.get(h) ?? []), a]);
  }
  const huddlers = [...huddles.values()].flat();

  // Seats people already hold.
  for (const [x, y] of pairs) {
    const sx = remembered(x, 'meeting');
    const sy = remembered(y, 'meeting');
    if (!sx || !sy || !sx.pair || sx.pair !== sy.pair || sx === sy) continue;
    put(x, sx, 'chat');
    put(y, sy, 'chat');
  }
  for (const a of huddlers) {
    const kept = remembered(a, 'meeting');
    if (kept) put(a, kept, 'chat');
  }
  // Then newcomers. Pairs first, so a huddle doesn't split the pair of chairs a pair needs.
  const freePairs = (): [Slot, Slot][] => {
    const byPair = new Map<string, { a?: Slot; b?: Slot }>();
    for (const s of free('meeting')) {
      if (!s.pair) continue;
      const p = byPair.get(s.pair) ?? {};
      p[s.side === 'b' ? 'b' : 'a'] = s;
      byPair.set(s.pair, p);
    }
    return [...byPair.entries()]
      .sort(([x], [y]) => pairRank(x) - pairRank(y))
      .flatMap(([, p]): [Slot, Slot][] => (p.a && p.b ? [[p.a, p.b]] : []));
  };
  for (const [x, y] of pairs) {
    if (placed.has(x.id)) continue;
    const open = freePairs();
    const seats = open.find(([sa, sb]) => clearOf(x, sa) && clearOf(y, sb)) ?? open[0];
    if (!seats) break;
    put(x, seats[0], 'chat');
    put(y, seats[1], 'chat');
  }
  // A huddle takes the chairs from the middle out, then the standing spots.
  for (const a of huddlers) {
    if (placed.has(a.id)) continue;
    const open = free('meeting').sort(bySeatOrder);
    const seat = open.find((s) => clearOf(a, s)) ?? open[0];
    if (!seat) break;
    put(a, seat, 'chat');
  }

  // Idle desks keep their lounge spots before anyone else is placed.
  const idle = doing('idle');
  for (const a of idle) {
    const kept = remembered(a, 'lounge');
    if (kept) put(a, kept, 'idle');
  }

  for (const a of desks) {
    if (placed.has(a.id)) continue;
    const me = act(a);
    if (me.activity === 'off') offShift.push({ agent: a, activity: me });
    else if (me.activity === 'coding' || me.activity === 'working') atDesk(a, TAG_OF[me.activity]);
    // Talking with you, or no seat left at the table: chat from the desk.
    else if (me.activity === 'chatting') atDesk(a, 'chat');
  }

  // Idle newcomers last, so they never take a seat a chat or the queue needed. A full lounge: stay at your desk, still idle.
  for (const a of idle) {
    if (placed.has(a.id)) continue;
    const spot = free('lounge')[0];
    if (spot) put(a, spot, 'idle');
    else atDesk(a, 'idle');
  }

  // Every owned desk stays labelled while its owner is away from it.
  const plates: OfficePlan['plates'] = [];
  for (const a of desks) {
    const desk = deskSlot(a);
    if (desk && people.find((p) => p.agent.id === a.id)?.slot !== desk) plates.push({ slot: desk, agent: a });
  }

  return { people, offShift, waitingHidden, plates, sticky: nextSticky };
}

/**
 * The order the final pass draws tags and names in. Front to back, so where tags crowd the nearest person's
 * reads in full; and everyone waiting on you last, so nobody else's tag or name ever covers theirs.
 */
export function pinOrder(people: Placed[]): Placed[] {
  const depth = (p: Placed) => Math.floor(p.slot.u) + Math.floor(p.slot.v) + p.slot.u / 100;
  const waiting = (p: Placed) => Number(p.tag === 'wait');
  return [...people].sort((a, b) => waiting(a) - waiting(b) || depth(a) - depth(b));
}

/** "Off shift until 8:00 AM" → "8:00 AM", from the desk's task line. */
export function returnTime(task: string | undefined): string | null {
  const m = task?.match(/\buntil\s+(.+?)\s*$/i);
  return m ? m[1] : null;
}

/** "<1m", "42m", "1h 12m", "3h", "1d 4h" (spec §4). */
export function durationSince(since: string, now = Date.now()): string {
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return h < 3 && m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}
