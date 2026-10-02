import type { Barrier, NavEdge, NavNode, OfficeLayout, Placement, Room, RoomLabel, RoomRect, Slot } from './types';

/**
 * The office floor, generated from headcount: the spec's §9.2 growth rules on the Round 14 rooms (ruling 13).
 * At 5–8 desks it is office-room.svg v3 tile for tile. zones.v3.json is that file extracted by
 * `npm run office:sync`, and office.test.ts holds the two together. Pure data, so it runs in Node.
 *
 * Left to right: the office (pods of 4 desks) with the play area under it, the hall spine, then the right
 * band: the founder's room, the queue row, the meeting room and the kitchen. Off shift is outside, in front
 * of the play area. Grid units as in types.ts: tile (u, v) spans u..u+1, v..v+1.
 */

/** Footprint in tiles (u × v) of every sprite that sits on the grid, as its data-tiles says. Tags, lamp and chip are UI. */
export const FOOTPRINTS: Readonly<Record<string, { fu: number; fv: number }>> = {
  arcade: { fu: 1, fv: 1 },
  bookshelf: { fu: 1, fv: 1 },
  'coffee-machine': { fu: 1, fv: 1 },
  couch: { fu: 2, fv: 1 },
  desk: { fu: 1, fv: 2 },
  'floor-founder-a': { fu: 1, fv: 1 },
  'floor-founder-b': { fu: 1, fv: 1 },
  'floor-kitchen-a': { fu: 1, fv: 1 },
  'floor-kitchen-b': { fu: 1, fv: 1 },
  'floor-lounge-a': { fu: 1, fv: 1 },
  'floor-lounge-b': { fu: 1, fv: 1 },
  'floor-meeting-a': { fu: 1, fv: 1 },
  'floor-meeting-b': { fu: 1, fv: 1 },
  'floor-office-a': { fu: 1, fv: 1 },
  'floor-office-b': { fu: 1, fv: 1 },
  'founder-bench': { fu: 1, fv: 1 },
  'founder-desk': { fu: 1, fv: 2 },
  'low-wall-post': { fu: 1, fv: 1 },
  'low-wall-u0': { fu: 1, fv: 1 },
  'low-wall-u1': { fu: 1, fv: 1 },
  'low-wall-v0': { fu: 1, fv: 1 },
  'low-wall-v1': { fu: 1, fv: 1 },
  'meeting-chair-e': { fu: 1, fv: 1 },
  'meeting-chair-w': { fu: 1, fv: 1 },
  'meeting-table': { fu: 1, fv: 1 },
  'meeting-table-long-3': { fu: 1, fv: 3 },
  'meeting-table-long-5': { fu: 1, fv: 5 },
  'meeting-table-long-7': { fu: 1, fv: 7 },
  plant: { fu: 1, fv: 1 },
  'pool-table': { fu: 3, fv: 2 },
  'rug-lounge': { fu: 3, fv: 3 },
  'wall-u0': { fu: 1, fv: 1 },
  'wall-u1': { fu: 1, fv: 1 },
  'wall-v0': { fu: 1, fv: 1 },
  'wall-v0-window': { fu: 1, fv: 1 },
  'wall-v1': { fu: 1, fv: 1 },
  'wall-v1-door': { fu: 1, fv: 1 },
};

/** A doorway: a one-tile gap in a room's wall, as a line in grid units (the SVG's data-kind="door"). */
export interface DoorLine {
  room: Room;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** "full" only for the founder's room, whose doorway is drawn by wall-v1-door. */
  wall: 'full' | 'low';
}

/** The longest table sprite is meeting-table-long-7, which seats 24 (L = 2·ceil(N/6) − 1). */
export const MAX_DESKS = 24;

// A pod cell: 4 desks plus an aisle column, and a desk row, a seat row and an aisle row (§9.2 rule 1).
const POD_W = 5;
const POD_D = 3;
// A play module: arcade, couch and plant on the back row, a walkway row, then the pool table (§9.2 rule 4).
const MODULE_W = 5;
const MODULE_D = 4;
// The right band: the founder's room is 4×3 (rule 3), with the queue row, meeting room and kitchen below it.
const BAND_W = 4;
const FOUNDER_D = 3;
const KITCHEN_W = 3;
const KITCHEN_D = 3;
/** Half a wall's thickness: walls are 6 of the flat spec's 48 units, centred on the tile edge. */
const WALL = 0.0625;

