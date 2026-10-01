import { ChevronRight, ExternalLink, FileText, Link as LinkIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { Agent, ReportInfo, WorkItem } from '../../shared/types';
import { api } from '../api';
import { ReportViewer } from '../markdown/ReportViewer';
import { isReportUrl } from '../markdown/reportLinks';
import { Modal } from '../shell/Modal';
import { Avatar } from '../ui/Avatar';
import { agentById, timeAgo } from '../util';

interface Props {
  pid: string;
  item: WorkItem;
  agents: Agent[];
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

/** A ticket's reports as a list (title, desk, last change, size), opening a full-size reader. */
export function ReportList({ pid, item, agents }: Props) {
  // One row per report URL, like the server's list.
  const reportLinks = useMemo(() => {
    const seen = new Set<string>();
    return item.links.filter((l) => {
      if (!isReportUrl(l.url) || seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });
  }, [item.links]);
  const otherLinks = useMemo(() => item.links.filter((l) => !isReportUrl(l.url)), [item.links]);
  const key = reportLinks.map((l) => l.url).join('|');
  const lastChange = item.history.at(-1)?.ts;
  const [reports, setReports] = useState<ReportInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openUrl, setOpenUrl] = useState<string | null>(null);

  // Load the details when the links change, or the ticket moves on (a desk may have revised a report).
  // The 3-second poll alone does not refetch.
  useEffect(() => {
    if (!key) {
      setReports([]);
      return;
    }
    let live = true;
    setError(null);
    api.reports(pid, item.id).then(
      (r) => live && setReports(r),
      (e: unknown) => live && setError(e instanceof Error ? e.message : 'Could not load the reports'),
    );
    return () => {
      live = false;
    };
  }, [pid, item.id, key, item.status, lastChange]);

  if (!reportLinks.length && !otherLinks.length) return null;
  const list = reports ?? reportLinks.map((l): ReportInfo => ({ url: l.url, label: l.label, agent: '', file: '', name: l.label, title: null, size: 0, updatedAt: null, exists: true }));

  return (
    <>
      <section className="ticket-section" aria-label="Reports">
        {list.length > 0 && (
          <>
            <h3 className="section-label">
              Reports <span className="muted">({list.length})</span>
            </h3>
            {error && <p className="field-hint bad">{error}</p>}
            <ul className="report-list">
              {list.map((r) => {
                const desk = agentById(agents, r.agent);
                return (
                  <li key={r.url}>
                    {/* aria-disabled, not disabled: keyboard users can still reach a missing report and hear why. */}
                    <button type="button" className={`report-row${r.exists ? '' : ' missing'}`} onClick={() => r.exists && setOpenUrl(r.url)} aria-disabled={r.exists ? undefined : 'true'}>
                      <span className="report-row-icon" aria-hidden>
                        <FileText size={18} />
                      </span>
                      <span className="report-row-main">
                        <span className="report-row-title">{r.title ?? r.name}</span>
                        <span className="report-row-meta">
                          {r.file && <span className="mono">{r.name}</span>}
                          {desk && (
                            <span className="report-row-desk">
                              <Avatar name={desk.name} color={desk.color} size={16} />
                              {desk.name}
                            </span>
                          )}
                          {r.updatedAt && <span title={new Date(r.updatedAt).toLocaleString()}>{timeAgo(r.updatedAt)}</span>}
                          {r.exists ? r.size > 0 && <span>{fileSize(r.size)}</span> : <span className="bad">File not found</span>}
                          {reports === null && !error && <span>Loading details...</span>}
                        </span>
                      </span>
                      <ChevronRight size={16} className="report-row-go" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {otherLinks.length > 0 && (
          <>
            <h3 className="section-label">Links</h3>
            <ul className="report-list">
              {otherLinks.map((l) =>
                /^https?:/i.test(l.url) ? (
                  <li key={l.url + l.label}>
                    <a className="report-row" href={l.url} target="_blank" rel="noopener noreferrer">
                      <span className="report-row-icon" aria-hidden>
                        <ExternalLink size={16} />
                      </span>
                      <span className="report-row-main">
                        <span className="report-row-title">{l.label}</span>
                        <span className="report-row-meta">
                          <span className="mono">{l.url.replace(/^https?:\/\//, '').slice(0, 60)}</span>
                        </span>
                      </span>
                    </a>
                  </li>
                ) : (
                  <li key={l.url + l.label}>
                    <span className="report-row missing" title="Sim mode placeholder, no file behind it">
                      <span className="report-row-icon" aria-hidden>
                        <LinkIcon size={16} />
                      </span>
                      <span className="report-row-main">
                        <span className="report-row-title">{l.label}</span>
                        <span className="report-row-meta">Placeholder, nothing to open</span>
                      </span>
                    </span>
                  </li>
                ),
              )}
            </ul>
          </>
        )}
      </section>

      {/* Outside the section, so the section's styles never reach the reader. */}
      <ReportReader reports={list} url={openUrl} onOpen={setOpenUrl} agents={agents} />
    </>
  );
}

/** The full-size reader: the report on the right, every report of the ticket on the left. Tracks the open report by URL. */
function ReportReader({ reports, url, onOpen, agents }: { reports: ReportInfo[]; url: string | null; onOpen: (url: string | null) => void; agents: Agent[] }) {
  const index = url === null ? -1 : reports.findIndex((r) => r.url === url);
  const current = index >= 0 ? reports[index] : undefined;
  const usable = reports.filter((r) => r.exists);
  const title = current ? (current.title ?? current.name) : 'Report';

  // The report left the ticket's list: close the reader.
  useEffect(() => {
    if (url !== null && index === -1) onOpen(null);
  }, [url, index, onOpen]);

  // Up and Down move between reports while the list has focus.
  const onKey = (e: KeyboardEvent) => {
    if (index === -1 || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    for (let i = index + step; i >= 0 && i < reports.length; i += step) {
      if (reports[i].exists) {
        onOpen(reports[i].url);
        requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.reader-nav [data-index="${i}"]`)?.focus());
        return;
      }
    }
  };

  return (
    <Modal open={current !== undefined} onClose={() => onOpen(null)} title={title} size="xl">
      {current && (
        <div className={`report-reader${usable.length > 1 ? ' with-nav' : ''}`}>
          {usable.length > 1 && (
            <nav className="reader-nav" aria-label="Reports on this ticket" onKeyDown={onKey}>
              <p className="section-label">
                {index + 1} of {reports.length}
              </p>
              <ul>
                {reports.map((r, i) => {
                  const desk = agentById(agents, r.agent);
                  return (
                    <li key={r.url}>
                      <button
                        type="button"
                        data-index={i}
                        className={`reader-nav-item${i === index ? ' on' : ''}`}
                        aria-current={i === index ? 'true' : undefined}
                        disabled={!r.exists}
                        onClick={() => onOpen(r.url)}
                      >
                        <span className="reader-nav-title">{r.title ?? r.name}</span>
                        <span className="reader-nav-meta">
                          {desk?.name ?? r.agent}
                          {r.updatedAt ? ` · ${timeAgo(r.updatedAt)}` : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}
          <div className="reader-main">
            <ReportViewer key={current.url} url={current.url} version={current.updatedAt} embedded />
          </div>
        </div>
      )}
    </Modal>
  );
}
