/**
 * The office floor as data. Built by layout.ts from the design team's spec (office-room.svg v3 and the
 * §9.2 growth rules), drawn by OfficeScene.tsx. Pure data: no React, no sprite imports, so tests run in Node.
 *
 * Coordinates are GRID units (u, v): tile (u, v) spans u..u+1, v..v+1. The flat spec's 48-unit tiles at
 * origin (40, 96) map as u = (x − 40) / 48, v = (y − 96) / 48. Isometric is applied only when drawing:
 * screen x = OX + (u − v) · 32, screen y = OY + (u + v) · 16.
 */

/** Rooms are places. Zones (below) are activities; one zone can use slots in more than one room. */
export type Room = 'office' | 'play' | 'hall' | 'founder' | 'meeting' | 'kitchen';

/** The four edges of a tile: v0 back (top-right), u0 left (top-left), v1 front, u1 front-right. */
export type Edge = 'u0' | 'u1' | 'v0' | 'v1';

/** One sprite on the floor. Its footprint starts at tile (gx, gy); fractional values are allowed (wall posts). */
export interface Placement {
  /** File name without .svg in src/office/sprites/, e.g. "desk", "floor-office-a", "low-wall-u0". */
  sprite: string;
  gx: number;
  gy: number;
  /** Footprint in tiles, as the sprite's data-tiles says (1×1 when absent). */
  fu: number;
  fv: number;
}

export interface RoomRect {
  room: Room;
  /** Tile bounds: u0..u0+w, v0..v0+d. The hall is two rects (spine and queue row). */
  u0: number;
  v0: number;
  w: number;
  d: number;
}

export type Facing = 'N' | 'E' | 'S' | 'W';
export type SlotZone = 'desks' | 'meeting' | 'founder' | 'lounge';

/** Where a person can be: the centre of a tile, in grid units (a slot at tile (1,1) is u 1.5, v 1.5). */
export interface Slot {
  zone: SlotZone;
  /** 1-based and frozen: numbers never change for existing slots; new ones are appended (spec §9.2). */
  n: number;
  room: Room;
  u: number;
  v: number;
  facing: Facing;
  /** Seated slots are reached from here (couch, bench). */
  approach?: { u: number; v: number };
  /** Meeting slots: the pair a chat sits in, and which side (a/b). */
  pair?: string;
  side?: 'a' | 'b';
  /** Founder zone: slots 4+ are the queue. */
  queue?: boolean;
  /** The founder's own chair. */
  occupant?: 'founder';
  /** The furniture it belongs to: desk, couch, billiards, arcade, coffee, bench, huddle, founder-desk. */
  prop?: string;
}

export interface RoomLabel {
  room: Room;
  text: string;
  /** Centre of the text in grid units (drawn upright in screen space). */
  u: number;
  v: number;
}

export interface NavNode {
  id: string;
  u: number;
  v: number;
}

export interface NavEdge {
  from: string;
  to: string;
  /** The room whose doorway this edge passes through. */
  door?: Room;
}

/** A wall segment as an obstacle, in grid units, for the route check (not for drawing). */
export interface Barrier {
  kind: 'full' | 'low' | 'prop';
  /** Axis-aligned rectangle in grid units. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** What it is, for messages: "desks-pod-1", "wall founder back", ... */
  name: string;
}

export interface OfficeLayout {
  /** Number of desks this floor was built for (teammates, not counting the founder). */
  desks: number;
  /** Floor size in tiles (bounding box). */
  cols: number;
  rows: number;
  rooms: RoomRect[];
  /** Floor tiles, one per walkable tile, already a/b checkerboarded per room. */
  floor: Placement[];
  /** Walls, doorway walls, windows and low-wall posts. */
  walls: Placement[];
  /** Desks, tables, chairs, sofa, arcade, plants, rug, bench, bookshelf, coffee machine... */
  furniture: Placement[];
  slots: Slot[];
  labels: RoomLabel[];
  /** The founder's door: grid point of the middle of the doorway's front edge. The lamp sits at the top of the wall above it. */
  door: { u: number; v: number };
  /** Top-left of the off-shift strip (outside the floor, in front of the play area), in grid units. */
  offShift: { u: number; v: number };
  nav: { nodes: NavNode[]; edges: NavEdge[] };
  /** Walls and furniture as obstacles, for the route check. */
  barriers: Barrier[];
}
