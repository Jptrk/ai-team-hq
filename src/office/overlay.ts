import { textWidth, toScreen, type Box } from './geometry';
import { PERSON_DROP, PERSON_H, PERSON_W, personColours, personRuns } from './person';
import type { OfficeLayout } from './types';

/**
 * Screen boxes for what the scene draws over the room: people, their pins (status tag and name pill), the
 * area that takes the pointer, and the off-shift chips. Pure, so placement can keep pins off the people
 * waiting on you and the tests can check it. Screen pixels at 1×, the room's top corner at (0, 0).
 */

export const TAG_W = 34;
export const TAG_H = 32;
export const PILL_H = 14;

/** A spot to stand on, in grid units. */
type Spot = { u: number; v: number };

export function nameWidth(name: string): number {
  return Math.round(name.length * 5.6) + 8;
}

/** Head-top centre for someone on a slot. */
export function headOf(s: Spot): { x: number; y: number } {
  const c = toScreen(s.u, s.v);
  return { x: Math.round(c.x), y: Math.round(c.y + PERSON_DROP - PERSON_H) };
}

/** The person sprite. */
export function personBox(s: Spot): Box {
  const h = headOf(s);
  return { x0: h.x - PERSON_W / 2, y0: h.y, x1: h.x + PERSON_W / 2, y1: h.y + PERSON_H };
}

/** The status tag (the founder has none) and the name pill above it. */
export function pinBoxes(s: Spot, name: string, tagged: boolean): { tag: Box | null; pill: Box } {
  const h = headOf(s);
  const tagTop = h.y - 2 - TAG_H;
  const w = nameWidth(name);
  const pillTop = (tagged ? tagTop : h.y - 2) - 1 - PILL_H;
  return {
    tag: tagged ? { x0: h.x - TAG_W / 2, y0: tagTop, x1: h.x + TAG_W / 2, y1: tagTop + TAG_H } : null,
    pill: { x0: h.x - w / 2, y0: pillTop, x1: h.x + w / 2, y1: pillTop + PILL_H },
  };
}

/** What takes the pointer and shows the focus ring: the person, the tag and the name above. */
export function hitBox(s: Spot): Box {
  const h = headOf(s);
  return { x0: h.x - PERSON_W / 2 - 8, y0: h.y - 2 - TAG_H - 1 - PILL_H, x1: h.x + PERSON_W / 2 + 8, y1: h.y + PERSON_H + 6 };
}

/** Boxes that share some area; touching edges don't count. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// Everyone has the same outline, so one set of opaque pixels (relative to the sprite's top-left) serves all.
const PERSON_PIXELS: { x: number; y: number }[] = [];
for (const r of personRuns(personColours('', '#8c8c8c'))) for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + 2; y++) PERSON_PIXELS.push({ x, y });

/** A pin may clip this many of a person's pixels (a corner of hair) before it counts as covering them. */
export const COVER_PX = 16;

/** How many of the person on `o`'s pixels these boxes hide. */
export function hiddenPixels(boxes: (Box | null)[], o: Spot): number {
  const p = personBox(o);
  const hits = boxes.filter((b): b is Box => b !== null && overlaps(b, p));
  if (!hits.length) return 0;
  let n = 0;
  for (const { x, y } of PERSON_PIXELS) {
    const sx = p.x0 + x;
    const sy = p.y0 + y;
    if (hits.some((b) => sx >= b.x0 && sx < b.x1 && sy >= b.y0 && sy < b.y1)) n++;
  }
  return n;
}

/** Would the pin of someone named `name` standing on `s` cover any of these people? */
export function pinCovers(s: Spot, name: string, others: Spot[]): boolean {
  const { tag, pill } = pinBoxes(s, name, true);
  return others.some((o) => hiddenPixels([tag, pill], o) > COVER_PX);
}

// ---------- room labels ----------

export const LABEL_PX = 12;

/**
 * Room labels as drawn: upright text outside the floor, `x` its left end and `y` its baseline. The founder's label
 * names you, and starts where "PATRICK'S ROOM" starts in the design, so a longer name grows away from the floor.
 */
