import { parseSprite, type SpriteMeta } from './spriteText';

/**
 * The design team's pixel sprites (src/office/sprites/*.svg, copied by `npm run office:sync`).
 * Each file is read once as text and becomes a <symbol>, so the scene places them with <use>.
 * Browser only (Vite import.meta.glob); spriteText.ts reads the files, geometry.ts holds the parts tests need.
 */

export type { SpriteMeta };

const files = import.meta.glob('./sprites/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export const SPRITES: Record<string, SpriteMeta> = Object.fromEntries(
  Object.entries(files)
    .map(([path, svg]) => parseSprite(path, svg))
    .filter((s): s is SpriteMeta => s !== null)
    .map((s) => [s.name, s]),
);
