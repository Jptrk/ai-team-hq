/**
 * The pixel person from the approved Figma frame (ATHD-18, 109:2): 10×16 art pixels drawn at 2×,
 * bottom-centred 4 px below the tile centre. Hair and skin come from the Round 9 options; the shirt is the
 * desk's own colour muted 45% toward grey (look B, Round 8), so people stay apart at a glance.
 */

export const PERSON_W = 20;
export const PERSON_H = 32;
/** Person bottom sits this far below the tile centre. */
export const PERSON_DROP = 4;

const MAP = [
  '...OOOO...',
  '..OHHHHO..',
  '.OHHHHHHO.',
  '.OHSSSSHO.',
  '.OSESSESO.',
  '.OSSSSSSO.',
  '..OSSSSO..',
  '.OTTTTTTO.',
  'OTTTTTTTTO',
  'OSTTTTTTSO',
  '.OTTTTTTO.',
  '.OPPPPPPO.',
  '.OPPOOPPO.',
  '.OPPOOPPO.',
  '.OBBOOBBO.',
  '..OO..OO..',
];

const HAIR = ['#403024', '#1f1c1f', '#9e5429'];
const SKIN = ['#f2cca6', '#d19e75', '#9e6e4d'];
const FIXED: Record<string, string> = { O: '#261f24', E: '#141416', P: '#45454f', B: '#242126' };

export interface PixelRun {
  x: number;
  y: number;
  w: number;
  fill: string;
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** Mix a hex colour toward another by t (0..1). */
export function mix(hex: string, toward: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#8c8c8c');
  const b = p(toward);
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** The colours for one person: steady per id, so a desk always looks the same. */
export function personColours(id: string, colour: string): Record<string, string> {
  const h = hash(id);
  return { ...FIXED, H: HAIR[h % 3], S: SKIN[Math.floor(h / 3) % 3], T: mix(colour, '#8c8c8c', 0.45) };
}

/** Horizontal pixel runs in screen pixels, relative to the person's top-left. */
export function personRuns(colours: Record<string, string>): PixelRun[] {
  const runs: PixelRun[] = [];
  MAP.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === '.') {
        x++;
        continue;
      }
      let end = x;
      while (end + 1 < row.length && row[end + 1] === ch) end++;
      runs.push({ x: x * 2, y: y * 2, w: (end - x + 1) * 2, fill: colours[ch] });
      x = end + 1;
    }
  });
  return runs;
}
