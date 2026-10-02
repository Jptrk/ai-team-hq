/**
 * office:sync — bring the design team's office files into the app.
 *
 * 1. Checks every generated sprite (specs/sprites/*.svg, not old/) holds only pixel-run paths, then copies them
 *    plus palette.json into src/office/sprites/. One bad file stops the sync before anything is copied.
 * 2. Extracts the room geometry from specs/office-room.svg (the source of truth, spec §9) into
 *    src/office/zones.v3.json: rooms, doors, barriers (walls and furniture), slots and the nav graph,
 *    converted to grid units. layout.ts must reproduce it at 8 desks; office.test.ts checks that.
 *
 * Plain Node, no dependencies. Run: npm run office:sync
 * The design folder defaults to the shared project folder; set OFFICE_DESIGN_DIR to use another copy.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spriteProblem } from './sprite-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = process.env.OFFICE_DESIGN_DIR || 'C:\\Users\\patri\\Desktop\\ai-team-hq-design';
const SPRITES_SRC = join(DESIGN, 'specs', 'sprites');
const ROOM_SVG = join(DESIGN, 'specs', 'office-room.svg');
const SPRITES_OUT = join(ROOT, 'src', 'office', 'sprites');
const ZONES_OUT = join(ROOT, 'src', 'office', 'zones.v3.json');

// The flat spec draws one tile as 48 units with tile (0, 0) at (40, 96).
const TILE = 48;
const ORIGIN_X = 40;
const ORIGIN_Y = 96;
const gu = (x) => (x - ORIGIN_X) / TILE;
const gv = (y) => (y - ORIGIN_Y) / TILE;

function fail(message) {
  console.error(`office:sync: ${message}`);
  process.exit(1);
}

// ---------- sprites ----------

function syncSprites() {
  if (!existsSync(SPRITES_SRC)) fail(`no sprites folder at ${SPRITES_SRC} (set OFFICE_DESIGN_DIR)`);
  const isFile = (dir, f) => statSync(join(dir, f)).isFile();
  const svgs = readdirSync(SPRITES_SRC)
    .filter((f) => f.endsWith('.svg') && isFile(SPRITES_SRC, f))
    .sort();
  if (!svgs.length) fail(`no sprites in ${SPRITES_SRC}`);
  if (!existsSync(join(SPRITES_SRC, 'palette.json'))) fail(`no palette.json in ${SPRITES_SRC}`);
  for (const f of svgs) {
    const svg = readFileSync(join(SPRITES_SRC, f), 'utf8');
    // The app puts sprite markup straight into the page: only pixel-run paths get through (see sprite-check.mjs).
    const problem = spriteProblem(svg);
    if (problem) fail(`${f} is not a plain sprite: ${problem}. Nothing was copied; rebuild it with build-sprites.js.`);
    // A sprite's file name is how the layout refers to it, so it must match its own data-sprite.
    const open = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
    const name = open.match(/\sdata-sprite="([^"]*)"/)?.[1];
    if (name !== f.slice(0, -4)) fail(`${f} says data-sprite="${name}"`);
  }
  // Start clean so a sprite the designers deleted doesn't linger here.
  mkdirSync(SPRITES_OUT, { recursive: true });
  for (const f of readdirSync(SPRITES_OUT)) if (isFile(SPRITES_OUT, f)) rmSync(join(SPRITES_OUT, f));
  for (const f of [...svgs, 'palette.json']) copyFileSync(join(SPRITES_SRC, f), join(SPRITES_OUT, f));
  return svgs.length;
}

// ---------- office-room.svg ----------

function attributes(text) {
  const out = {};
  for (const m of text.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** Every rect, circle and line with its attributes, in document order. Comments are dropped first: the header quotes tags. */
function elements(svg) {
  const body = svg.replace(/<!--[\s\S]*?-->/g, '');
  return [...body.matchAll(/<(rect|circle|line)\b([^>]*?)\/?>/g)].map((m) => ({ tag: m[1], a: attributes(m[2]) }));
}

function num(el, key) {
  const n = Number(el.a[key]);
  if (el.a[key] === undefined || !Number.isFinite(n)) fail(`<${el.tag}> has no numeric ${key}: ${JSON.stringify(el.a)}`);
  return n;
}

function roomAt(rooms, u, v) {
  return rooms.find((r) => u > r.u0 && u < r.u0 + r.w && v > r.v0 && v < r.v0 + r.d)?.room ?? null;
}

/**
 * A wall's name, from the rooms on either side ("before" = smaller u or v). The wall belongs to the
 * room that isn't the hall or outside; between two rooms, to the one in front. layout.ts uses the same rule.
 */
function wallName(kind, before, after, horizontal) {
  const owner = before === null ? after : after === null ? before : before === 'hall' ? after : after === 'hall' ? before : after;
  const side = horizontal ? (owner === after ? 'back' : 'front') : owner === after ? 'left' : 'right';
  return `${kind === 'full' ? 'wall' : 'low wall'} ${owner} ${side}`;
}

const FACINGS = new Set(['N', 'E', 'S', 'W']);

