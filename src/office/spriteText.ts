/**
 * Reading a sprite file's text (sprites.ts loads the files; this part is pure, so tests run it in Node).
 * office:sync already refuses anything but pixel-run paths (scripts/sprite-check.mjs). As a second fence the body
 * that reaches the page is rebuilt here from each <path>'s checked fill and d, so nothing else can get through.
 */

export interface SpriteMeta {
  name: string;
  /** Art-pixel canvas. */
  viewBox: string;
  /** Screen size (art × 2). */
  w: number;
  h: number;
  /** Anchor in art pixels: the bottom vertex of the footprint (UI pieces: bottom of the stem; chips: top-left). */
  ax: number;
  ay: number;
  /** The SVG's inner markup: only pixel-run paths in palette colours, rebuilt by safeBody. */
  body: string;
}

const SAFE_ATTRS: Record<string, RegExp> = {
  fill: /^#[0-9a-fA-F]{6}$/,
  d: /^[MmHhVvLlZz0-9 ,.-]+$/,
  'fill-rule': /^(nonzero|evenodd)$/,
};

/** Every <path>, rebuilt from the attributes above. Anything else in the file is dropped. */
export function safeBody(inner: string): string {
  const out: string[] = [];
  for (const m of inner.matchAll(/<path\b([^<>]*?)\/?>/g)) {
    const attrs = [...m[1].matchAll(/\s([\w:-]+)="([^"]*)"/g)].filter(([, k, v]) => SAFE_ATTRS[k]?.test(v)).map(([, k, v]) => `${k}="${v}"`);
    if (attrs.some((a) => a.startsWith('d='))) out.push(`<path ${attrs.join(' ')}/>`);
  }
  return out.join('');
}

function attr(svg: string, name: string): string | undefined {
  return svg.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

export function parseSprite(path: string, svg: string): SpriteMeta | null {
  const name = path.replace(/^.*\/(.+)\.svg$/, '$1');
  const open = svg.match(/<svg\b[^>]*>/)?.[0];
  if (!open) return null;
  const [ax, ay] = (attr(open, 'data-anchor') ?? '0,0').split(',').map(Number);
  const inner = svg.slice(svg.indexOf(open) + open.length, svg.lastIndexOf('</svg>'));
  return {
    name,
    viewBox: attr(open, 'viewBox') ?? '0 0 0 0',
    w: Number(attr(open, 'width') ?? 0),
    h: Number(attr(open, 'height') ?? 0),
    ax: ax || 0,
    ay: ay || 0,
    body: safeBody(inner),
  };
}
