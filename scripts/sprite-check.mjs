/**
 * The check office:sync runs on every sprite before it copies anything. The design folder is written by AI desks,
 * and the app puts each sprite's markup straight into the page, so only what build-sprites.js writes may pass:
 * the root <svg> tag, plain comments, and pixel-run <path fill="#rrggbb" d="M1 2h3v1h-3z"/> elements. Anything else
 * (a script, an on* handler, a link, foreignObject, style, an entity) fails the sync.
 *
 * Plain Node, no dependencies. office.test.ts tests it.
 */

const ROOT_ATTRS = {
  xmlns: /^http:\/\/www\.w3\.org\/2000\/svg$/,
  width: /^\d+(\.\d+)?$/,
  height: /^\d+(\.\d+)?$/,
  viewBox: /^-?\d+(\.\d+)?( -?\d+(\.\d+)?){3}$/,
  'shape-rendering': /^(crispEdges|auto|optimizeSpeed|geometricPrecision)$/,
};
/** data-sprite, data-tiles, data-anchor, data-scale: names and numbers only. */
const DATA_ATTR = /^data-[a-z]+(-[a-z]+)*$/;
const DATA_VALUE = /^[\w ,.:-]*$/;
const PATH_ATTRS = {
  fill: /^#[0-9a-fA-F]{6}$/,
  d: /^[MmHhVvLlZz0-9 ,.-]+$/,
  'fill-rule': /^(nonzero|evenodd)$/,
  'shape-rendering': /^(crispEdges|auto|optimizeSpeed|geometricPrecision)$/,
};

/** A tag's attributes, or null if the text between the name and the end isn't only name="value" pairs. */
function attributes(text) {
  if (!/^(\s+[\w:-]+="[^"<>&]*")*\s*$/.test(text)) return null;
  return [...text.matchAll(/\s([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]);
}

/** Why this sprite file is not safe to put in the page, or null when it's only pixel-run paths. */
export function spriteProblem(svg) {
  const text = svg.replace(/^﻿/, '');
  const open = text.match(/^\s*<svg\b([^<>]*)>/);
  if (!open) return 'it does not start with an <svg> tag';
  const root = attributes(open[1]);
  if (!root) return 'its <svg> tag is not plain name="value" attributes';
  for (const [name, value] of root) {
    const rule = ROOT_ATTRS[name] ?? (DATA_ATTR.test(name) ? DATA_VALUE : null);
    if (!rule) return `its <svg> tag has a ${name} attribute`;
    if (!rule.test(value)) return `its <svg> tag has ${name}="${value.slice(0, 40)}"`;
  }
  const end = text.lastIndexOf('</svg>');
  if (end < open[0].length) return 'it has no closing </svg>';
  if (text.slice(end + 6).trim()) return 'there is something after </svg>';

  let rest = text.slice(open[0].length, end);
  // Comments: plain text only. No "--" inside, so "--!>" and other early ends can't hide markup.
  rest = rest.replace(/<!--(?:[^<>-]|-(?!-))*-->/g, '');
  let problem = null;
  rest = rest.replace(/<path\b([^<>]*?)\s*\/>/g, (_m, attrs) => {
    const list = attributes(attrs);
    if (!list) problem ??= 'a <path> is not plain name="value" attributes';
    for (const [name, value] of list ?? []) {
      const rule = PATH_ATTRS[name];
      if (!rule) problem ??= `a <path> has a ${name} attribute`;
      else if (!rule.test(value)) problem ??= `a <path> has ${name}="${value.slice(0, 40)}"`;
    }
    return '';
  });
  if (problem) return problem;
  const left = rest.trim();
  if (left) return `it has something besides <path> elements and comments: "${left.slice(0, 40)}"`;
  return null;
}
