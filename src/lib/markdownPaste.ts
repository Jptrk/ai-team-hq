/**
 * Does pasted plain text look like markdown? Then the editor formats it instead of pasting
 * the stars and pipes as they are. Plain sentences, URLs and code-ish text stay as typed.
 */
const BLOCK = [
  /^#{1,6}\s+\S/m, // # Heading
  /^\s{0,3}[-*+]\s+\S/m, // - list
  /^\s{0,3}\d+[.)]\s+\S/m, // 1. list
  /^\s{0,3}>\s?\S/m, // > quote
  /^```/m, // code fence
  /^\s*\|.*\|\s*$\n^\s*\|?\s*:?-{3,}/m, // table header + separator
  /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m, // --- rule
  /^\s*[-*]\s+\[[ xX]\]\s/m, // - [ ] task
];
const INLINE = [
  /\*\*[^*\n]+\*\*/, // **bold**
  /(^|\s)_[^_\n]+_(?=\s|$|[.,;:!?])/, // _italic_
  /(^|\s)\*[^*\s][^*\n]*\*(?=\s|$|[.,;:!?])/, // *italic*
  /~~[^~\n]+~~/, // ~~strike~~
  /`[^`\n]+`/, // `code`
  /\[[^\]\n]+\]\((https?:\/\/|mailto:|#|\/)[^)\s]+\)/, // [link](url)
];

export function looksLikeMarkdown(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (BLOCK.some((re) => re.test(t))) return true;
  return INLINE.some((re) => re.test(t));
}

/**
 * Code, a diff or terminal output, which pastes as a code block and never as markdown
 * (a diff's "-" lines would turn into a list, and terminal output would lose its spacing).
 */
export function looksLikeDiffOrTerminal(text: string): boolean {
  const t = text.replace(/\r\n?/g, '\n');
  const lines = t.split('\n').filter((l) => l.trim());
  if (!lines.length) return false;
  // Every line is a diff line ("---" and "+++" start with - and +), with something added and removed.
  const diff =
    lines.length >= 2 &&
    lines.every((l) => /^(?:[+\- ]|@@|diff |index |new file mode|deleted file mode|\\ No newline)/.test(l)) &&
    lines.some((l) => l.startsWith('+')) &&
    lines.some((l) => l.startsWith('-'));
  if (diff) return true;
  // npm and yarn print "> name@1.2.3 script" first.
  if (/^> (?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+/.test(lines[0])) return true;
  // A shell prompt, a Python traceback or a JavaScript stack trace.
  if (/^(?:\$ |PS [A-Za-z]:\\)/m.test(t)) return true;
  return t.includes('Traceback (most recent call last)') || /^\s+at .+\(.+:\d+:\d+\)$/m.test(t);
}

/**
 * Backslash-escape only what would turn typed text into formatting when the markdown is read
 * again. Backslashes, &, < and > stay as typed, so "Q&A in C:\repo\src_x" is saved as it reads.
 */
export function escapeTypedText(text: string): string {
  const gap = (c: string | undefined) => c === undefined || /\s/.test(c);
  const word = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  // [ and ] only matter when they would make a link: [text](url) or [text][ref].
  const linkish = /\[[^\]]*\][([]/.test(text);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const prev = text[i - 1];
    const next = text[i + 1];
    const escape =
      c === '`' ||
      // 5 * 3 stays; a*b*c and *star* would be emphasis.
      (c === '*' && !(gap(prev) && gap(next))) ||
      // foo_bar and a_b.ts stay; _word_ and __init__ would be emphasis.
      (c === '_' && !(word(prev) && word(next))) ||
      // ~5 min and a ~ b stay; ~old~ would be struck through.
      (c === '~' && !(gap(prev) && gap(next)) && !/\d/.test(next ?? '')) ||
      ((c === '[' || c === ']') && linkish);
    out += escape ? `\\${c}` : c;
  }
  return out;
}

/**
 * Markdown the rich editor cannot keep as it is (images, raw HTML, footnotes). A description
 * like that is edited in the plain box, so saving never drops part of it.
 */
export function needsPlainEditor(md: string): boolean {
  return md.includes('![') || md.includes('[^') || /<\/?[a-z][\w-]*[\s>]/i.test(md);
}

/** Markdown longer than this is refused by the server for messages, comments and notes. */
export const TEXT_LIMIT = 2000;

const NBSP_LINE = /^[ \t]*(?:(?:&nbsp;|\u00a0)[ \t]*)+$/;

/**
 * Empty paragraphs (Enter pressed twice) save as "&nbsp;". Drop them and the blank lines at the
 * start, keeping one blank line between paragraphs. Code blocks stay as they are.
 */
function dropEmptyParagraphs(md: string): string {
  const kept: string[] = [];
  let code = false;
  for (const raw of md.split('\n')) {
    const line = !code && NBSP_LINE.test(raw) ? '' : raw;
    if (/^\s{0,3}(?:```|~~~)/.test(line)) code = !code;
    else if (!code && !line.trim() && (!kept.length || !kept[kept.length - 1].trim())) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** What the editor hands back: empty paragraphs, trailing blank lines, spaces and &nbsp; trimmed, and an empty box is "". */
export function cleanMarkdown(md: string): string {
  let out = dropEmptyParagraphs(md).replace(/(?:&nbsp;|\u00a0|\s)+$/g, '');
  // An empty last list item, task or quote line (Enter pressed once at the end) saves as a stray "-", "- [ ]" or ">".
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/\n[ \t]*(?:(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX]\])?|>)[ \t]*$/, '').replace(/(?:&nbsp;|\u00a0|\s)+$/g, '');
  }
  return out.trim() && out.replace(/&nbsp;|\u00a0/g, '').trim() ? out : '';
}
