import { Plus, Settings } from 'lucide-react';
import { TEMPLATE_LABEL, type ProjectSummary } from '../../shared/types';
import { PageHeader } from '../shell/PageHeader';
import { ProjectAvatar } from './ProjectAvatar';

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
                      <span className="project-sub">{TEMPLATE_LABEL[p.template]}</span>
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
    </div>
  );
}
