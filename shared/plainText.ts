// Characters markdown lets you escape with a backslash. Older saved text has them escaped (C:\\repo, a\_b).
const ESCAPABLE = '\\`*_[]~#>+-';
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/** Markdown to one tidy line, for previews (thread list, inbox rows, search). */
export function plainText(md: string, max = 160): string {
  let s = md;
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // Hide escaped characters so the rules below leave them alone; they come back as plain characters at the end.
  s = s.replace(/\\([\\`*_[\]~#>+-])/g, (_, c: string) => String.fromCharCode(0xe000 + ESCAPABLE.indexOf(c)));
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
  s = s.replace(/[\ue000-\ue00a]/g, (c) => ESCAPABLE[c.charCodeAt(0) - 0xe000]);
  s = s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name]);
  s = s.replace(/\s+/g, ' ').replace(/(?:\s*·\s*)+/g, ' · ').replace(/^[\s·]+|[\s·]+$/g, '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s·,;:]+$/, '')}…`;
}

/**
 * A plain title for a new ticket ('task') or chat thread: code blocks are dropped, then a ticket
 * takes the first line with words in it and a thread all of the text. With no words, the title
 * says there are images, or is a stand-in.
 */
export function titleFrom(text: string, attachments: number, max: number, kind: 'task' | 'thread' = 'task'): string {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, '\n');
  const words =
    kind === 'task'
      ? prose
          .split(/\r?\n/)
          .map((line) => plainText(line, max))
          .find(Boolean) || plainText(prose, max)
      : plainText(prose, max);
  if (words) return words;
  if (kind === 'thread') return attachments ? 'Image from you' : 'New thread';
  if (!attachments) return 'New task';
  return attachments > 1 ? 'Look at the attached images' : 'Look at the attached image';
}
