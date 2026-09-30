import { Keyboard, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Sun } from 'lucide-react';
import { forwardRef } from 'react';
import type { Agent, Meta, WorkItem } from '../../shared/types';
import { usePopover } from '../hooks/usePopover';
import type { Theme, ThemePref } from '../hooks/useTheme';
import { Avatar } from '../ui/Avatar';
import { TopBarSearch, type SearchHandle } from './TopBarSearch';

interface Props {
  meta: Meta | null;
  ownerName: string;
  ownerColor?: string;
  items: WorkItem[] | null;
  agents: Agent[];
  projectKey: string;
  sidebarMode: 'expanded' | 'rail' | 'overlay';
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onCreate: () => void;
  createLabel: string;
  onOpenTicket: (key: string) => void;
  onAllProjects: () => void;
  theme: Theme;
  themePref: ThemePref;
  onThemePref: (p: ThemePref) => void;
  onToggleTheme: () => void;
  narrow: boolean;
}

function StatusPill({ meta }: { meta: Meta | null }) {
  const pop = usePopover<HTMLDivElement>();
  if (!meta) return null;
  const live = meta.runner === 'claude';
  return (
    <div className="popover-anchor" ref={pop.ref}>
      <button type="button" className={`status-pill${live ? ' live' : ''}`} aria-expanded={pop.open} onClick={() => pop.setOpen((o) => !o)}>
        <span className={`dot${live ? ' pulse' : ''}`} />
        <span className="status-pill-text">{live ? `Live · ${meta.model}` : 'Sim'}</span>
      </button>
      {pop.open && (
        <div className="popover status-popover" role="dialog" aria-label="Runner status">
          <p className="popover-title">{live ? 'Live agents' : 'Sim mode'}</p>
          <p className="muted small">
            {live
              ? `Each instruction starts a real Claude run on ${meta.auth === 'api-key' ? 'your API key' : 'your Claude login'}. Nothing leaves the building without your approval.`
              : 'Fake activity, no Claude calls. Set HQ_RUNNER=claude in .env to go live.'}
          </p>
        </div>
      )}
    </div>
  );
}

function FounderMenu({ ownerName, ownerColor, themePref, onThemePref, onAllProjects }: { ownerName: string; ownerColor?: string; themePref: ThemePref; onThemePref: (p: ThemePref) => void; onAllProjects: () => void }) {
  const pop = usePopover<HTMLDivElement>();
  const THEMES: { id: ThemePref; label: string; Icon: typeof Sun }[] = [
    { id: 'light', label: 'Light', Icon: Sun },
    { id: 'dark', label: 'Dark', Icon: Moon },
    { id: 'system', label: 'Match system', Icon: Monitor },
  ];
  return (
    <div className="popover-anchor" ref={pop.ref}>
      <button type="button" className="founder-btn" aria-label={`${ownerName}, open menu`} aria-expanded={pop.open} onClick={() => pop.setOpen((o) => !o)}>
        <Avatar name={ownerName} color={ownerColor} size={28} />
      </button>
      {pop.open && (
        <div className="popover menu founder-menu" role="menu">
          <p className="popover-title">{ownerName}</p>
          <p className="menu-label">Theme</p>
          {THEMES.map(({ id, label, Icon }) => (
            <button key={id} type="button" role="menuitemradio" aria-checked={themePref === id} className={`menu-row${themePref === id ? ' on' : ''}`} onClick={() => onThemePref(id)}>
              <Icon size={15} aria-hidden /> {label}
            </button>
          ))}
          <div className="menu-sep" />
          <p className="menu-label">
            <Keyboard size={13} aria-hidden /> Shortcuts
          </p>
          <ul className="shortcut-list">
            <li>
              <kbd>c</kbd> Create
            </li>
            <li>
              <kbd>/</kbd> Search tickets
            </li>
            <li>
              <kbd>[</kbd> Collapse sidebar
            </li>
            <li>
              <kbd>Esc</kbd> Close panel or dialog
            </li>
          </ul>
          <div className="menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="menu-row"
            onClick={() => {
              pop.setOpen(false);
              onAllProjects();
            }}
          >
            All projects
          </button>
        </div>
      )}
    </div>
  );
}

export const TopBar = forwardRef<SearchHandle, Props>(function TopBar(p, searchRef) {
  const SidebarIcon = p.sidebarMode === 'overlay' ? Menu : p.sidebarOpen ? PanelLeftClose : PanelLeftOpen;
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button type="button" className="icon-btn topbar-btn" onClick={p.onToggleSidebar} aria-label={p.sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'} aria-expanded={p.sidebarOpen}>
          <SidebarIcon size={18} />
        </button>
        <a className="wordmark" href="#/projects" aria-label="AI Team HQ, all projects">
          <span className="wordmark-mark" aria-hidden>
            HQ
          </span>
          <span className="wordmark-text">AI Team HQ</span>
        </a>
      </div>
      <TopBarSearch ref={searchRef} items={p.items} agents={p.agents} projectKey={p.projectKey} onOpen={p.onOpenTicket} compact={p.narrow} />
      <div className="topbar-right">
        <button type="button" className="btn btn-primary topbar-create" onClick={p.onCreate} aria-label={p.createLabel}>
          <Plus size={16} aria-hidden />
          <span className="topbar-create-text">{p.createLabel}</span>
        </button>
        <StatusPill meta={p.meta} />
        <button type="button" className="icon-btn topbar-btn" onClick={p.onToggleTheme} aria-label={p.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={p.theme === 'dark' ? 'Light theme' : 'Dark theme'}>
          {p.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <FounderMenu ownerName={p.ownerName} ownerColor={p.ownerColor} themePref={p.themePref} onThemePref={p.onThemePref} onAllProjects={p.onAllProjects} />
      </div>
    </header>
  );
});