const FLOOR_TONE: Record<Room, string> = { office: 'office', hall: 'office', founder: 'founder', play: 'lounge', meeting: 'meeting', kitchen: 'kitchen' };

/**
 * Room labels, outside the floor on a room's left or right edge (§9.2 rule 6, Figma 109:2). `along` is how far
 * down the edge the text centre sits, as a share of the room's depth; `out` is how far beyond the edge, in tiles.
 * Measured from the Figma text centres against the v3 rooms (figma-notes.md); the kitchen is a row lower than
 * in Figma because v3 adds the meeting walkway row, and the founder's text is filled in by the renderer.
 */
const LABEL_SPOTS: { room: Room; text: string; side: 'left' | 'right'; along: number; out: number }[] = [
  { room: 'office', text: 'OFFICE', side: 'left', along: 1.765625 / 6, out: 1.234375 },
  { room: 'play', text: 'PLAY AREA', side: 'left', along: 2.765625 / 4, out: 0.734375 },
  { room: 'founder', text: 'FOUNDER', side: 'right', along: 0.5 / 3, out: 1.03125 },
  { room: 'meeting', text: 'MEETING ROOM', side: 'right', along: 0.546875 / 4, out: 0.984375 },
  { room: 'kitchen', text: 'KITCHEN', side: 'right', along: 0.875 / 3, out: 0.65625 },
];

/** Where the off-shift strip starts, from the play area's front-left corner (Figma chip at u 2.0, v 11.6). */
const OFF_SHIFT = { du: 2, dv: 1.6 };

/**
 * Pod cells in hand-out order (§9.2 rule 1). The sequence never depends on headcount: when the block is full
 * it grows a row or a column, whichever keeps its tile width and depth closer to equal (a tie grows a column),
 * then fills a new row left to right or a new column top to bottom. (0,0), (0,1), (1,0), (1,1), (0,2), (1,2)…
 */
export function podCells(count: number): { col: number; row: number }[] {
  const cells: { col: number; row: number }[] = [];
  const pending = [{ col: 0, row: 0 }];
  let cols = 1;
  let rows = 1;
  while (cells.length < count) {
    if (!pending.length) {
      const byRow = Math.abs(cols * POD_W - (rows + 1) * POD_D);
      const byCol = Math.abs((cols + 1) * POD_W - rows * POD_D);
      if (byCol <= byRow) {
        for (let row = 0; row < rows; row++) pending.push({ col: cols, row });
        cols++;
      } else {
        for (let col = 0; col < cols; col++) pending.push({ col, row: rows });
        rows++;
      }
    }
    cells.push(pending.shift()!);
  }
  return cells;
}

/** The office floor for this many desks (teammates, founder excluded), clamped to 1..MAX_DESKS. */
export function layoutFor(desks: number): OfficeLayout {
  return build(desks).layout;
}

/** The doorways of the same floor: the gaps the route check lets doorway edges through. */
export function doorsFor(desks: number): DoorLine[] {
  return build(desks).doors;
}

function place(sprite: string, gx: number, gy: number): Placement {
  const fp = FOOTPRINTS[sprite];
  if (!fp) throw new Error(`office layout: no footprint for sprite ${sprite}`);
  return { sprite, gx, gy, fu: fp.fu, fv: fp.fv };
}

/** A grid coordinate from a whole tile plus an offset in the flat spec's 48ths, computed as the extractor does. */
function flat(tile: number, units: number): number {
  return (tile * 48 + units) / 48;
}

/** Same rule as scripts/office-sync.mjs: the wall belongs to the room that isn't the hall or outside, else the one in front. */
function wallName(kind: 'full' | 'low', before: Room | null, after: Room | null, horizontal: boolean): string {
  const owner = before === null ? after : after === null ? before : before === 'hall' ? after : after === 'hall' ? before : after;
  const side = horizontal ? (owner === after ? 'back' : 'front') : owner === after ? 'left' : 'right';
  return `${kind === 'full' ? 'wall' : 'low wall'} ${owner} ${side}`;
}

