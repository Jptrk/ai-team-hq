/**
 * Office floor layout: the v3 golden room, growth from 1 to 12 desks (and the spec's 16 and 24), Denzel's route
 * checks (spec §9.1), sprites and footprints, walls and labels; who stands where, people pixels and geometry.
 * Run: npm run test:office (after npm run office:sync has copied the sprites). Pure data, no browser.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { doorsFor, FOOTPRINTS, layoutFor, MAX_DESKS, podCells, type DoorLine } from './office/layout';
import type { Barrier, NavEdge, NavNode, OfficeLayout, Placement, Room, RoomLabel, RoomRect, Slot } from './office/types';
import type { AgentActivity } from '../shared/activity';
import { deskSlotsFor, withDeskNumbers } from '../shared/desks';
import type { Agent } from '../shared/types';
import { spriteProblem } from '../scripts/sprite-check.mjs';
import { depthOf, personDepth, spriteBox } from './office/geometry';
import { COVER_PX, CHIP_GAP, hiddenPixels, labelSpots, OFF_PER_COLUMN, offShiftSpots, pinBoxes } from './office/overlay';
import { mix, PERSON_W, personColours, personRuns } from './office/person';
import { durationSince, pinOrder, placePeople, returnTime } from './office/placement';
import { parseSprite, safeBody } from './office/spriteText';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

interface Zones {
  headcount: number;
  rooms: RoomRect[];
  doors: DoorLine[];
  barriers: Barrier[];
  slots: Slot[];
  nav: { nodes: NavNode[]; edges: NavEdge[] };
}
const zones = JSON.parse(readFileSync(new URL('./office/zones.v3.json', import.meta.url), 'utf8')) as Zones;

const SPRITE_DIR = new URL('./office/sprites/', import.meta.url);
/** Sprite name → its data-tiles ("1x2", or "ui" for tags, the lamp and the chip). */
const SPRITE_TILES = new Map(
  readdirSync(SPRITE_DIR)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => [f.slice(0, -4), readFileSync(new URL(f, SPRITE_DIR), 'utf8').match(/<svg\b[^>]*\sdata-tiles="([^"]*)"/)?.[1] ?? ''] as const),
);

// Order-free comparison: sort by a key-sorted JSON form, then deep-equal.
const canon = (x: unknown): string =>
  JSON.stringify(x, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
const sorted = <T>(xs: readonly T[]): T[] => [...xs].sort((a, b) => (canon(a) < canon(b) ? -1 : canon(a) > canon(b) ? 1 : 0));

const SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ROUTE_SIZES = [...SIZES, 16, 24];
const layouts = new Map(ROUTE_SIZES.map((n) => [n, layoutFor(n)]));
const at = (n: number) => layouts.get(n)!;
const v3 = at(8);

// ---------- geometry helpers ----------
type Pt = { u: number; v: number };
const roomOf = (l: OfficeLayout, p: Pt): Room | null =>
  l.rooms.find((r) => p.u >= r.u0 && p.u < r.u0 + r.w && p.v >= r.v0 && p.v < r.v0 + r.d)?.room ?? null;
const roomRect = (l: OfficeLayout, room: Room) => l.rooms.find((r) => r.room === room)!;
const inside = (p: Pt, b: Barrier) => p.u > b.u0 && p.u < b.u1 && p.v > b.v0 && p.v < b.v1;
const dist = (a: Pt, b: Pt) => Math.hypot(a.u - b.u, a.v - b.v);
const where = (p: Pt) => `(${p.u}, ${p.v})`;

/** Does segment a→b pass through the open rectangle r? Grazing an edge doesn't count (Liang–Barsky). */
function crosses(a: Pt, b: Pt, r: Barrier): boolean {
  let t0 = 0;
  let t1 = 1;
  const du = b.u - a.u;
  const dv = b.v - a.v;
  for (const [p, q] of [
    [-du, a.u - r.u0],
    [du, r.u1 - a.u],
    [-dv, a.v - r.v0],
    [dv, r.v1 - a.v],
  ]) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
  }
  return t1 - t0 > 1e-9;
}
const blockers = (l: OfficeLayout, a: Pt, b: Pt) => l.barriers.filter((r) => crosses(a, b, r)).map((r) => r.name);

/** Does segment a→b cross the doorway line d strictly inside the gap? */
function throughDoor(a: Pt, b: Pt, d: DoorLine): boolean {
  const vertical = d.u0 === d.u1;
  const [from, to, line] = vertical ? [a.u, b.u, d.u0] : [a.v, b.v, d.v0];
  if ((from - line) * (to - line) >= 0) return false;
  const t = (line - from) / (to - from);
  const along = vertical ? a.v + t * (b.v - a.v) : a.u + t * (b.u - a.u);
  return vertical ? along > d.v0 && along < d.v1 : along > d.u0 && along < d.u1;
}

const tilesOf = (p: Placement) => {
  const out: string[] = [];
  for (let u = p.gx; u < p.gx + p.fu; u++) for (let v = p.gy; v < p.gy + p.fv; v++) out.push(`${u},${v}`);
  return out;
};

/** Denzel's checks (spec §9.1, ruling 13). Returns every problem, so a failure lists them all. */
function routeProblems(l: OfficeLayout, doors: DoorLine[]): string[] {
  const out: string[] = [];
  const nodes = new Map(l.nav.nodes.map((n) => [n.id, n]));

  for (const s of l.slots) {
    const id = `slot ${s.zone} ${s.n}`;
    if (roomOf(l, s) !== s.room) out.push(`${id} at ${where(s)} is in ${roomOf(l, s)}, says ${s.room}`);
    // A seated slot sits on its own bench or couch; the walkable point is its approach.
    const hits = l.barriers.filter((b) => inside(s, b) && !(s.approach && b.kind === 'prop'));
    if (hits.length) out.push(`${id} at ${where(s)} is inside ${hits.map((b) => b.name).join(', ')}`);
    if (s.approach) {
      if (!roomOf(l, s.approach)) out.push(`${id} approach ${where(s.approach)} is off the floor`);
      const blocked = l.barriers.filter((b) => inside(s.approach!, b));
      if (blocked.length) out.push(`${id} approach ${where(s.approach)} is inside ${blocked.map((b) => b.name).join(', ')}`);
    }
  }

  for (const n of l.nav.nodes) {
    if (!roomOf(l, n)) out.push(`node ${n.id} ${where(n)} is off the floor`);
    const hits = l.barriers.filter((b) => inside(n, b));
    if (hits.length) out.push(`node ${n.id} is inside ${hits.map((b) => b.name).join(', ')}`);
  }
  if (new Set(l.nav.nodes.map((n) => n.id)).size !== l.nav.nodes.length) out.push('duplicate node ids');

  for (const e of l.nav.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) {
      out.push(`edge ${e.from}→${e.to} names a missing node`);
      continue;
    }
    const hits = blockers(l, a, b);
    if (hits.length) out.push(`edge ${e.from}→${e.to} crosses ${hits.join(', ')}`);
    // Changing rooms is only allowed through that room's doorway, and the edge must say so.
    const ra = roomOf(l, a);
    const rb = roomOf(l, b);
    const room = ra === rb ? null : ra === 'hall' ? rb : rb === 'hall' ? ra : 'two rooms';
    if ((e.door ?? null) !== room) out.push(`edge ${e.from}→${e.to} goes ${ra}→${rb} with door ${e.door ?? 'none'}`);
    if (e.door) {
      const d = doors.find((x) => x.room === e.door);
      if (!d || !throughDoor(a, b, d)) out.push(`edge ${e.from}→${e.to} misses the ${e.door} doorway`);
    }
  }

  // Connected: every node reachable from the first.
  const seen = new Set<string>([l.nav.nodes[0].id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of l.nav.edges) {
      if (seen.has(e.from) !== seen.has(e.to)) {
        seen.add(e.from).add(e.to);
        grew = true;
      }
    }
  }
  for (const n of l.nav.nodes) if (!seen.has(n.id)) out.push(`node ${n.id} is cut off`);

  // Reachable: the nearest node in the slot's room sees the slot (or its approach) in a straight line.
  for (const s of l.slots) {
    const target = s.approach ?? s;
    const room = roomOf(l, target);
    const near = l.nav.nodes.filter((n) => roomOf(l, n) === room).sort((a, b) => dist(a, target) - dist(b, target))[0];
    if (!near) out.push(`slot ${s.zone} ${s.n}: no nav node in ${room}`);
    else {
      const hits = blockers(l, near, target);
      if (hits.length) out.push(`slot ${s.zone} ${s.n}: ${near.id} → ${where(target)} crosses ${hits.join(', ')}`);
    }
  }

  const centres = new Map<string, string>();
  for (const s of l.slots) {
    const key = where(s);
    if (centres.has(key)) out.push(`slot ${s.zone} ${s.n} shares ${key} with ${centres.get(key)}`);
    centres.set(key, `${s.zone} ${s.n}`);
  }

  // Furniture: on the floor, and no two pieces on one tile (the flat rug lies under the pool table by design).
  const taken = new Map<string, string>();
  for (const p of l.furniture) {
    for (const t of tilesOf(p)) {
      const [u, v] = t.split(',').map(Number);
      if (!roomOf(l, { u, v })) out.push(`${p.sprite} at ${p.gx},${p.gy} hangs off the floor at ${t}`);
      if (p.sprite.startsWith('rug-')) continue;
      if (taken.has(t)) out.push(`${p.sprite} at ${p.gx},${p.gy} overlaps ${taken.get(t)} on ${t}`);
      taken.set(t, p.sprite);
    }
  }
  return out;
}

