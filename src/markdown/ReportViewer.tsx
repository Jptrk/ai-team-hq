import { ArrowLeft, Check, Copy, ExternalLink, FileText, Maximize2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { KEYS, storage } from '../lib/storage';
import { Modal } from '../shell/Modal';
import { Segmented } from '../ui/Segmented';
import { Markdown } from './Markdown';
import { reportFileName } from './reportLinks';

type ViewMode = 'preview' | 'raw';

// Keyed by `${url}@${version}`, so a revised file (same URL, new version) loads again.
const cache = new Map<string, string>();
const cacheKey = (url: string, version: string) => `${url}@${version}`;

/** Keep one version per URL: drop the older texts of this report. */
function remember(url: string, version: string, text: string): void {
  for (const k of cache.keys()) if (k.slice(0, k.lastIndexOf('@')) === url) cache.delete(k);
  cache.set(cacheKey(url, version), text);
}

function readMode(): ViewMode {
  return storage.get(KEYS.reportView) === 'raw' ? 'raw' : 'preview';
}

/**
 * A report file: formatted preview or raw markdown, copy, open raw, and a wide reader.
 * `embedded`: shown inside the reports reader, which is already full size, so no Expand.
 * `version`: when the file last changed (e.g. its updatedAt); a new one loads the text again.
 */
export function ReportViewer({ url, embedded, version }: { url: string; embedded?: boolean; version?: string | null }) {
  const [stack, setStack] = useState<string[]>([url]);
  const current = stack[stack.length - 1];
  // The version belongs to the report itself, not to reports opened from its links.
  const currentVersion = current === url ? (version ?? '') : '';
  const [text, setText] = useState<string | null>(cache.get(cacheKey(current, currentVersion)) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setModeState] = useState<ViewMode>(readMode);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'blocked'>('idle');
  const [wide, setWide] = useState(false);

  useEffect(() => {
    setStack([url]);
  }, [url]);

  useEffect(() => {
    let live = true;
    setError(null);
    const hit = cache.get(cacheKey(current, currentVersion));
    if (hit !== undefined) {
      setText(hit);
      return;
    }
    setText(null);
    api.report(current).then(
      (t) => {
        remember(current, currentVersion, t);
        if (live) setText(t);
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : 'Could not load the report'),
    );
    return () => {
      live = false;
    };
  }, [current, currentVersion]);

  const setMode = (m: ViewMode) => {
    setModeState(m);
    storage.set(KEYS.reportView, m);
  };

  // A failed copy only shows a note; the report stays on screen.
  const copyText = async () => {
    if (text === null) return;
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ok = false;
    }
    setCopy(ok ? 'copied' : 'blocked');
    window.setTimeout(() => setCopy('idle'), ok ? 1600 : 3000);
  };

  const openReport = useCallback((u: string) => setStack((s) => [...s, u]), []);
  const name = reportFileName(current);

  const body =
    error !== null ? (
      <p className="banner danger">{error}</p>
    ) : text === null ? (
      <p className="muted small">Loading {name}...</p>
    ) : mode === 'preview' ? (
      <Markdown source={text} baseUrl={current} onOpenReport={openReport} />
    ) : (
      <pre className="report-raw">{text}</pre>
    );

  const toolbar = (inModal: boolean) => (
    <div className="report-bar">
      <span className="report-name">
        <FileText size={14} aria-hidden />
        <span className="mono">{name}</span>
      </span>
      <Segmented
        as="tabs"
        label="Report view"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'preview', label: 'Preview' },
          { value: 'raw', label: 'Raw' },
        ]}
      />
      <span className="report-actions">
        <button type="button" className="icon-btn sm" onClick={() => void copyText()} title="Copy markdown" aria-label="Copy markdown">
          {copy === 'copied' ? <Check size={15} /> : <Copy size={15} />}
        </button>
        <a className="icon-btn sm" href={current} target="_blank" rel="noopener noreferrer" title="Open raw file in a new tab" aria-label="Open raw file in a new tab">
          <ExternalLink size={15} />
        </a>
        {!inModal && (
          <button type="button" className="icon-btn sm" onClick={() => setWide(true)} title="Open in the reader" aria-label="Open in the reader">
            <Maximize2 size={15} />
          </button>
        )}
      </span>
      <span className={copy === 'blocked' ? 'report-note' : 'sr-only'} aria-live="polite">
        {copy === 'copied' ? 'Copied' : copy === 'blocked' ? 'Copy was blocked by the browser' : ''}
      </span>
    </div>
  );

  return (
    <div className={`report${embedded ? ' embedded' : ''}`}>
      {toolbar(Boolean(embedded))}
      {stack.length > 1 && (
        <button type="button" className="link-btn report-back" onClick={() => setStack((s) => s.slice(0, -1))}>
          <ArrowLeft size={13} /> Back to {reportFileName(stack[stack.length - 2])}
        </button>
      )}
      <div className={`report-body${embedded ? ' reader' : ''}`}>{body}</div>
      {!embedded && (
        <Modal open={wide} onClose={() => setWide(false)} title={name} size="wide">
          {toolbar(true)}
          <div className="report-body reader">{body}</div>
        </Modal>
      )}
    </div>
  );
}
