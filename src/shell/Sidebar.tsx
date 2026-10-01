import { Building2, FolderOpen, Inbox, MessagesSquare, NotebookPen, Plug, Plus, Presentation, Settings, SquareKanban, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ProjectSummary } from '../../shared/types';
import { ProjectSwitcher } from '../components/ProjectSwitcher';
import { projectPath, type Route, type ViewId } from '../route';

export type SidebarMode = 'expanded' | 'rail' | 'overlay';

interface Props {
  projects: ProjectSummary[];
  current?: ProjectSummary;
  route: Route;
  counts: { needsYou: number; paused: number; unread: number; huddling: boolean };
  mode: SidebarMode;
  onNavigate: (to: string) => void;
  /** Called after a link is followed, to close the overlay sidebar. */
  onFollow: () => void;
}

const NAV: { view: ViewId; label: string; Icon: typeof Inbox }[] = [
  { view: 'needs-you', label: 'Needs you', Icon: Inbox },
  { view: 'chat', label: 'Chat', Icon: MessagesSquare },
  { view: 'board', label: 'Board', Icon: SquareKanban },
  { view: 'huddles', label: 'Huddles', Icon: Presentation },
  { view: 'team', label: 'Team', Icon: Users },
  { view: 'office', label: 'Office', Icon: Building2 },
  { view: 'notes', label: 'Team notes', Icon: NotebookPen },
];

function NavLink({ href, label, active, Icon, rail, trailing, onFollow }: { href: string; label: string; active: boolean; Icon: typeof Inbox; rail: boolean; trailing?: ReactNode; onFollow: () => void }) {
  return (
    <li>
      <a href={`#${href}`} className={`nav-link${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} title={rail ? label : undefined} onClick={onFollow}>
        <Icon size={18} aria-hidden className="nav-icon" />
        <span className={rail ? 'sr-only' : 'nav-label'}>{label}</span>
        {trailing}
      </a>
    </li>
  );
}

export function Sidebar({ projects, current, route, counts, mode, onNavigate, onFollow }: Props) {
  const rail = mode === 'rail';
  const view = route.kind === 'project' ? route.view : null;
  const pathFor = (pid: string) => (route.kind === 'project' ? projectPath(pid, route.view) : projectPath(pid));

  const trailingFor = (v: ViewId) => {
    if (v === 'needs-you' && counts.needsYou > 0)
      return (
        <span className="badge nav-badge">
          {counts.needsYou}
          <span className="sr-only"> need you</span>
        </span>
      );
    if (v === 'chat' && counts.paused > 0)
      return (
        <span className="badge amber nav-badge">
          {counts.paused}
          <span className="sr-only"> paused</span>
        </span>
      );
    if (v === 'huddles' && counts.huddling)
      return (
        <span className="unread-dot nav-badge" title="A huddle is running">
          <span className="sr-only">running</span>
        </span>
      );
    if (v === 'chat' && counts.unread > 0)
      return (
        <span className="unread-dot nav-badge" title={`${counts.unread} unread`}>
          <span className="sr-only">{counts.unread} unread</span>
        </span>
      );
    return null;
  };

  return (
    <nav className={`sidebar ${mode}`} aria-label="Project">
      <div className="sidebar-top">
        <ProjectSwitcher projects={projects} current={current} onNavigate={onNavigate} pathFor={pathFor} compact={rail} />
      </div>

      {current ? (
        <>
          {!rail && <p className="sidebar-heading">Planning</p>}
          <ul className="nav-list">
            {NAV.map(({ view: v, label, Icon }) => (
              <NavLink key={v} href={projectPath(current.id, v)} label={label} Icon={Icon} active={view === v} rail={rail} trailing={trailingFor(v)} onFollow={onFollow} />
            ))}
          </ul>
          <div className="sidebar-spacer" />
          <ul className="nav-list">
            <NavLink href={`/p/${current.id}/connections`} label="Connections" Icon={Plug} active={route.kind === 'connections'} rail={rail} onFollow={onFollow} />
            <NavLink href={`/p/${current.id}/settings`} label="Project settings" Icon={Settings} active={route.kind === 'settings'} rail={rail} onFollow={onFollow} />
          </ul>
        </>
      ) : (
        <>
          <ul className="nav-list">
            <NavLink href="/projects" label="All projects" Icon={FolderOpen} active={route.kind === 'projects'} rail={rail} onFollow={onFollow} />
            <NavLink href="/projects/new" label="Create project" Icon={Plus} active={route.kind === 'new'} rail={rail} onFollow={onFollow} />
          </ul>
          <div className="sidebar-spacer" />
        </>
      )}
    </nav>
  );
}