// ---------- screen space (2:1 iso, 64×32 tiles) ----------
type Poly = { x: number; y: number }[];
const screen = (u: number, v: number) => ({ x: (u - v) * 32, y: (u + v) * 16 });
const tileDiamond = (u: number, v: number): Poly => [screen(u, v), screen(u + 1, v), screen(u + 1, v + 1), screen(u, v + 1)];
/** The renderer writes the founder's name in; measure the real label. ~7 px a character at 12 px bold. */
const labelText = (l: RoomLabel) => (l.room === 'founder' ? 'PATRICK’S ROOM' : l.text);
function labelBox(l: RoomLabel): Poly {
  const c = screen(l.u, l.v);
  const w = labelText(l).length * 7;
  const h = 14;
  return [
    { x: c.x - w / 2, y: c.y - h / 2 },
    { x: c.x + w / 2, y: c.y - h / 2 },
    { x: c.x + w / 2, y: c.y + h / 2 },
    { x: c.x - w / 2, y: c.y + h / 2 },
  ];
}
/** Convex polygons overlap unless some edge normal separates them (touching doesn't count). */
function overlap(a: Poly, b: Poly): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q.y - p.y;
      const ny = p.x - q.x;
      const pa = a.map((pt) => pt.x * nx + pt.y * ny);
      const pb = b.map((pt) => pt.x * nx + pt.y * ny);
      if (Math.max(...pa) <= Math.min(...pb) + 1e-9 || Math.max(...pb) <= Math.min(...pa) + 1e-9) return false;
    }
  }
  return true;
}

// ---------- the extracted v3 file ----------
test('zones.v3.json: the counts office-room.svg v3 states', () => {
  assert.equal(zones.headcount, 8);
  assert.equal(zones.rooms.length, 7);
  assert.equal(zones.doors.length, 5);
  assert.equal(zones.slots.length, 28);
  const per = (zone: string) => zones.slots.filter((s) => s.zone === zone).length;
  assert.deepEqual([per('desks'), per('meeting'), per('founder'), per('lounge')], [8, 8, 6, 6]);
  assert.equal(zones.nav.nodes.length, 19);
  assert.equal(zones.nav.edges.length, 18);
  assert.equal(zones.barriers.filter((b) => b.kind === 'prop').length, 12);
  assert.equal(zones.barriers.filter((b) => b.kind === 'full').length, 5);
  assert.equal(zones.barriers.filter((b) => b.kind === 'low').length, 11);
});

// ---------- golden: 8 desks is v3 ----------
test('golden: layoutFor(8) rooms are v3', () => assert.deepEqual(sorted(v3.rooms), sorted(zones.rooms)));
test('golden: layoutFor(8) slots are v3 (numbers, facing, pairs, approach, queue, occupant, prop)', () =>
  assert.deepEqual(sorted(v3.slots), sorted(zones.slots)));
test('golden: layoutFor(8) barriers are v3 (walls and furniture)', () => assert.deepEqual(sorted(v3.barriers), sorted(zones.barriers)));
test('golden: layoutFor(8) nav graph is v3', () => {
  assert.deepEqual(sorted(v3.nav.nodes), sorted(zones.nav.nodes));
  assert.deepEqual(sorted(v3.nav.edges), sorted(zones.nav.edges));
});
test('golden: doorsFor(8) are the v3 doorways, and the founder door point is u 7.5, v 3', () => {
  assert.deepEqual(sorted(doorsFor(8)), sorted(zones.doors));
  assert.deepEqual(v3.door, { u: 7.5, v: 3 });
});

