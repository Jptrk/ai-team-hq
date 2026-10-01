/** Is this an HQ report URL, like /api/projects/<pid>/workspaces/<agent>/report?file=...? */
export function isReportUrl(url: string): boolean {
  return /^\/api\/projects\/[^/]+\/workspaces\/[^/]+\/report\?/.test(url);
}

/** Is this an image you pasted, served by HQ itself? Only these are ever shown as <img>. */
export function isAttachmentUrl(url: string): boolean {
  return /^\/api\/projects\/[^/?#]+\/attachments\/att_[a-f0-9]{12}\.(png|jpg|webp|gif)$/.test(url);
}

/** Where HQ serves an attachment. */
export function attachmentUrl(pid: string, file: string): string {
  return `/api/projects/${encodeURIComponent(pid)}/attachments/${encodeURIComponent(file)}`;
}

/** File name shown for a report URL. */
export function reportFileName(url: string): string {
  try {
    const file = new URL(url, 'http://hq').searchParams.get('file') ?? '';
    return file.split('/').pop() || file || 'report';
  } catch {
    return 'report';
  }
}

/**
 * A link inside a report, resolved against that report's URL.
 * "plan.md", "./plan.md", "../notes/x.md" stay inside the same agent's reports folder.
 * Returns null for anything that is not another report (http, anchors, absolute paths).
 */
export function resolveReportHref(baseUrl: string, href: string): string | null {
  if (isReportUrl(href)) return href;
  if (!href || href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const pathOnly = href.split('#')[0].split('?')[0];
  if (!/\.(md|markdown|txt)$/i.test(pathOnly)) return null;
  let base: URL;
  try {
    base = new URL(baseUrl, 'http://hq');
  } catch {
    return null;
  }
  const file = base.searchParams.get('file');
  if (!file) return null;
  const segments = file.split('/').slice(0, -1);
  for (const seg of pathOnly.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!segments.length) return null;
      segments.pop();
    } else {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        /* keep as written */
      }
      segments.push(decoded);
    }
  }
  base.searchParams.set('file', segments.join('/'));
  return `${base.pathname}?${base.searchParams.toString()}`;
}