export function labelSpots(layout: OfficeLayout, ownerName: string): { key: string; text: string; x: number; y: number; box: Box }[] {
  return layout.labels.map((l) => {
    const c = toScreen(l.u, l.v);
    const founder = l.room === 'founder';
    const text = founder ? `${ownerName.toUpperCase()}’S ROOM` : l.text;
    const w = textWidth(text, LABEL_PX);
    const x = founder ? c.x - textWidth('PATRICK’S ROOM', LABEL_PX) / 2 : c.x - w / 2;
    return { key: `l-${l.room}-${l.u}-${l.v}`, text, x: Math.round(x), y: Math.round(c.y + 4), box: { x0: x, y0: c.y - 9, x1: x + w, y1: c.y + 9 } };
  });
}

// ---------- off shift ----------

/** Chips per column before the strip wraps into the next one (spec §1: unlimited, wraps). */
export const OFF_PER_COLUMN = 3;
export const CHIP_GAP = 34;
const COLUMN_GAP = 14;
const NAME_PX = 10;

export interface ChipSpot {
  x: number;
  y: number;
  /** The column's width: chip plus its longest name or return time. */
  w: number;
  h: number;
  /** Text baselines: the name beside the chip (Figma 109:2), the return time under it. */
  name: { x: number; y: number };
  back: { x: number; y: number } | null;
  /** What it actually draws (the chip, then each line of text from its top to just under the baseline). */
  parts: Box[];
}

/** Where a chip's name and return time go, and what it draws. */
function chipAt(x: number, y: number, chip: { w: number; h: number }, o: { name: string; back: string | null }): Pick<ChipSpot, 'name' | 'back' | 'parts'> {
  const tx = x + chip.w + 6;
  const name = { x: tx, y: o.back ? y + 12 : y + 17.5 };
  const back = o.back ? { x: tx, y: y + 24 } : null;
  const parts: Box[] = [{ x0: x, y0: y, x1: x + chip.w, y1: y + chip.h }, { x0: tx, y0: name.y - 8, x1: tx + textWidth(o.name, NAME_PX), y1: name.y + 2 }];
  if (back && o.back) parts.push({ x0: tx, y0: back.y - 7, x1: tx + textWidth(o.back, 9), y1: back.y + 2 });
  return { name, back, parts };
}

/** Does this box cover any floor tile? Each tile is a diamond; touching an edge doesn't count. */
export function onFloor(layout: OfficeLayout, b: Box): boolean {
  for (const t of layout.floor) {
    const c = toScreen(t.gx + 0.5, t.gy + 0.5);
    // The diamond is |x − cx| / 32 + |y − cy| / 16 < 1; the box's nearest point to the centre decides.
    const dx = Math.max(b.x0 - c.x, 0, c.x - b.x1);
    const dy = Math.max(b.y0 - c.y, 0, c.y - b.y1);
    if (dx / 32 + dy / 16 < 1) return true;
  }
  return false;
}

/**
 * Where each off-shift chip goes: down from the strip's corner (Figma 109:2), three to a column, then the next
 * column to the right, each as wide as its longest name. A column moves down until no chip touches the floor or a
 * room label (`avoid`), so the strip always stays outside the room. In the first column, Figma's, a name may run
 * along the play area's front edge as it does in the design; a later column's names clear the floor too.
 */
export function offShiftSpots(layout: OfficeLayout, chips: { name: string; back: string | null }[], chip: { w: number; h: number }, avoid: Box[] = []): ChipSpot[] {
  const start = toScreen(layout.offShift.u, layout.offShift.v);
  const out: ChipSpot[] = [];
  let x = Math.round(start.x);
  for (let c = 0; c * OFF_PER_COLUMN < chips.length; c++) {
    const column = chips.slice(c * OFF_PER_COLUMN, (c + 1) * OFF_PER_COLUMN);
    const w = chip.w + 6 + Math.max(...column.map((o) => Math.max(textWidth(o.name, NAME_PX), o.back ? textWidth(o.back, 9) : 0))) + 8;
    const lay = (y: number) => column.map((o, i) => ({ x, y: y + i * CHIP_GAP, w, h: chip.h, ...chipAt(x, y + i * CHIP_GAP, chip, o) }));
    // parts[0] is the chip itself; the rest are its text.
    const blocked = (spots: ChipSpot[]) => spots.some((s) => s.parts.some((p, k) => ((k === 0 || c > 0) && onFloor(layout, p)) || avoid.some((a) => overlaps(a, p))));
    let y = Math.round(start.y);
    // Two pixels a step, a few hundred at most: the floor ends within its own height.
    for (let i = 0; i < 400 && blocked(lay(y)); i++) y += 2;
    out.push(...lay(y));
    x += w + COLUMN_GAP;
  }
  return out;
}