// ---------- growth (§9.2) ----------
test('pod cells follow the fixed squaring sequence', () => {
  const seq = podCells(9).map((c) => `${c.col},${c.row}`);
  assert.deepEqual(seq, ['0,0', '0,1', '1,0', '1,1', '0,2', '1,2', '0,3', '1,3', '2,0']);
});
test('desk slots come in whole pods: 4 per pod, ceil(desks / 4) pods', () => {
  for (const n of ROUTE_SIZES) {
    const desks = at(n).slots.filter((s) => s.zone === 'desks');
    assert.equal(desks.length, Math.ceil(n / 4) * 4, `${n} desks`);
    assert.equal(at(n).furniture.filter((p) => p.sprite === 'desk').length, desks.length);
    assert.equal(at(n).desks, n);
  }
});
test('the floor depends only on the pod count: 5–8 are v3, 1–4 alike, 9–12 alike', () => {
  const geometry = (l: OfficeLayout) => canon({ ...l, desks: 0 });
  for (const n of [5, 6, 7]) assert.equal(geometry(at(n)), geometry(v3), `${n} desks`);
  for (const n of [2, 3, 4]) assert.equal(geometry(at(n)), geometry(at(1)), `${n} desks`);
  for (const n of [10, 11, 12]) assert.equal(geometry(at(n)), geometry(at(9)), `${n} desks`);
  assert.notEqual(geometry(at(1)), geometry(v3));
  assert.notEqual(geometry(at(9)), geometry(v3));
});
test('desks never move: desk k is on the same tile at every size that has it', () => {
  const home = new Map<number, string>();
  for (const n of ROUTE_SIZES) {
    for (const s of at(n).slots.filter((x) => x.zone === 'desks')) {
      const key = where(s);
      assert.equal(home.get(s.n) ?? key, key, `desk ${s.n} at ${n} desks`);
      home.set(s.n, key);
    }
  }
  // Pod 3 is the cell right of pod 1 (sequence (1,0)), so desk 9 is first in its desk row.
  assert.equal(home.get(9), '(5.5, 1.5)');
});
test('slot numbers are frozen and contiguous; bigger rooms only append', () => {
  for (const n of ROUTE_SIZES) {
    const l = at(n);
    for (const zone of ['desks', 'meeting', 'founder', 'lounge'] as const) {
      const ns = l.slots.filter((s) => s.zone === zone).map((s) => s.n);
      assert.deepEqual(ns, ns.map((_, i) => i + 1), `${zone} at ${n}`);
    }
    // Meeting 1–8, founder 1–6 and lounge 1–6 keep their meaning (relative to their room) at every size.
    // Each slot measured from its own room; hall slots (bench and queue) from the spine, the first hall rect.
    const base = (zone: string, max: number, from: OfficeLayout) =>
      from.slots
        .filter((s) => s.zone === zone && s.n <= max)
        .map((s) => {
          const r = roomRect(from, s.room);
          return { ...s, u: s.u - r.u0, v: s.v - r.v0, approach: s.approach && { u: s.approach.u - r.u0, v: s.approach.v - r.v0 } };
        });
    assert.deepEqual(base('meeting', 8, l), base('meeting', 8, v3), `meeting at ${n}`);
    assert.deepEqual(base('founder', 6, l), base('founder', 6, v3), `founder at ${n}`);
    assert.deepEqual(base('lounge', 6, l), base('lounge', 6, v3), `lounge at ${n}`);
  }
});
test('the right band moves right one pod column at 9–12 desks; the office widens to 10', () => {
  const l = at(12);
  assert.deepEqual(roomRect(l, 'office'), { room: 'office', u0: 0, v0: 0, w: 10, d: 6 });
  assert.deepEqual(roomRect(l, 'play'), { room: 'play', u0: 0, v0: 6, w: 10, d: 4 });
  assert.deepEqual(roomRect(l, 'founder'), { room: 'founder', u0: 11, v0: 0, w: 4, d: 3 });
  assert.deepEqual(l.door, { u: 12.5, v: 3 });
  assert.equal(l.cols, 15);
  assert.equal(l.rows, 11);
});
test('one pod: a 5×3 office with the play area right under it', () => {
  const l = at(3);
  assert.deepEqual(roomRect(l, 'office'), { room: 'office', u0: 0, v0: 0, w: 5, d: 3 });
  assert.deepEqual(roomRect(l, 'play'), { room: 'play', u0: 0, v0: 3, w: 5, d: 4 });
  assert.deepEqual(roomRect(l, 'founder'), roomRect(v3, 'founder'));
  assert.deepEqual([l.cols, l.rows], [10, 11]);
});
test('meeting: one long table, L = 2·ceil(N/6) − 1, at least the 3 that exists; chairs down both sides', () => {
  const table = (l: OfficeLayout) => l.furniture.find((p) => p.sprite.startsWith('meeting-table-long-'))!;
  for (const n of SIZES) assert.equal(table(at(n)).sprite, 'meeting-table-long-3', `${n} desks`);
  assert.equal(table(at(16)).sprite, 'meeting-table-long-5');
  assert.equal(table(at(24)).sprite, 'meeting-table-long-7');
  for (const n of ROUTE_SIZES) {
    const l = at(n);
    const L = table(l).fv;
    assert.equal(roomRect(l, 'meeting').d, L + 1, 'one walkway row in front of the table');
    assert.equal(l.furniture.filter((p) => p.sprite === 'meeting-chair-w').length, L);
    assert.equal(l.furniture.filter((p) => p.sprite === 'meeting-chair-e').length, L);
    assert.equal(l.slots.filter((s) => s.zone === 'meeting').length, 2 * L + 2);
  }
  // A longer table appends after the huddle: rows 4 and 5 are slots 9–12, pairs meet-05 and meet-06.
  const extra = at(16).slots.filter((s) => s.zone === 'meeting' && s.n > 8);
  assert.deepEqual(
    extra.map((s) => `${s.n} ${s.pair} ${s.side} ${s.facing}`),
    ['9 meet-05 a E', '10 meet-05 b W', '11 meet-06 a E', '12 meet-06 b W'],
  );
});
test('play: one module per 12; at 16 the second sits under pod column 2 as in the Figma 16-person preview', () => {
  const l = at(16);
  const spot = (sprite: string) => l.furniture.filter((p) => p.sprite === sprite).map((p) => `${p.gx},${p.gy}`);
  assert.deepEqual(spot('arcade'), ['0,6', '5,6']);
  assert.deepEqual(spot('rug-lounge'), ['1,7', '6,7']);
  assert.deepEqual(spot('couch'), ['1,6', '6,6']);
  assert.equal(l.slots.filter((s) => s.zone === 'lounge').length, 11);
  assert.equal(at(12).furniture.filter((p) => p.sprite === 'pool-table').length, 1);
});
test('desks outside 1..24 clamp', () => {
  assert.equal(canon(layoutFor(0)), canon(at(1)));
  assert.equal(canon(layoutFor(Number.NaN)), canon(at(1)));
  assert.equal(canon({ ...layoutFor(100), desks: 0 }), canon({ ...at(24), desks: 0 }));
  assert.equal(layoutFor(100).desks, MAX_DESKS);
});

// ---------- route checks (spec §9.1) ----------
test('route check: slots, nodes, edges, doorways, connectivity, reachability, furniture (1–12, 16, 24 desks)', () => {
  for (const n of ROUTE_SIZES) {
    const problems = routeProblems(at(n), doorsFor(n));
    assert.deepEqual(problems, [], `${n} desks:\n  ${problems.join('\n  ')}`);
  }
});
test('route check catches a blocked edge and a seat inside furniture', () => {
  const broken: OfficeLayout = structuredClone(v3);
  broken.barriers.push({ kind: 'prop', u0: 1, v0: 2, u1: 2, v1: 3, name: 'crate' });
  broken.slots.find((s) => s.zone === 'lounge' && s.n === 1)!.u = 2.5;
  const problems = routeProblems(broken, doorsFor(8));
  assert.ok(problems.some((p) => p.includes('oA→oB crosses crate')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('slot lounge 1') && p.includes('billiards')), problems.join('\n'));
});

// ---------- sprites ----------
test('FOOTPRINTS match every grid sprite’s data-tiles, and UI sprites have none', () => {
  assert.ok(SPRITE_TILES.size >= 45, 'run npm run office:sync first');
  for (const [name, tiles] of SPRITE_TILES) {
    const m = tiles.match(/^(\d+)x(\d+)$/);
    if (!m) {
      assert.equal(tiles, 'ui', name);
      assert.equal(FOOTPRINTS[name], undefined, name);
      continue;
    }
    assert.deepEqual(FOOTPRINTS[name], { fu: Number(m[1]), fv: Number(m[2]) }, name);
  }
  for (const name of Object.keys(FOOTPRINTS)) assert.ok(SPRITE_TILES.has(name), `${name}.svg is missing`);
});
test('every placement uses a sprite that exists, with its footprint', () => {
  for (const n of ROUTE_SIZES) {
    const l = at(n);
    for (const p of [...l.floor, ...l.walls, ...l.furniture]) {
      assert.ok(SPRITE_TILES.has(p.sprite), `${p.sprite}.svg is missing`);
      assert.deepEqual({ fu: p.fu, fv: p.fv }, FOOTPRINTS[p.sprite], p.sprite);
    }
  }
  assert.ok(readFileSync(new URL('palette.json', SPRITE_DIR), 'utf8').includes('"ramps"'));
});

