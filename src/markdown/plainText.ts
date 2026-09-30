/** Markdown to one tidy line, for previews (thread list, inbox rows, search). */
export function plainText(md: string, max = 160): string {
  let s = md;
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '');
  s = s.replace(/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, ' ');
  s = s.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, ' ');
  s = s.replace(/\s*\|\s*/g, ' · ');
  s = s.replace(/(\*\*|__|~~)(.+?)\1/g, '$2');
  s = s.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
  s = s.replace(/\s+/g, ' ').replace(/(?:\s*·\s*)+/g, ' · ').replace(/^[\s·]+|[\s·]+$/g, '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s·,;:]+$/, '')}…`;
}