/** Walls go between rooms (knee-height), and around the founder's room on every side, outer edges included (rulings 6, 12, 13). */
function wallKind(before: Room | null, after: Room | null): 'full' | 'low' | null {
  if (before === after) return null;
  if (before === 'founder' || after === 'founder') return 'full';
  if (before === null || after === null) return null;
  return 'low';
}

const EDGE_RANK: Record<string, number> = { v0: 0, u0: 1, u1: 2, v1: 3 };
const edgeRank = (sprite: string) => EDGE_RANK[sprite.match(/(u0|u1|v0|v1)/)?.[1] ?? ''] ?? 4;

function build(requested: number): { layout: OfficeLayout; doors: DoorLine[] } {
  const desks = Math.min(MAX_DESKS, Math.max(1, Math.round(requested) || 1));
  // Desks come in whole pods, so the room is built for pods × 4 seats; empty owned desks are expected.
  // Every other ratio uses that seat count, so 5–8 desks give exactly the same floor.
  const pods = Math.ceil(desks / 4);
  const seats = pods * 4;
  const cells = podCells(pods);
  const officeW = (Math.max(...cells.map((c) => c.col)) + 1) * POD_W;
  const officeD = (Math.max(...cells.map((c) => c.row)) + 1) * POD_D;
  // One long table, L = 2·ceil(N/6) − 1 (ruling 13). Only 3, 5 and 7 are drawn, so 1 rounds up to 3.
  const tableL = Math.min(7, Math.max(3, 2 * Math.ceil(seats / 6) - 1));
  // One play module per 12 people, one under each pod column (rule 4).
  const modules = Math.ceil(seats / 12);
  const moduleCols = officeW / MODULE_W;
  if (modules > moduleCols) throw new Error('office layout: play modules would wrap to a second row'); // not reachable up to MAX_DESKS
  const band = officeW + 1; // the right band starts one tile (the hall spine) right of the office
  const meetingV = FOUNDER_D + 1;
  const kitchenV = meetingV + tableL + 1; // the meeting room is the table plus one walkway row
  const depth = Math.max(officeD + MODULE_D, kitchenV + KITCHEN_D);
  const width = band + BAND_W;

  // ---------- rooms and doorways ----------
  const rect = (room: Room, u0: number, v0: number, w: number, d: number): RoomRect => ({ room, u0, v0, w, d });
  const office = rect('office', 0, 0, officeW, officeD);
  const play = rect('play', 0, officeD, officeW, MODULE_D);
  const founder = rect('founder', band, 0, BAND_W, FOUNDER_D);
  const meeting = rect('meeting', band, meetingV, BAND_W, tableL + 1);
  const kitchen = rect('kitchen', band, kitchenV, KITCHEN_W, KITCHEN_D);
  const rooms: RoomRect[] = [office, play, rect('hall', officeW, 0, 1, depth), rect('hall', band, FOUNDER_D, BAND_W, 1), founder, meeting, kitchen];

  const sideDoor = (room: Room, u: number, v: number): DoorLine => ({ room, u0: u, v0: v, u1: u, v1: v + 1, wall: 'low' });
  const doors: DoorLine[] = [
    sideDoor('office', officeW, 2), // onto the first aisle row
    sideDoor('play', officeW, play.v0 + 1), // onto the walkway row in front of the couch
    { room: 'founder', u0: band + 1, v0: FOUNDER_D, u1: band + 2, v1: FOUNDER_D, wall: 'full' },
    sideDoor('meeting', band, meeting.v0 + 1),
    sideDoor('kitchen', band, kitchen.v0 + 1),
  ];

  const roomAt = (u: number, v: number): Room | null =>
    rooms.find((r) => u >= r.u0 && u < r.u0 + r.w && v >= r.v0 && v < r.v0 + r.d)?.room ?? null;

  // ---------- floor ----------
  // Checkerboard: (gx + gy) even is tone a, which is what Figma 109:2 shows at tile (0, 0).
  const floor: Placement[] = [];
  for (let v = 0; v < depth; v++) {
    for (let u = 0; u < width; u++) {
      const room = roomAt(u, v);
      if (room) floor.push(place(`floor-${FLOOR_TONE[room]}-${(u + v) % 2 ? 'b' : 'a'}`, u, v));
    }
  }

  // ---------- walls ----------
  // Every tile edge between two rooms is a wall unless it's a doorway; runs along one edge between the same two
  // rooms become one barrier, as office-room.svg draws them. Sprites go on the tile in front of the edge (its u0
  // or v0), so painter's order hides what stands behind a wall. The founder's full walls go on his own tiles:
  // his front wall is wall-v1 on row 2, leaving no wall inside the room on row 2's back edge (ruling 12).
  // Doorway tile edges: "|u,v" is the left edge of tile (u, v), "-v,u" its back edge.
  const doorEdges = new Set<string>();
  for (const d of doors) {
    if (d.u0 === d.u1) for (let v = d.v0; v < d.v1; v++) doorEdges.add(`|${d.u0},${v}`);
    else for (let u = d.u0; u < d.u1; u++) doorEdges.add(`-${d.v0},${u}`);
  }
  const walls: Placement[] = [];
  const wallBarriers: Barrier[] = [];
  const windowU = founder.u0 + founder.w - 1; // the back wall's right-most tile; the bookshelf is on the left wall

  const wallSprite = (horizontal: boolean, line: number, i: number, after: Room | null, kind: 'full' | 'low', door: boolean): Placement | null => {
    if (kind === 'low') {
      if (door) return null; // a doorway is a gap; its ends get posts below
      return horizontal ? place('low-wall-v0', i, line) : place('low-wall-u0', line, i);
    }
    const inside = after === 'founder'; // the founder's tile is in front of this edge
    if (horizontal) {
      if (inside) {
        if (door) throw new Error('office layout: no sprite for a doorway in a back wall');
        return place(line === founder.v0 && i === windowU ? 'wall-v0-window' : 'wall-v0', i, line);
      }
      return place(door ? 'wall-v1-door' : 'wall-v1', i, line - 1);
    }
    if (door) throw new Error('office layout: no sprite for a doorway in a side wall');
    return inside ? place('wall-u0', line, i) : place('wall-u1', line - 1, i);
  };

  for (const horizontal of [false, true]) {
    const lines = horizontal ? depth : width;
    const span = horizontal ? width : depth;
    for (let line = 0; line <= lines; line++) {
      let run: { start: number; before: Room | null; after: Room | null; kind: 'full' | 'low' } | null = null;
      // One step past the end closes the last run.
      for (let i = 0; i <= span; i++) {
        const inSpan = i < span;
        const before = !inSpan ? null : horizontal ? roomAt(i, line - 1) : roomAt(line - 1, i);
        const after = !inSpan ? null : horizontal ? roomAt(i, line) : roomAt(line, i);
        const kind = inSpan ? wallKind(before, after) : null;
        const door = kind !== null && doorEdges.has(horizontal ? `-${line},${i}` : `|${line},${i}`);
        const solid = kind !== null && !door;
        if (run && (!solid || run.before !== before || run.after !== after)) {
          const box = horizontal
            ? { u0: run.start, v0: line - WALL, u1: i, v1: line + WALL }
            : { u0: line - WALL, v0: run.start, u1: line + WALL, v1: i };
          wallBarriers.push({ kind: run.kind, ...box, name: wallName(run.kind, run.before, run.after, horizontal) });
          run = null;
        }
        if (solid && !run) run = { start: i, before, after, kind };
        if (kind) {
          const sprite = wallSprite(horizontal, line, i, after, kind, door);
          if (sprite) walls.push(sprite);
        }
      }
    }
  }
  // Posts cap both ends of each knee-wall doorway. The post is drawn in the middle of its 1×1 footprint, so the
  // footprint starts half a tile up and left of the gap end: the post lands on the end, its anchor half a tile
  // beyond it at (end + 0.5, end + 0.5).
  for (const d of doors) {
    if (d.wall !== 'low') continue;
    walls.push(place('low-wall-post', d.u0 - 0.5, d.v0 - 0.5), place('low-wall-post', d.u1 - 0.5, d.v1 - 0.5));
  }
  walls.sort((a, b) => a.gy - b.gy || a.gx - b.gx || edgeRank(a.sprite) - edgeRank(b.sprite));

  // ---------- furniture, and the props people walk around ----------
  const rugs: Placement[] = []; // flat, under the pool table: listed first so they draw first
  const furniture: Placement[] = [];
  const props: Barrier[] = [];
  const prop = (name: string, u0: number, v0: number, u1: number, v1: number) => props.push({ kind: 'prop', u0, v0, u1, v1, name });

  cells.forEach((c, p) => {
    const u0 = c.col * POD_W;
    const v0 = c.row * POD_D;
    // Four 1×2 desks: the desk tile, then its chair tile in front.
    for (let i = 0; i < 4; i++) furniture.push(place('desk', u0 + i, v0));
    prop(`desks-pod-${p + 1}`, u0, v0, u0 + 4, v0 + 1);
  });

  const mv = meeting.v0;
  furniture.push(place(`meeting-table-long-${tableL}`, band + 2, mv));
  for (let i = 0; i < tableL; i++) furniture.push(place('meeting-chair-w', band + 1, mv + i), place('meeting-chair-e', band + 3, mv + i));
  prop('meeting-table-long', band + 2, mv, band + 3, mv + tableL);

  // His desk on the back row, one empty row before the front wall (ruling 12); the shelf on the left wall.
  furniture.push(place('founder-desk', band + 1, 0), place('bookshelf', band, 1), place('founder-bench', band, FOUNDER_D));
  prop('founder-desk', band + 1, 0, band + 2, 1);
  prop('bookshelf', flat(band, 4), 1, flat(band, 24), 2);
  prop('bench', flat(band, 4), flat(FOUNDER_D, 3), flat(band, 44), flat(FOUNDER_D, 22));

  // Play modules, one under each pod column: the couch beside the arcade (ruling 13), pool table on the rug.
  const moduleAt = (m: number) => ({ u: (m % moduleCols) * MODULE_W, v: play.v0 + Math.floor(m / moduleCols) * MODULE_D });
  for (let m = 0; m < modules; m++) {
    const { u, v } = moduleAt(m);
    rugs.push(place('rug-lounge', u + 1, v + 1));
    furniture.push(place('pool-table', u + 1, v + 2), place('arcade', u, v), place('couch', u + 1, v), place('plant', u + 4, v));
    prop('arcade', u, v, u + 1, v + 1);
    prop('couch', u + 1, v, u + 3, v + 1);
    prop('plant', u + 4, v, u + 5, v + 1);
    prop('billiards', u + 1, v + 2, u + 4, v + 4);
  }

  furniture.push(place('coffee-machine', band + 1, kitchen.v0), place('plant', band + 2, kitchen.v0 + 2));
  prop('coffee', band + 1, kitchen.v0, band + 2, kitchen.v0 + 1);
  prop('plant', band + 2, kitchen.v0 + 2, band + 3, kitchen.v0 + 3);

  // ---------- slots (numbering frozen, spec §9 and §9.2) ----------
  const slots: Slot[] = [];
  // Desk k sits on desk k's chair tile, in pod floor((k − 1) / 4) at position (k − 1) mod 4.
  for (let k = 1; k <= seats; k++) {
    const c = cells[Math.floor((k - 1) / 4)];
    slots.push({ zone: 'desks', n: k, room: 'office', u: c.col * POD_W + ((k - 1) % 4) + 0.5, v: c.row * POD_D + 1.5, facing: 'N' });
  }

  // Meeting: chairs down both sides of the table, pairs facing across it (a = west chair facing E, b = east
  // facing W). Rows 0–2 are slots 1–6; 7/8 are the huddle by the door; rows a longer table adds append from 9.
  const meetingSlots: Slot[] = [];
  for (let i = 0; i < tableL; i++) {
    const n = i < 3 ? 2 * i + 1 : 2 * i + 3;
    const pair = `meet-${String(i < 3 ? i + 1 : i + 2).padStart(2, '0')}`;
    const v = mv + i + 0.5;
    meetingSlots.push(
      { zone: 'meeting', n, room: 'meeting', u: band + 1.5, v, facing: 'E', pair, side: 'a' },
      { zone: 'meeting', n: n + 1, room: 'meeting', u: band + 3.5, v, facing: 'W', pair, side: 'b' },
    );
  }
  meetingSlots.push(
    { zone: 'meeting', n: 7, room: 'meeting', u: band + 0.5, v: mv + 0.5, facing: 'S', pair: 'meet-04', side: 'a', prop: 'huddle' },
    { zone: 'meeting', n: 8, room: 'meeting', u: band + 0.5, v: mv + 2.5, facing: 'N', pair: 'meet-04', side: 'b', prop: 'huddle' },
  );
  slots.push(...meetingSlots.sort((a, b) => a.n - b.n));

  // Founder: the bench (seated, reached from below it), two spots by the door, the queue up the spine, his chair.
  const q = FOUNDER_D; // the queue row
  slots.push(
    { zone: 'founder', n: 1, room: 'hall', u: band + 0.5, v: q + 0.25, facing: 'S', approach: { u: band + 0.5, v: q + 0.75 }, prop: 'bench' },
    { zone: 'founder', n: 2, room: 'hall', u: band + 2.5, v: q + 0.5, facing: 'N' },
    { zone: 'founder', n: 3, room: 'hall', u: band + 3.5, v: q + 0.5, facing: 'N' },
    { zone: 'founder', n: 4, room: 'hall', u: officeW + 0.5, v: q + 0.5, facing: 'E', queue: true },
    { zone: 'founder', n: 5, room: 'hall', u: officeW + 0.5, v: q - 0.5, facing: 'S', queue: true },
    { zone: 'founder', n: 6, room: 'founder', u: band + 1.5, v: 1.5, facing: 'N', occupant: 'founder', prop: 'founder-desk' },
  );

  // Lounge: the first module has 6 spots (one is the coffee machine in the kitchen); each later module appends
  // its 5 in the same order: billiards ×2, arcade, couch ×2.
  let ln = 0;
  for (let m = 0; m < modules; m++) {
    const { u, v } = moduleAt(m);
    const add = (s: Omit<Slot, 'zone' | 'n'>) => slots.push({ zone: 'lounge', n: ++ln, ...s });
    add({ room: 'play', u: u + 0.5, v: v + 2.5, facing: 'E', prop: 'billiards' });
    add({ room: 'play', u: u + 4.5, v: v + 2.5, facing: 'W', prop: 'billiards' });
    add({ room: 'play', u: u + 0.5, v: v + 1.5, facing: 'N', prop: 'arcade' });
    if (m === 0) add({ room: 'kitchen', u: band + 1.5, v: kitchen.v0 + 1.5, facing: 'N', prop: 'coffee' });
    add({ room: 'play', u: u + 1.5, v: v + 0.5, facing: 'S', approach: { u: u + 1.5, v: v + 1.5 }, prop: 'couch' });
    add({ room: 'play', u: u + 2.5, v: v + 0.5, facing: 'S', approach: { u: u + 2.5, v: v + 1.5 }, prop: 'couch' });
  }

  // ---------- nav graph ----------
  const nodes: NavNode[] = [];
  const edges: NavEdge[] = [];
  const node = (id: string, u: number, v: number) => {
    nodes.push({ id, u, v });
    return id;
  };
  const edge = (from: string, to: string, door?: Room) => edges.push(door ? { from, to, door } : { from, to });
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  // The spine has one node level with each doorway, plus the queue row's walking line (below the bench),
  // joined top to bottom. Ids are s + the tile row.
  const doorOf = (room: Room) => doors.find((d) => d.room === room)!;
  const queueLine = q + 0.75;
  const spineVs = [...new Set([doorOf('office').v0 + 0.5, queueLine, doorOf('play').v0 + 0.5, doorOf('meeting').v0 + 0.5, doorOf('kitchen').v0 + 0.5])].sort((a, b) => a - b);
  const spine = new Map(spineVs.map((v) => [v, node(`s${Math.floor(v)}`, officeW + 0.5, v)]));
  for (let i = 1; i < spineVs.length; i++) edge(spine.get(spineVs[i - 1])!, spine.get(spineVs[i])!);
  const spineAt = (v: number) => spine.get(v)!;

  // Office: both ends of every aisle row, and the right-hand aisle column joining the rows to the doorway.
  const officeRows = officeD / POD_D;
  const right: string[] = [];
  const left: string[] = [];
  for (let r = 0; r < officeRows; r++) {
    const v = r * POD_D + 2.5;
    right.push(node(`o${LETTERS[2 * r]}`, officeW - 0.5, v));
    left.push(node(`o${LETTERS[2 * r + 1]}`, 0.5, v));
  }
  for (let r = 0; r < officeRows; r++) {
    if (r === 0) edge(spineAt(doorOf('office').v0 + 0.5), right[0], 'office');
    edge(right[r], left[r]);
    if (r + 1 < officeRows) edge(right[r], right[r + 1]);
  }

  // Founder: along the queue row, and through his doorway to the empty row in front of his desk.
  const qA = node('qA', band + 1.5, queueLine);
  const qB = node('qB', band + 3.5, queueLine);
  const fd = node('fd', band + 1.5, FOUNDER_D - 0.5);
  edge(spineAt(queueLine), qA);
  edge(qA, qB);
  edge(qA, fd, 'founder');

  // Meeting: in at the doorway, down the huddle column, along the walkway row, up past the far-side chairs.
  const mA = node('mA', band + 0.5, doorOf('meeting').v0 + 0.5);
  const mB = node('mB', band + 0.5, mv + tableL + 0.5);
  const mC = node('mC', band + 3.5, mv + tableL + 0.5);
  const mD = node('mD', band + 3.5, mv + 0.5);
  edge(spineAt(doorOf('meeting').v0 + 0.5), mA, 'meeting');
  edge(mA, mB);
  edge(mB, mC);
  edge(mC, mD);

  // Play: along the walkway row from the doorway, stopping at both ends of every module.
  const walkway = doorOf('play').v0 + 0.5;
  const stops = [officeW - 0.5];
  for (let m = modules - 1; m >= 0; m--) stops.push(moduleAt(m).u + 4.5, moduleAt(m).u + 0.5);
  const playIds = stops.filter((u, i) => i === 0 || u !== stops[i - 1]).map((u, i) => node(`p${LETTERS[i]}`, u, walkway));
  edge(spineAt(walkway), playIds[0], 'play');
  for (let i = 1; i < playIds.length; i++) edge(playIds[i - 1], playIds[i]);

  const kA = node('kA', band + 0.5, doorOf('kitchen').v0 + 0.5);
  edge(spineAt(doorOf('kitchen').v0 + 0.5), kA, 'kitchen');

  // ---------- labels, door, off shift ----------
  const labels: RoomLabel[] = LABEL_SPOTS.map((s) => {
    const r = rooms.find((x) => x.room === s.room)!;
    return { room: s.room, text: s.text, u: s.side === 'left' ? r.u0 - s.out : r.u0 + r.w + s.out, v: r.v0 + s.along * r.d };
  });
  const founderDoor = doorOf('founder');

  const layout: OfficeLayout = {
    desks,
    cols: width,
    rows: depth,
    rooms,
    floor,
    walls,
    furniture: [...rugs, ...furniture],
    slots,
    labels,
    door: { u: (founderDoor.u0 + founderDoor.u1) / 2, v: founderDoor.v0 },
    offShift: { u: play.u0 + OFF_SHIFT.du, v: play.v0 + play.d + OFF_SHIFT.dv },
    nav: { nodes, edges },
    barriers: [...wallBarriers, ...props],
  };
  return { layout, doors };
}