// ---------- floor ----------
test('floor at 8: 10×11 tiles, everything but u0–4 v10 and u9 v8–10', () => {
  assert.deepEqual([v3.cols, v3.rows], [10, 11]);
  const tiles = new Set(v3.floor.map((p) => `${p.gx},${p.gy}`));
  assert.equal(tiles.size, v3.floor.length, 'one tile per square');
  const empty = new Set(['0,10', '1,10', '2,10', '3,10', '4,10', '9,8', '9,9', '9,10']);
  for (let u = 0; u < 10; u++) for (let v = 0; v < 11; v++) assert.equal(tiles.has(`${u},${v}`), !empty.has(`${u},${v}`), `${u},${v}`);
  assert.equal(v3.floor.length, 102);
});
test('floor at 16 is 15×13 (ruling 13)', () => {
  assert.deepEqual([at(16).cols, at(16).rows], [15, 13]);
  for (const n of ROUTE_SIZES) {
    const l = at(n);
    assert.equal(Math.max(...l.floor.map((p) => p.gx)) + 1, l.cols, `cols at ${n}`);
    assert.equal(Math.max(...l.floor.map((p) => p.gy)) + 1, l.rows, `rows at ${n}`);
  }
});
test('floor tiles: a/b checkerboard by (gx + gy), tone per room, hall in office tone', () => {
  const tone = new Map(v3.floor.map((p) => [`${p.gx},${p.gy}`, p.sprite]));
  assert.equal(tone.get('0,0'), 'floor-office-a');
  assert.equal(tone.get('1,0'), 'floor-office-b');
  assert.equal(tone.get('5,0'), 'floor-office-b');
  assert.equal(tone.get('7,1'), 'floor-founder-a');
  assert.equal(tone.get('0,8'), 'floor-lounge-a');
  assert.equal(tone.get('6,4'), 'floor-meeting-a');
  assert.equal(tone.get('6,8'), 'floor-kitchen-a');
  const ZONE: Record<Room, string> = { office: 'office', hall: 'office', founder: 'founder', play: 'lounge', meeting: 'meeting', kitchen: 'kitchen' };
  for (const n of ROUTE_SIZES) {
    for (const p of at(n).floor) {
      const room = roomOf(at(n), { u: p.gx, v: p.gy })!;
      assert.equal(p.sprite, `floor-${ZONE[room]}-${(p.gx + p.gy) % 2 ? 'b' : 'a'}`, `${p.gx},${p.gy} at ${n}`);
    }
  }
});

// ---------- walls ----------
test('walls at 8: the founder’s room has full walls on all sides, window right of the back wall, door on row 2', () => {
  const full = v3.walls.filter((p) => p.sprite.startsWith('wall-')).map((p) => `${p.sprite}@${p.gx},${p.gy}`).sort();
  assert.deepEqual(
    full,
    [
      'wall-u0@6,0', 'wall-u0@6,1', 'wall-u0@6,2',
      'wall-u1@9,0', 'wall-u1@9,1', 'wall-u1@9,2',
      'wall-v0-window@9,0', 'wall-v0@6,0', 'wall-v0@7,0', 'wall-v0@8,0',
      'wall-v1-door@7,2', 'wall-v1@6,2', 'wall-v1@8,2', 'wall-v1@9,2',
    ].sort(),
  );
  // Ruling 12: row 2 inside his room stays empty, so the front wall hides nothing.
  for (const p of v3.furniture) for (const t of tilesOf(p)) assert.ok(!['6,2', '7,2', '8,2', '9,2'].includes(t), `${p.sprite} on ${t}`);
  assert.deepEqual(v3.furniture.find((p) => p.sprite === 'bookshelf'), { sprite: 'bookshelf', gx: 6, gy: 1, fu: 1, fv: 1 });
});
test('walls at 8: knee walls on the tile in front of each edge, posts on both ends of each doorway', () => {
  const low = v3.walls.filter((p) => /^low-wall-[uv]/.test(p.sprite));
  assert.equal(low.length, 25);
  assert.ok(low.every((p) => p.sprite === 'low-wall-u0' || p.sprite === 'low-wall-v0'));
  const posts = v3.walls.filter((p) => p.sprite === 'low-wall-post').map((p) => `${p.gx + 0.5},${p.gy + 0.5}`).sort();
  // The post's art sits in the middle of its footprint, so the footprint is offset half a tile onto the gap end.
  assert.deepEqual(posts, ['5,2', '5,3', '5,7', '5,8', '6,10', '6,5', '6,6', '6,9'].sort());
  assert.equal(v3.walls.length, 14 + 25 + 8);
});
test('walls at every size: knee walls only between two rooms, full walls only on the founder’s room', () => {
  for (const n of ROUTE_SIZES) {
    const l = at(n);
    for (const p of l.walls) {
      if (p.sprite === 'low-wall-post') continue;
      const edge = p.sprite.match(/(u0|u1|v0|v1)/)![1];
      const here = roomOf(l, { u: p.gx, v: p.gy });
      const du = edge === 'u0' ? -1 : edge === 'u1' ? 1 : 0;
      const dv = edge === 'v0' ? -1 : edge === 'v1' ? 1 : 0;
      const there = roomOf(l, { u: p.gx + du, v: p.gy + dv });
      const label = `${p.sprite}@${p.gx},${p.gy} at ${n}`;
      assert.ok(here, `${label} is off the floor`);
      if (p.sprite.startsWith('low-')) {
        assert.ok(there && there !== here, `${label} isn't between two rooms`);
        assert.ok(edge === 'u0' || edge === 'v0', `${label} isn't on the front tile`);
      } else assert.equal(here, 'founder', label);
    }
  }
});

// ---------- labels, off shift ----------
// Figma 109:2 text boxes (left, top, w, h) in frame px; tile (u, v) is at (470 + (u − v)·32, 150 + (u + v)·16).
const FIGMA_TEXT: Record<string, [number, number, number, number]> = {
  office: [352, 151, 44, 15],
  play: [132, 271, 68, 15],
  founder: [756, 327, 102, 15],
  meeting: [628, 391, 96, 15],
  kitchen: [500, 423, 54, 15],
};
test('labels at 8 land on the Figma text centres (kitchen a row lower for v3’s meeting walkway)', () => {
  assert.equal(v3.labels.length, 5);
  for (const l of v3.labels) {
    const [x, y, w, h] = FIGMA_TEXT[l.room];
    const d = (x + w / 2 - 470) / 32;
    const s = (y + h / 2 - 150) / 16;
    const target = { u: (s + d) / 2, v: (s - d) / 2 + (l.room === 'kitchen' ? 1 : 0) };
    assert.ok(dist(l, target) < 0.05, `${l.text} at ${where(l)}, Figma ${where(target)}`);
  }
  assert.deepEqual(
    v3.labels.map((l) => l.text),
    ['OFFICE', 'PLAY AREA', 'FOUNDER', 'MEETING ROOM', 'KITCHEN'],
  );
});
test('labels sit outside the floor and clear of each other at every size', () => {
  for (const n of ROUTE_SIZES) {
    const l = at(n);
    const boxes = l.labels.map(labelBox);
    l.labels.forEach((label, i) => {
      for (const t of l.floor) assert.ok(!overlap(boxes[i], tileDiamond(t.gx, t.gy)), `${labelText(label)} covers ${t.gx},${t.gy} at ${n}`);
      for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i], boxes[j]), `${labelText(label)} hits ${l.labels[j].text} at ${n}`);
    });
  }
});
test('off-shift strip: Figma’s chip spot (u 2, v 11.6) at 8, and always in front of the play area', () => {
  assert.equal(v3.offShift.u, 2);
  assert.ok(Math.abs(v3.offShift.v - 11.6) < 1e-9);
  for (const n of ROUTE_SIZES) {
    const play = roomRect(at(n), 'play');
    assert.ok(Math.abs(at(n).offShift.v - (play.v0 + play.d + 1.6)) < 1e-9, `${n} desks`);
  }
});

