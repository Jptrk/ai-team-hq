import { ExternalLink, Image as ImageIcon } from 'lucide-react';
import { memo, useMemo, useRef, type MutableRefObject } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import { isReportUrl, resolveReportHref } from './reportLinks';
import { remarkHtmlAsText } from './remarkHtmlAsText';

/**
 * Safe markdown: GitHub-style tables, task lists and strikethrough. Raw HTML shows as text,
 * javascript: links are dropped, images never load, and #anchors scroll inside the text
 * instead of changing the app's route.
 */

export interface MarkdownProps {
  source: string;
  /** compact: tighter spacing and smaller headings, for chat. */
  variant?: 'prose' | 'compact';
  /** Keep single line breaks (chat, summaries). */
  breaks?: boolean;
  /** The report's own URL; relative .md links resolve against it. */
  baseUrl?: string;
  onOpenReport?: (url: string) => void;
}

interface Ctx {
  baseUrl?: string;
  onOpenReport?: (url: string) => void;
  root: MutableRefObject<HTMLDivElement | null>;
}

const REMARK = [remarkGfm, remarkHtmlAsText];
const REHYPE: NonNullable<Parameters<typeof ReactMarkdown>[0]['rehypePlugins']> = [[rehypeSlug, { prefix: 'md-' }]];

function makeComponents(ctx: MutableRefObject<Ctx>): Components {
  return {
    a({ node: _node, href = '', children, ...rest }) {
      void rest;
      if (href.startsWith('#')) {
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              let id = href.slice(1);
              try {
                id = decodeURIComponent(id);
              } catch {
                /* keep */
              }
              const root = ctx.current.root.current;
              const target = root?.querySelector(`[id="md-${CSS.escape(id)}"]`) ?? root?.querySelector(`[id="${CSS.escape(id)}"]`);
              target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }}
          >
            {children}
          </a>
        );
      }
      if (/^(https?:|mailto:)/i.test(href)) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
            <ExternalLink size={11} className="md-ext" aria-hidden />
          </a>
        );
      }
      const { baseUrl, onOpenReport } = ctx.current;
      const report = baseUrl ? resolveReportHref(baseUrl, href) : isReportUrl(href) ? href : null;
      if (report && onOpenReport) {
        return (
          <a
            href={report}
            onClick={(e) => {
              e.preventDefault();
              onOpenReport(report);
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <span className="md-dead-link" title={href || undefined}>
          {children}
        </span>
      );
    },
    img({ node: _node, src, alt }) {
      const text = alt || 'image';
      const url = typeof src === 'string' ? src : '';
      return /^https?:/i.test(url) ? (
        <a className="md-img" href={url} target="_blank" rel="noopener noreferrer" title="Images are not loaded. Opens in a new tab.">
          <ImageIcon size={12} aria-hidden /> {text}
        </a>
      ) : (
        <span className="md-img">
          <ImageIcon size={12} aria-hidden /> {text}
        </span>
      );
    },
    table({ node: _node, children, ...rest }) {
      return (
        <div className="md-table-wrap" role="region" aria-label="Table" tabIndex={0}>
          <table {...rest}>{children}</table>
        </div>
      );
    },
    input({ node: _node, ...rest }) {
      return <input {...rest} disabled />;
    },
  };
}

function MarkdownImpl({ source, variant = 'prose', breaks, baseUrl, onOpenReport }: MarkdownProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const ctx = useRef<Ctx>({ baseUrl, onOpenReport, root });
  ctx.current = { baseUrl, onOpenReport, root };
  const components = useMemo(() => makeComponents(ctx), []);
  return (
    <div ref={root} className={`md md-${variant}${breaks ? ' md-breaks' : ''}`}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

/** Re-renders only when the text changes, so the 3-second poll doesn't redo the parse. */
export const Markdown = memo(
  MarkdownImpl,
  (a, b) => a.source === b.source && a.variant === b.variant && a.breaks === b.breaks && a.baseUrl === b.baseUrl && a.onOpenReport === b.onOpenReport,
);
