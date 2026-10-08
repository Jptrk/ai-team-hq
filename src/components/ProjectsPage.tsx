import { Plus, Settings } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { projectProvider, TEMPLATE_LABEL, type ProjectSummary, type RemovedProject } from '../../shared/types';
import { api } from '../api';
import { PageHeader } from '../shell/PageHeader';
import { AVATAR_FALLBACK, timeAgo } from '../util';
import { ProjectAvatar } from './ProjectAvatar';
import { sizeLabel } from './skills/skillInfo';

interface Props {
  projects: ProjectSummary[];
  currentId?: string;
  onNavigate: (to: string) => void;
}

export function ProjectsPage({ projects, currentId, onNavigate }: Props) {
  return (
    <div className="page">
      <PageHeader
        title="Projects"
        subtitle="Each project has its own team, board, and agent workspaces. Link a folder so the team can read its code."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => onNavigate('/projects/new')}>
            <Plus size={15} aria-hidden /> Create project
          </button>
        }
      />
      <div className="table-wrap card-box">
        <table className="data-table projects-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Key</th>
              <th scope="col">Team</th>
              <th scope="col">Open</th>
              <th scope="col">Needs you</th>
              <th scope="col">Folder</th>
              <th scope="col">
                <span className="sr-only">Settings</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className={p.id === currentId ? 'current' : undefined}>
                <td data-label="Name">
                  <a className="project-cell" href={`#/p/${p.id}`}>
                    <ProjectAvatar project={p} size={28} />
                    <span>
                      <span className="project-name">{p.name}</span>
                      <span className="project-sub">
                        {TEMPLATE_LABEL[p.template]}
                        {projectProvider(p) === 'gpt' && <span className="chip gpt-chip">GPT</span>}
                      </span>
                    </span>
                  </a>
                </td>
                <td data-label="Key" className="mono">
                  {p.key}
                </td>
                <td data-label="Team">{p.teamSize}</td>
                <td data-label="Open">{p.openItems}</td>
                <td data-label="Needs you">{p.needsYou > 0 ? <span className="badge">{p.needsYou}</span> : <span className="muted">0</span>}</td>
                <td data-label="Folder" className="folder-cell">
                  {p.path ? (
                    <>
                      <span className={`mono small path${p.pathOk ? '' : ' missing'}`} title={p.path}>
                        {p.pathOk ? p.path : `${p.path} (missing)`}
                      </span>
                      <span className="lozenge">{p.access === 'write' ? 'read & write' : 'read only'}</span>
                    </>
                  ) : (
                    <span className="muted small">No linked folder</span>
                  )}
                </td>
                <td className="actions-cell">
                  <button type="button" className="icon-btn sm" title={`${p.name} settings`} aria-label={`${p.name} settings`} onClick={() => onNavigate(`/p/${p.id}/settings`)}>
                    <Settings size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RemovedProjects />
    </div>
  );
}

/** Archived projects waiting in data/archive, each to delete for good. Hidden while there are none, unless the list failed to load. */
function RemovedProjects() {
  const [removed, setRemoved] = useState<RemovedProject[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the newest answer counts, and none once the page is gone.
  const version = useRef(0);

  const load = useCallback(async () => {
    const v = ++version.current;
    try {
      const list = await api.removedProjects();
      if (v !== version.current) return;
      setRemoved(list);
      setLoadError(null);
    } catch (e) {
      if (v === version.current) setLoadError(e instanceof Error ? e.message : 'Could not reach HQ');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      version.current++;
    };
  }, [load]);

  if (!removed.length && !loadError) return null;

  const remove = async (r: RemovedProject) => {
    if (armed !== r.folder) {
      setArmed(r.folder);
      return;
    }
    setBusy(r.folder);
    setError(null);
    try {
      await api.deleteRemoved(r.folder);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete it');
    } finally {
      setBusy(null);
      setArmed(null);
    }
    // Whatever happened, show what is there now: it may have been deleted from another tab.
    await load();
  };

  const total = removed.reduce((n, r) => n + r.bytes, 0);
  return (
    <section className="removed-projects" aria-labelledby="removed-projects-title">
      <h3 id="removed-projects-title" className="section-label">
        Removed projects
      </h3>
      {loadError && <p className="small muted">Could not load the removed projects: {loadError}</p>}
      {removed.length > 0 && (
        <>
          <p className="small muted">
            Archived boards, workspaces, reports and trash: {sizeLabel(total)} in data/archive. Delete one for good to free the space. Linked folders are never touched.
          </p>
          {error && <p className="banner danger">{error}</p>}
          <div className="table-wrap card-box">
            <table className="data-table projects-table removed-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Removed</th>
                  <th scope="col">Size</th>
                  <th scope="col">
                    <span className="sr-only">Delete</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {removed.map((r) => (
                  <tr key={r.folder}>
                    <td data-label="Name">
                      <span className="project-cell">
                        <ProjectAvatar project={{ key: (r.key ?? r.name).slice(0, 2).toUpperCase(), color: r.color ?? AVATAR_FALLBACK }} size={28} />
                        <span>
                          <span className="project-name">{r.name}</span>
                          <span className="project-sub mono">{r.folder}</span>
                        </span>
                      </span>
                    </td>
                    <td data-label="Removed">
                      <span title={new Date(r.removedAt).toLocaleString()}>{timeAgo(r.removedAt)}</span>
                    </td>
                    <td data-label="Size">{sizeLabel(r.bytes)}</td>
                    <td className="actions-cell">
                      <button type="button" className={`btn btn-sm ${armed === r.folder ? 'btn-danger' : 'btn-outline'}`} disabled={busy !== null} onClick={() => void remove(r)}>
                        {busy === r.folder ? 'Deleting...' : armed === r.folder ? `Click again to delete ${r.key ?? r.name} for good` : 'Delete for good'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