function extract(svg) {
  const els = elements(svg);
  const kind = (k) => els.filter((e) => e.a['data-kind'] === k);

  const rooms = kind('room').map((e) => {
    const tiles = (e.a['data-tiles'] ?? '').split(',').map(Number);
    if (tiles.length !== 4 || tiles.some((t) => !Number.isFinite(t))) fail(`room ${e.a['data-room']} has bad data-tiles`);
    const [u0, v0, w, d] = tiles;
    // data-tiles must agree with the drawn rect, or one of them is stale.
    if (gu(num(e, 'x')) !== u0 || gv(num(e, 'y')) !== v0 || num(e, 'width') / TILE !== w || num(e, 'height') / TILE !== d) {
      fail(`room ${e.a['data-room']}: data-tiles ${e.a['data-tiles']} doesn't match its rect`);
    }
    return { room: e.a['data-room'], u0, v0, w, d };
  });

  const doors = kind('door').map((e) => {
    const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((k) => num(e, k));
    return {
      room: e.a['data-room'],
      u0: gu(Math.min(x1, x2)),
      v0: gv(Math.min(y1, y2)),
      u1: gu(Math.max(x1, x2)),
      v1: gv(Math.max(y1, y2)),
      wall: e.a['data-wall'] === 'full' ? 'full' : 'low',
    };
  });

  const barriers = kind('blocked').map((e) => {
    const x = num(e, 'x');
    const y = num(e, 'y');
    const w = num(e, 'width');
    const h = num(e, 'height');
    const box = { u0: gu(x), v0: gv(y), u1: gu(x + w), v1: gv(y + h) };
    if (e.a['data-prop']) return { kind: 'prop', ...box, name: e.a['data-prop'] };
    const wall = e.a['data-wall'];
    if (wall !== 'full' && wall !== 'low') fail(`blocked rect at ${x},${y} is neither a wall nor a prop`);
    const horizontal = w > h;
    const line = horizontal ? (box.v0 + box.v1) / 2 : (box.u0 + box.u1) / 2;
    const mid = horizontal ? (box.u0 + box.u1) / 2 : (box.v0 + box.v1) / 2;
    const before = horizontal ? roomAt(rooms, mid, line - 0.5) : roomAt(rooms, line - 0.5, mid);
    const after = horizontal ? roomAt(rooms, mid, line + 0.5) : roomAt(rooms, line + 0.5, mid);
    return { kind: wall, ...box, name: wallName(wall, before, after, horizontal) };
  });

  const slots = kind('slot').map((e) => {
    const facing = e.a['data-facing'];
    if (!FACINGS.has(facing)) fail(`slot ${e.a['data-zone']} ${e.a['data-slot']} has facing "${facing}"`);
    // Key order follows the Slot interface, so the JSON diffs cleanly.
    const slot = { zone: e.a['data-zone'], n: num(e, 'data-slot'), room: e.a['data-room'], u: gu(num(e, 'cx')), v: gv(num(e, 'cy')), facing };
    if (e.a['data-approach']) {
      const [x, y] = e.a['data-approach'].split(',').map(Number);
      slot.approach = { u: gu(x), v: gv(y) };
    }
    if (e.a['data-pair']) slot.pair = e.a['data-pair'];
    if (e.a['data-pair-side']) slot.side = e.a['data-pair-side'];
    if (e.a['data-queue'] === 'true') slot.queue = true;
    if (e.a['data-occupant']) slot.occupant = e.a['data-occupant'];
    if (e.a['data-prop']) slot.prop = e.a['data-prop'];
    return slot;
  });

  const nodes = kind('way').map((e) => ({ id: e.a['data-node'], u: gu(num(e, 'cx')), v: gv(num(e, 'cy')) }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = kind('edge').map((e) => {
    const from = byId.get(e.a['data-from']);
    const to = byId.get(e.a['data-to']);
    if (!from || !to) fail(`edge ${e.a['data-from']} → ${e.a['data-to']} names a missing node`);
    // The drawn line must run between its two nodes, or the data and the picture disagree.
    if (gu(num(e, 'x1')) !== from.u || gv(num(e, 'y1')) !== from.v || gu(num(e, 'x2')) !== to.u || gv(num(e, 'y2')) !== to.v) {
      fail(`edge ${from.id} → ${to.id} isn't drawn between its nodes`);
    }
    return e.a['data-door'] ? { from: from.id, to: to.id, door: e.a['data-door'] } : { from: from.id, to: to.id };
  });

  // The header states the counts; hold the file to them.
  const slotCount = svg.match(/SLOTS \((\d+)\)/)?.[1];
  if (slotCount && Number(slotCount) !== slots.length) fail(`header says ${slotCount} slots, found ${slots.length}`);
  const navCount = svg.match(/NAV GRAPH \((\d+) nodes, (\d+) edges\)/);
  if (navCount && (Number(navCount[1]) !== nodes.length || Number(navCount[2]) !== edges.length)) {
    fail(`header says ${navCount[1]} nodes and ${navCount[2]} edges, found ${nodes.length} and ${edges.length}`);
  }

  const headcount = Number(svg.match(/<svg\b[^>]*\sdata-headcount="(\d+)"/)?.[1] ?? NaN);
  return {
    _source: 'Generated by scripts/office-sync.mjs from ai-team-hq-design/specs/office-room.svg. Do not hand-edit; run npm run office:sync.',
    headcount: Number.isFinite(headcount) ? headcount : null,
    rooms,
    doors,
    barriers,
    slots,
    nav: { nodes, edges },
  };
}

/** Pretty JSON with one array item per line, so a moved seat is a one-line diff. */
function format(value, indent = '') {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => inner + JSON.stringify(v)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    return `{\n${Object.entries(value)
      .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${format(v, inner)}`)
      .join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

if (!existsSync(ROOM_SVG)) fail(`no office-room.svg at ${ROOM_SVG} (set OFFICE_DESIGN_DIR)`);
const sprites = syncSprites();
const zones = extract(readFileSync(ROOM_SVG, 'utf8'));
writeFileSync(ZONES_OUT, `${format(zones)}\n`);
console.log(
  `office:sync: ${sprites} sprites + palette.json → src/office/sprites/; zones.v3.json: ${zones.rooms.length} rooms, ` +
    `${zones.doors.length} doors, ${zones.barriers.length} barriers, ${zones.slots.length} slots, ` +
    `${zones.nav.nodes.length} nodes, ${zones.nav.edges.length} edges`,
);
