import { plainText } from './plainText';

/** What a report link points at: /api/projects/<pid>/workspaces/<agent>/report?file=<path>. */
export interface ReportUrlParts {
  pid: string;
  agent: string;
  /** Path under that desk's reports/ folder. */
  file: string;
}

const REPORT_PATH = /^\/api\/projects\/([^/]+)\/workspaces\/([a-z0-9_-]+)\/report$/i;

/**
 * Splits an HQ report link, or null when it is not one. The file is the one `file` query
 * parameter; other parameters are ignored. Bad %-encoding gives null, never a throw.
 */
export function parseReportUrl(url: string): ReportUrlParts | null {
  if (!url.startsWith('/api/projects/')) return null;
  let u: URL;
  try {
    u = new URL(url, 'http://hq');
  } catch {
    return null;
  }
  const m = REPORT_PATH.exec(u.pathname);
  if (!m) return null;
  let pid: string;
  try {
    pid = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  // Two file parameters would be ambiguous; the report route refuses them too.
  const files = u.searchParams.getAll('file');
  if (files.length !== 1) return null;
  const file = files[0];
  // URLSearchParams turns broken %-escapes into U+FFFD instead of failing.
  if (!file || file.includes('�')) return null;
  return { pid, agent: m[2], file };
}

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^[ \t]{0,3}#{1,3}[ \t]+(.+)$/;
const HEADING_MARK = /^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/;

/**
 * A report's title: its first heading (#, ## or ###), else its first line with text, as plain text.
 * Fenced code blocks are skipped first, so a "# comment" in a shell snippet is never the title.
 */
export function reportTitleFrom(text: string): string | null {
  const lines: string[] = [];
  let fence = '';
  for (const line of text.split(/\r?\n/)) {
    const m = FENCE.exec(line);
    if (fence) {
      // Closed by the same character, at least as long, with nothing after it. Unclosed runs to the end.
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = '';
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    lines.push(line);
  }
  for (const line of lines) {
    const heading = HEADING.exec(line)?.[1];
    const title = heading ? plainText(heading, 120) : '';
    if (title) return title;
  }
  for (const line of lines) {
    // An empty heading ("#") has no text of its own.
    const title = plainText(line.replace(HEADING_MARK, ''), 120);
    if (title) return title;
  }
  return null;
}
