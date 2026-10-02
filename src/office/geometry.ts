import type { Placement } from './types';

/**
 * Grid to screen, 2:1 isometric with 64×32 tiles (spec Round 1). The scene works with the room's top
 * corner at (0, 0) and lets the SVG viewBox frame whatever ends up on screen.
 */

export const TILE_W = 64;
export const TILE_H = 32;

export function toScreen(u: number, v: number): { x: number; y: number } {
  return { x: (u - v) * (TILE_W / 2), y: (u + v) * (TILE_H / 2) };
}

/** Where a sprite's top-left goes: its anchor sits on the footprint's front corner (sprite README). */
export function spriteBox(p: Placement, anchor: { ax: number; ay: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const c = toScreen(p.gx + p.fu, p.gy + p.fv);
  return { x: Math.round(c.x - anchor.ax * 2), y: Math.round(c.y - anchor.ay * 2), w: anchor.w, h: anchor.h };
}

/**
 * Painter's order. Things sort by their footprint's front corner, nearest the viewer last. On a tie,
 * walls draw before furniture and furniture before people, so a desk's chair never covers its owner
 * and a knee wall still hides the legs of someone standing behind it.
 */
export const LAYER = { wall: 0, furniture: 1, person: 2 } as const;

export function depthOf(p: Pick<Placement, 'gx' | 'gy' | 'fu' | 'fv'>): number {
  return p.gx + p.fu + p.gy + p.fv;
}

/** A person standing on the tile under (u, v). */
export function personDepth(u: number, v: number): number {
  return Math.floor(u) + 1 + Math.floor(v) + 1;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function grow(box: Box, x: number, y: number, w = 0, h = 0): void {
  box.x0 = Math.min(box.x0, x);
  box.y0 = Math.min(box.y0, y);
  box.x1 = Math.max(box.x1, x + w);
  box.y1 = Math.max(box.y1, y + h);
}

/** Rough text width for layout: the labels are short, bold and caps. */
export function textWidth(text: string, px: number): number {
  return Math.ceil(text.length * px * 0.62);
}