// ---------- who stands where (placement.ts) ----------

const person = (id: string, deskNo: number | undefined, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  role: 'Desk',
  desk: 'Desk',
  status: 'idle',
  color: '#3b6ea5',
  seat: { col: 0, row: 0 },
  lastActive: '',
  skills: [],
  deskNo,
  ...extra,
});
const boss = person('patrick', undefined, { isHuman: true });
const team8 = ['dylan', 'paige', 'mike', 'riley', 'maria', 'denzel', 'shakira', 'rodrigo'].map((id, i) => person(id, i + 1));
const doing = (activity: AgentActivity['activity'], extra: Partial<AgentActivity> = {}): AgentActivity => ({ activity, since: '2026-10-02T08:00:00.000Z', ...extra });
const spot = (plan: ReturnType<typeof placePeople>, id: string) => {
  const p = plan.people.find((x) => x.agent.id === id);
  return p ? `${p.slot.zone}:${p.slot.n}/${p.tag ?? '-'}` : undefined;
};

test('placement: the approved preview — desks, a chat pair in the middle of the table, the bench, the lounge, off shift', () => {
  const office = {
    dylan: doing('chatting', { with: ['maria'] }),
    maria: doing('chatting', { with: ['dylan'] }),
    paige: doing('working'),
    denzel: doing('coding'),
    shakira: doing('working'),
    mike: doing('waiting'),
    riley: doing('idle'),
    rodrigo: doing('off'),
  };
  const plan = placePeople(v3, [boss, ...team8], office);
  assert.equal(spot(plan, 'patrick'), 'founder:6/-', 'the founder sits in his room, no tag');
  assert.equal(spot(plan, 'paige'), 'desks:2/work');
  assert.equal(spot(plan, 'denzel'), 'desks:6/code');
  assert.equal(spot(plan, 'shakira'), 'desks:7/work');
  // Pairs fill from the middle (meet-02), the lower id on side a.
  assert.equal(spot(plan, 'dylan'), 'meeting:3/chat');
  assert.equal(spot(plan, 'maria'), 'meeting:4/chat');
  assert.equal(spot(plan, 'mike'), 'founder:1/wait', 'first in line takes the bench');
  assert.equal(spot(plan, 'riley'), 'lounge:1/idle');
  assert.equal(spot(plan, 'rodrigo'), undefined, 'off shift is not on the floor');
  assert.deepEqual(plan.offShift.map((o) => o.agent.id), ['rodrigo']);
  // Every owned desk whose owner is elsewhere keeps a nameplate: the pair, the bench, the lounge, off shift.
  assert.deepEqual(plan.plates.map((p) => `${p.slot.n} ${p.agent.id}`), ['1 dylan', '3 mike', '4 riley', '5 maria', '8 rodrigo']);
  // Nobody shares a spot.
  const keys = plan.people.map((p) => `${p.slot.zone}:${p.slot.n}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('placement: waiting fills the bench, the two spots, then the queue, oldest first; the rest wait off the floor', () => {
  const ids = ['dylan', 'paige', 'mike', 'riley', 'maria', 'denzel'];
  const office = Object.fromEntries(ids.map((id, i) => [id, { activity: 'waiting' as const, since: `2026-10-02T0${8 - (i % 3)}:0${i}:00.000Z` }]));
  const plan = placePeople(v3, [boss, ...team8], office);
  const order = [...ids].sort((a, b) => office[a].since.localeCompare(office[b].since));
  assert.deepEqual(order.slice(0, 5).map((id) => spot(plan, id)), ['founder:1/wait', 'founder:2/wait', 'founder:3/wait', 'founder:4/wait', 'founder:5/wait']);
  assert.deepEqual(plan.waitingHidden.map((a) => a.id), [order[5]]);
});

test('placement: a huddle takes the chairs from the middle out, then the standing spots; chats with you stay at the desk', () => {
  const office: Record<string, AgentActivity> = {};
  for (const id of ['dylan', 'paige', 'mike', 'riley', 'maria', 'denzel', 'shakira']) office[id] = doing('chatting', { huddleId: 'h1', with: [] });
  office.rodrigo = doing('chatting', { with: [] });
  const plan = placePeople(v3, [boss, ...team8], office);
  const seats = ['dylan', 'paige', 'mike', 'riley', 'maria', 'denzel', 'shakira'].map((id) => spot(plan, id));
  // Like pairs: the middle row, the next, then the row by the queue, then the standing spot by the door.
  assert.deepEqual(seats, ['meeting:3/chat', 'meeting:4/chat', 'meeting:5/chat', 'meeting:6/chat', 'meeting:1/chat', 'meeting:2/chat', 'meeting:7/chat']);
  assert.equal(spot(plan, 'rodrigo'), 'desks:8/chat');
});

test('placement: a half pair (the partner is busy) chats from its desk; a pair only forms when both say so', () => {
  const plan = placePeople(v3, [boss, ...team8], { dylan: doing('chatting', { with: ['maria'] }), maria: doing('working') });
  assert.equal(spot(plan, 'dylan'), 'desks:1/chat');
  assert.equal(spot(plan, 'maria'), 'desks:5/work');
});

test('placement: idle keeps its lounge spot between polls; a full lounge sends the rest back to their desks', () => {
  const busy = Object.fromEntries(team8.map((a) => [a.id, doing('working')]));
  const first = placePeople(v3, [boss, ...team8], { ...busy, mike: doing('idle') });
  assert.equal(spot(first, 'mike'), 'lounge:1/idle');
  // Riley goes idle too: Mike keeps lounge 1, Riley takes the next free one.
  const second = placePeople(v3, [boss, ...team8], { ...busy, mike: doing('idle'), riley: doing('idle') }, first.sticky);
  assert.equal(spot(second, 'mike'), 'lounge:1/idle');
  assert.equal(spot(second, 'riley'), 'lounge:2/idle');
  // Eight idle, six lounge spots: the last two by desk order stay home.
  const all = placePeople(v3, [boss, ...team8], {});
  assert.equal(all.people.filter((p) => p.slot.zone === 'lounge').length, 6);
  assert.equal(spot(all, 'shakira'), 'desks:7/idle');
  assert.equal(spot(all, 'rodrigo'), 'desks:8/idle');
});

test('placement: 11 desks use the third pod; a desk without a number gets the next free one, with its own tag', () => {
  const eleven = [...team8, person('ana', 9), person('ben', 10), person('cy', 11)];
  // What the Office does: number every desk first, then size the floor and place people.
  const team = withDeskNumbers([boss, ...eleven, person('nodesk', undefined)], MAX_DESKS);
  const layout = layoutFor(deskSlotsFor(team));
  assert.equal(layout.slots.filter((s) => s.zone === 'desks').length, 12);
  const plan = placePeople(layout, team, { ana: doing('working'), cy: doing('coding'), nodesk: doing('working') });
  assert.equal(spot(plan, 'ana'), 'desks:9/work');
  assert.equal(spot(plan, 'cy'), 'desks:11/code');
  assert.equal(spot(plan, 'nodesk'), 'desks:12/work');
});

test('placement: a team with no desk numbers at all (an old save) still puts everyone at their own desk, tagged as they are', () => {
  const ids = ['dylan', 'paige', 'mike', 'riley', 'maria', 'denzel', 'shakira', 'rodrigo'];
  const raw = [boss, ...ids.map((id) => person(id, undefined))];
  const team = withDeskNumbers(raw, MAX_DESKS);
  assert.equal(deskSlotsFor(team), 8, 'the floor is built for all eight');
  const office: Record<string, AgentActivity> = Object.fromEntries(ids.map((id) => [id, doing('working')]));
  office.dylan = doing('coding');
  office.mike = doing('chatting', { with: [] });
  const plan = placePeople(layoutFor(deskSlotsFor(team)), team, office);
  assert.deepEqual(
    ids.map((id) => spot(plan, id)),
    ['desks:1/code', 'desks:2/work', 'desks:3/chat', 'desks:4/work', 'desks:5/work', 'desks:6/work', 'desks:7/work', 'desks:8/work'],
  );
  assert.equal(plan.people.length, 9, 'nobody dropped');
});

test('placement: sticky lounge — a lower-numbered desk going idle never takes a spot someone already holds', () => {
  const busy = Object.fromEntries(team8.map((a) => [a.id, doing('working')]));
  const first = placePeople(v3, [boss, ...team8], { ...busy, riley: doing('idle') });
  assert.equal(spot(first, 'riley'), 'lounge:1/idle');
  const second = placePeople(v3, [boss, ...team8], { ...busy, riley: doing('idle'), dylan: doing('idle') }, first.sticky);
  assert.equal(spot(second, 'riley'), 'lounge:1/idle', 'Riley stays put');
  assert.equal(spot(second, 'dylan'), 'lounge:2/idle', 'Dylan takes the lowest free spot');
  // The same state again places everyone exactly the same (spec §1.1).
  const third = placePeople(v3, [boss, ...team8], { ...busy, riley: doing('idle'), dylan: doing('idle') }, second.sticky);
  for (const a of [boss, ...team8]) assert.equal(spot(third, a.id), spot(second, a.id), a.id);
  // Riley gets back to work, then idles again later: a new idle spell takes the lowest free spot.
  const working = placePeople(v3, [boss, ...team8], { ...busy, dylan: doing('idle') }, third.sticky);
  assert.equal(spot(working, 'dylan'), 'lounge:2/idle');
  const again = placePeople(v3, [boss, ...team8], { ...busy, dylan: doing('idle'), riley: doing('idle') }, working.sticky);
  assert.equal(spot(again, 'riley'), 'lounge:1/idle');
});

test('placement: sticky pairs — a pair keeps its chairs when another pair starts talking', () => {
  const busy = Object.fromEntries(team8.map((a) => [a.id, doing('working')]));
  const pairA = { mike: doing('chatting', { with: ['riley'] }), riley: doing('chatting', { with: ['mike'] }) };
  const first = placePeople(v3, [boss, ...team8], { ...busy, ...pairA });
  assert.deepEqual([spot(first, 'mike'), spot(first, 'riley')], ['meeting:3/chat', 'meeting:4/chat']);
  const pairB = { dylan: doing('chatting', { with: ['paige'] }), paige: doing('chatting', { with: ['dylan'] }) };
  const second = placePeople(v3, [boss, ...team8], { ...busy, ...pairA, ...pairB }, first.sticky);
  assert.deepEqual([spot(second, 'mike'), spot(second, 'riley')], ['meeting:3/chat', 'meeting:4/chat'], 'the first pair stays');
  assert.deepEqual([spot(second, 'dylan'), spot(second, 'paige')], ['meeting:5/chat', 'meeting:6/chat'], 'the new pair takes the next free pair of chairs');
  // Mike now talks to someone else: that's a new pair, and it doesn't hold on to the old chairs as a pair.
  const third = placePeople(v3, [boss, ...team8], { ...busy, ...pairB, mike: doing('chatting', { with: ['shakira'] }), shakira: doing('chatting', { with: ['mike'] }) }, second.sticky);
  assert.deepEqual([spot(third, 'dylan'), spot(third, 'paige')], ['meeting:5/chat', 'meeting:6/chat']);
  assert.deepEqual([spot(third, 'mike'), spot(third, 'shakira')], ['meeting:3/chat', 'meeting:4/chat']);
});

test('placement: sticky bench — someone waiting keeps their spot when an older wait arrives', () => {
  const busy = Object.fromEntries(team8.map((a) => [a.id, doing('working')]));
  const first = placePeople(v3, [boss, ...team8], { ...busy, mike: doing('waiting', { since: '2026-10-02T09:00:00.000Z' }) });
  assert.equal(spot(first, 'mike'), 'founder:1/wait');
  const second = placePeople(v3, [boss, ...team8], { ...busy, mike: doing('waiting', { since: '2026-10-02T09:00:00.000Z' }), denzel: doing('waiting', { since: '2026-10-02T07:00:00.000Z' }) }, first.sticky);
  assert.equal(spot(second, 'mike'), 'founder:1/wait', 'Mike stays on the bench');
  assert.equal(spot(second, 'denzel'), 'founder:2/wait');
  // Mike's question is answered: nobody shuffles up, and the next newcomer takes the bench.
  const third = placePeople(v3, [boss, ...team8], { ...busy, denzel: doing('waiting', { since: '2026-10-02T07:00:00.000Z' }), paige: doing('waiting') }, second.sticky);
  assert.equal(spot(third, 'denzel'), 'founder:2/wait');
  assert.equal(spot(third, 'paige'), 'founder:1/wait');
});

test('placement: pins never cover someone waiting on you (8 and 11 desks, a full queue, a huddle and a pair)', () => {
  const eleven = [...team8, person('ana', 9), person('ben', 10), person('cy', 11)];
  const queue = (ids: string[]) => Object.fromEntries(ids.map((id, i) => [id, doing('waiting', { since: `2026-10-02T0${i + 1}:00:00.000Z` })]));
  const cases: { team: Agent[]; office: Record<string, AgentActivity> }[] = [
    // 8 desks: five waiting fill the bench and queue; a pair and the rest at work.
    { team: team8, office: { ...queue(['dylan', 'paige', 'mike', 'riley', 'maria']), denzel: doing('chatting', { with: ['shakira'] }), shakira: doing('chatting', { with: ['denzel'] }), rodrigo: doing('working') } },
    // 8 desks: five waiting and a huddle of three.
    { team: team8, office: { ...queue(['dylan', 'paige', 'mike', 'riley', 'maria']), ...Object.fromEntries(['denzel', 'shakira', 'rodrigo'].map((id) => [id, doing('chatting', { huddleId: 'h1', with: [] })])) } },
    // 11 desks: five waiting, a huddle of two and a pair.
    {
      team: eleven,
      office: {
        ...queue(['dylan', 'paige', 'mike', 'riley', 'maria']),
        denzel: doing('chatting', { huddleId: 'h1', with: ['shakira'] }),
        shakira: doing('chatting', { huddleId: 'h1', with: ['denzel'] }),
        rodrigo: doing('chatting', { with: ['ana'] }),
        ana: doing('chatting', { with: ['rodrigo'] }),
        ben: doing('coding'),
        cy: doing('idle'),
      },
    },
  ];
  for (const [n, c] of cases.entries()) {
    const plan = placePeople(layoutFor(deskSlotsFor(c.team)), [boss, ...c.team], c.office);
    const waiting = plan.people.filter((p) => p.tag === 'wait');
    assert.equal(waiting.length, 5, `case ${n}: a full bench and queue`);
    assert.equal(plan.people.filter((p) => p.slot.zone === 'meeting').length, Object.values(c.office).filter((a) => a.activity === 'chatting').length, `case ${n}: every chat has a seat`);
    for (const p of plan.people) {
      if (p.tag === 'wait') continue;
      const { tag, pill } = pinBoxes(p.slot, p.agent.name, p.tag !== null);
      for (const w of waiting) {
        const hidden = hiddenPixels([tag, pill], w.slot);
        assert.ok(hidden <= COVER_PX, `case ${n}: ${p.agent.id} at ${p.slot.zone}:${p.slot.n} covers ${hidden}px of ${w.agent.id} at ${w.slot.zone}:${w.slot.n}`);
      }
    }
    // And the people waiting draw their tags and names last, so nothing at all covers those.
    const order = pinOrder(plan.people);
    assert.deepEqual(order.slice(-5).map((p) => p.tag), ['wait', 'wait', 'wait', 'wait', 'wait'], `case ${n}`);
  }
  // With nobody waiting, a pair still takes the middle of the table as in the approved preview.
  const calm = placePeople(v3, [boss, ...team8], { dylan: doing('chatting', { with: ['maria'] }), maria: doing('chatting', { with: ['dylan'] }) });
  assert.deepEqual([spot(calm, 'dylan'), spot(calm, 'maria')], ['meeting:3/chat', 'meeting:4/chat']);
  // Only when nothing else is free does a chair over the bench get used.
  const packed = placePeople(v3, [boss, ...team8], { ...queue(['dylan', 'paige', 'mike', 'riley', 'maria']), ...Object.fromEntries(['denzel', 'shakira', 'rodrigo'].map((id) => [id, doing('chatting', { huddleId: 'h1', with: [] })])) });
  assert.ok(packed.people.filter((p) => p.slot.zone === 'meeting').every((p) => !['meeting:1', 'meeting:2'].includes(`${p.slot.zone}:${p.slot.n}`)));
});

test('placement: nameplates on every owned desk whose owner is away, and none on a desk in use', () => {
  const office = { dylan: doing('idle'), paige: doing('waiting'), mike: doing('chatting', { huddleId: 'h1', with: [] }), riley: doing('off'), maria: doing('working') };
  const plan = placePeople(v3, [boss, ...team8], office);
  const plated = plan.plates.map((p) => p.agent.id);
  for (const id of ['dylan', 'paige', 'mike', 'riley']) assert.ok(plated.includes(id), id);
  assert.ok(!plated.includes('maria'), 'at her desk');
  for (const p of plan.plates) assert.deepEqual([p.slot.zone, p.slot.n], ['desks', p.agent.deskNo]);
  // A full lounge sends the rest home: they're at their desks, so no plate.
  const allIdle = placePeople(v3, [boss, ...team8], {});
  assert.ok(!allIdle.plates.some((p) => p.agent.id === 'shakira' || p.agent.id === 'rodrigo'));
});

test('pins: front to back, and everyone waiting on you last whatever their depth', () => {
  const office = { dylan: doing('waiting'), paige: doing('working'), mike: doing('idle'), riley: doing('chatting', { huddleId: 'h', with: [] }) };
  const plan = placePeople(v3, [boss, ...team8], office);
  const order = pinOrder(plan.people);
  assert.equal(order.at(-1)?.agent.id, 'dylan');
  const rest = order.slice(0, -1).map((p) => Math.floor(p.slot.u) + Math.floor(p.slot.v));
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b));
});

// ---------- off shift strip ----------
const CHIP = (() => {
  const open = readFileSync(new URL('off-shift-chip.svg', SPRITE_DIR), 'utf8').match(/<svg\b[^>]*>/)![0];
  return { w: Number(open.match(/\swidth="(\d+)"/)![1]), h: Number(open.match(/\sheight="(\d+)"/)![1]) };
})();
const boxPoly = (b: { x0: number; y0: number; x1: number; y1: number }): Poly => [
  { x: b.x0, y: b.y0 },
  { x: b.x1, y: b.y0 },
  { x: b.x1, y: b.y1 },
  { x: b.x0, y: b.y1 },
];

test('off shift: chips wrap three to a column and never land on the floor or a room label, at every size', () => {
  for (const n of ROUTE_SIZES) {
    const l = at(n);
    const labels = labelSpots(l, 'Patrick').map((s) => s.box);
    for (const count of [1, 3, 4, 8, 12]) {
      const chips = Array.from({ length: count }, (_, i) => ({ name: `Teammate ${i + 1}`, back: i % 2 ? '8:00 AM' : null }));
      const spots = offShiftSpots(l, chips, CHIP, labels);
      const where = `${count} off at ${n} desks`;
      assert.equal(spots.length, count, where);
      assert.equal(new Set(spots.map((s) => s.x)).size, Math.ceil(count / OFF_PER_COLUMN), `${where}: columns`);
      // What each chip draws: the chip, then its name and return time. The chips never touch the floor; names do only
      // in the first column, along the play area's edge as in Figma 109:2.
      const firstX = spots[0].x;
      for (const s of spots) {
        assert.ok(s.parts.length >= 2);
        s.parts.forEach((p, k) => {
          if (k === 0 || s.x !== firstX) for (const t of l.floor) assert.ok(!overlap(boxPoly(p), tileDiamond(t.gx, t.gy)), `${where}: ${k ? 'name' : 'chip'} at ${s.x},${s.y} on tile ${t.gx},${t.gy}`);
          for (const b of labels) assert.ok(!overlap(boxPoly(p), boxPoly(b)), `${where}: chip at ${s.x},${s.y} on a room label`);
        });
      }
      for (let i = 0; i < spots.length; i++) {
        for (let j = i + 1; j < spots.length; j++) {
          const hit = spots[i].parts.some((p) => spots[j].parts.some((q) => overlap(boxPoly(p), boxPoly(q))));
          assert.ok(!hit, `${where}: chips ${i} and ${j} touch`);
        }
      }
    }
  }
  // One chip sits on Figma's spot. A longer column drops just below the hall's front corner, which its second
  // row would touch; and eight off no longer make one long column down the page.
  const start = screen(v3.offShift.u, v3.offShift.v);
  const one = offShiftSpots(v3, [{ name: 'Rodrigo', back: '8:00 AM' }], CHIP);
  assert.deepEqual([one[0].x, one[0].y], [Math.round(start.x), Math.round(start.y)]);
  const eight = offShiftSpots(v3, Array.from({ length: 8 }, (_, i) => ({ name: `Desk ${i}`, back: null })), CHIP);
  assert.equal(eight[0].x, Math.round(start.x));
  const bottom = Math.max(...eight.map((s) => s.y + s.h));
  assert.ok(bottom < Math.round(start.y) + 7 * CHIP_GAP + CHIP.h, `bottom ${bottom}`);
});

// ---------- focus ring contrast (tokens.css against the floor) ----------
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('focus ring: the same in both themes, 3:1 or better on every floor tone, the stage, and between its two rings', () => {
  const css = readFileSync(new URL('./styles/tokens.css', import.meta.url), 'utf8');
  const all = (name: string) => [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1].toLowerCase());
  const outer = all('office-focus-outer');
  const inner = all('office-focus-inner');
  assert.equal(outer.length, 2, 'light and dark themes');
  assert.equal(new Set(outer).size, 1, 'the floor is light in both themes, so the ring is too');
  assert.equal(inner.length, 2);
  assert.equal(new Set(inner).size, 1);
  const palette = JSON.parse(readFileSync(new URL('palette.json', SPRITE_DIR), 'utf8')) as { floor: Record<string, string[] | string> };
  const tones = Object.entries(palette.floor).flatMap(([k, v]) => (Array.isArray(v) ? v : k.startsWith('grout') ? [v] : []));
  assert.ok(tones.length >= 10, 'every zone, both tones');
  for (const t of tones) assert.ok(contrast(outer[0], t) >= 3, `outer ring on ${t}: ${contrast(outer[0], t).toFixed(2)}`);
  // Off-shift chips sit on the stage: the light ring shows on the dark one, the dark ring on the light one.
  const stages = all('office-stage');
  assert.equal(stages.length, 2);
  for (const s of stages) assert.ok(Math.max(contrast(outer[0], s), contrast(inner[0], s)) >= 3, `stage ${s}`);
  assert.ok(contrast(outer[0], inner[0]) >= 3, 'the two rings against each other');
});

// ---------- sprite safety ----------
test('sprite check: every sprite is plain pixel-run paths; scripts, handlers, links and the rest fail the sync', () => {
  for (const f of readdirSync(SPRITE_DIR).filter((x) => x.endsWith('.svg'))) assert.equal(spriteProblem(readFileSync(new URL(f, SPRITE_DIR), 'utf8')), null, f);
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2" viewBox="0 0 2 1" shape-rendering="crispEdges" data-sprite="x" data-tiles="ui" data-anchor="0,0" data-scale="2">\n<!-- Generated by build-sprites.js. -->\n<path fill="#261f24" d="M0 0h2v1h-2z"/>\n</svg>\n';
  assert.equal(spriteProblem(ok), null);
  const bad: [string, string][] = [
    ['script', ok.replace('<path', '<script>alert(1)</script><path')],
    ['on* handler on a path', ok.replace('<path fill', '<path onclick="alert(1)" fill')],
    ['on* handler on the root', ok.replace('<svg xmlns', '<svg onload="alert(1)" xmlns')],
    ['href', ok.replace('<path fill', '<path href="javascript:alert(1)" fill')],
    ['foreignObject', ok.replace('</svg>', '<foreignObject><div/></foreignObject></svg>')],
    ['style with url()', ok.replace('<path fill', '<path style="fill:url(https://x.test/a)" fill')],
    ['style element', ok.replace('<path', '<style>*{}</style><path')],
    ['image', ok.replace('<path', '<image href="x.png"/><path')],
    ['a fill that is not a colour', ok.replace('fill="#261f24"', 'fill="url(#g)"')],
    ['an entity in d', ok.replace('d="M0 0h2v1h-2z"', 'd="M0 0&#104;2"')],
    ['a comment that ends early', ok.replace('<!-- Generated by build-sprites.js. -->', '<!-- a --!><script>alert(1)</script><!-- b -->')],
    ['text after </svg>', `${ok}<script>alert(1)</script>`],
    ['an unclosed tag', ok.replace('<path fill="#261f24" d="M0 0h2v1h-2z"/>', '<path fill="#261f24" d="M0 0h2v1h-2z">')],
    ['no <svg> first', `<?xml version="1.0"?>${ok}`],
  ];
  for (const [what, svg] of bad) assert.notEqual(spriteProblem(svg), null, what);
});

test('sprites in the page: only <path> fill and d survive, rebuilt; the real sprites come through unchanged', () => {
  for (const f of readdirSync(SPRITE_DIR).filter((x) => x.endsWith('.svg'))) {
    const text = readFileSync(new URL(f, SPRITE_DIR), 'utf8');
    const s = parseSprite(`./sprites/${f}`, text)!;
    assert.equal(s.name, f.slice(0, -4));
    // Every path in the file, as written (build-sprites writes fill then d), and nothing else.
    const paths = [...text.matchAll(/<path fill="[^"]*" d="[^"]*"\/>/g)].map((m) => m[0]);
    assert.equal(s.body, paths.join(''), f);
  }
  assert.equal(safeBody('<path fill="#000000" onload="x()" d="M0 0h1v1h-1z"/><script>alert(1)</script><image href="x"/>'), '<path fill="#000000" d="M0 0h1v1h-1z"/>');
  assert.equal(safeBody('<path fill="red" d="M0 0&quot;"/>'), '', 'nothing safe left, so no path');
});

test('hover card text: durations and return times', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  assert.equal(durationSince(ago(0), now), '<1m');
  assert.equal(durationSince(ago(42), now), '42m');
  assert.equal(durationSince(ago(72), now), '1h 12m');
  assert.equal(durationSince(ago(180), now), '3h');
  assert.equal(durationSince(ago(28 * 60), now), '1d 4h');
  assert.equal(durationSince('nonsense', now), '');
  assert.equal(returnTime('Off shift until 8:00 AM'), '8:00 AM');
  assert.equal(returnTime('Working on it'), null);
  assert.equal(returnTime(undefined), null);
});

test('people: 10×16 pixels at 2×, colours steady per desk, shirt muted toward grey', () => {
  const runs = personRuns(personColours('paige', '#8a5fb8'));
  assert.equal(Math.max(...runs.map((r) => r.y)) / 2 + 1, 16);
  assert.ok(runs.every((r) => r.x + r.w <= PERSON_W && r.w % 2 === 0));
  assert.deepEqual(personColours('paige', '#8a5fb8'), personColours('paige', '#8a5fb8'));
  assert.equal(mix('#ff0000', '#000000', 0.5), '#800000');
  assert.equal(personColours('x', '#8a5fb8').T, mix('#8a5fb8', '#8c8c8c', 0.45));
  assert.equal(mix('not-a-colour', '#000000', 0), '#8c8c8c', 'a bad colour falls back to grey');
});

test('geometry: sprites sit on their footprint\'s front corner; people draw after the furniture on their tile', () => {
  const box = spriteBox({ sprite: 'desk', gx: 1, gy: 0, fu: 1, fv: 2 }, { ax: 17, ay: 47, w: 100, h: 96 });
  // Front corner (2, 2) is screen (0, 64); the anchor (17, 47) art px is (34, 94) on screen.
  assert.deepEqual(box, { x: -34, y: -30, w: 100, h: 96 });
  // A desk at (1,0) and its owner on the chair tile (1,1): same depth, and people sort after furniture.
  assert.equal(depthOf({ gx: 1, gy: 0, fu: 1, fv: 2 }), personDepth(1.5, 1.5));
  // Someone just behind a knee wall on the next tile draws first, so the wall hides their legs.
  assert.ok(personDepth(4.5, 2.5) < depthOf({ gx: 5, gy: 2, fu: 1, fv: 1 }));
});

console.log(`office: ${passed} tests passed`);
