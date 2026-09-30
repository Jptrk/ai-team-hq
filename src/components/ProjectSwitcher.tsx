import { ChevronsUpDown, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { TEMPLATE_LABEL, type ProjectSummary } from '../../shared/types';
import { usePopover } from '../hooks/usePopover';
import { basename } from '../util';
import { ProjectAvatar } from './ProjectAvatar';

interface Props {
  projects: ProjectSummary[];
  current?: ProjectSummary;
  onNavigate: (to: string) => void;
  /** Path for another project that keeps the current view. */
  pathFor: (pid: string) => string;
  /** Sidebar rail: avatar only, menu flies out to the right. */
  compact?: boolean;
}

/** Jira-style project picker at the top of the sidebar. */
export function ProjectSwitcher({ projects, current, onNavigate, pathFor, compact }: Props) {
  const pop = usePopover<HTMLDivElement>();
  const [filter, setFilter] = useState('');

  const go = (to: string) => {
    pop.setOpen(false);
    setFilter('');
    onNavigate(to);
  };

  const needle = filter.trim().toLowerCase();
  const list = needle ? projects.filter((p) => `${p.name} ${p.key} ${p.path ?? ''}`.toLowerCase().includes(needle)) : projects;
  const othersNeedYou = projects.filter((p) => p.id !== current?.id).reduce((n, p) => n + p.needsYou, 0);

  return (
    <div className={`switcher${compact ? ' compact' : ''}`} ref={pop.ref}>
      <button type="button" className="switcher-btn" aria-haspopup="menu" aria-expanded={pop.open} onClick={() => pop.setOpen((o) => !o)} title={current ? `${current.name} (${current.key})` : 'Projects'}>
        {current ? <ProjectAvatar project={current} size={32} /> : <span className="switcher-empty-avatar" aria-hidden />}
        {!compact && (
          <span className="switcher-text">
            <span className="switcher-name">{current?.name ?? 'All projects'}</span>
            <span className="switcher-sub">{current ? `${TEMPLATE_LABEL[current.template]} · ${current.key}` : 'Pick a project'}</span>
          </span>
        )}
        {othersNeedYou > 0 && (
          <span className="badge switcher-alert" title="Needs you in other projects">
            {othersNeedYou}
          </span>
        )}
        {!compact && <ChevronsUpDown size={15} className="switcher-chev" aria-hidden />}
      </button>

      {pop.open && (
        <div className="popover menu switcher-menu" role="menu">
          {projects.length > 5 && <input className="input menu-filter" autoFocus placeholder="Find a project" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          <p className="menu-label">Projects</p>
          <ul className="menu-list">
            {list.map((p) => (
              <li key={p.id}>
                <button role="menuitem" type="button" className={`menu-item${p.id === current?.id ? ' on' : ''}`} onClick={() => go(pathFor(p.id))}>
                  <ProjectAvatar project={p} size={28} />
                  <span className="menu-item-body">
                    <span className="menu-item-name">{p.name}</span>
                    <span className="menu-item-sub">
                      {p.key} · {TEMPLATE_LABEL[p.template]}
                      {p.path ? ` · ${basename(p.path)}` : ''}
                    </span>
                  </span>
                  {p.running > 0 && <span className="dot pulse run-dot" title={`${p.running} running`} />}
                  {p.needsYou > 0 && <span className="badge">{p.needsYou}</span>}
                </button>
              </li>
            ))}
            {list.length === 0 && <li className="menu-empty">No match</li>}
          </ul>
          <div className="menu-sep" />
          {current && (
            <button type="button" role="menuitem" className="menu-row" onClick={() => go(`/p/${current.id}/settings`)}>
              <Settings size={15} aria-hidden /> Project settings
            </button>
          )}
          <button type="button" role="menuitem" className="menu-row" onClick={() => go('/projects')}>
            View all projects
          </button>
          <button type="button" role="menuitem" className="menu-row strong" onClick={() => go('/projects/new')}>
            <Plus size={15} aria-hidden /> Create project
          </button>
        </div>
      )}
    </div>
  );
}
