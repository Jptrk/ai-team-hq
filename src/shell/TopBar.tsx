import { CirclePause, Keyboard, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Pause, Play, Plus, Sun, UserRound } from 'lucide-react';
import { forwardRef, useEffect, useRef, useState } from 'react';
import type { Agent, EffortLevel, Meta, WorkItem } from '../../shared/types';
import { api } from '../api';
import { usePopover } from '../hooks/usePopover';
import type { Theme, ThemePref } from '../hooks/useTheme';
import { Avatar } from '../ui/Avatar';
import { clockTime, EFFORT_LABEL, effortLabel, goLiveHint, pauseLabel, pauseText, runnerLabel } from '../util';
import { TopBarSearch, type SearchHandle } from './TopBarSearch';

interface Props {
  meta: Meta | null;
  /** A new meta from the server, after a setting changed. */
  onMeta: (meta: Meta) => void;
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
  onAccount: () => void;
  theme: Theme;
  themePref: ThemePref;
  onThemePref: (p: ThemePref) => void;
  onToggleTheme: () => void;
  narrow: boolean;
}

const EFFORTS: { id: EffortLevel | null; label: string; hint?: string }[] = [
  { id: null, label: 'Model default', hint: 'what the model picks' },
  { id: 'low', label: EFFORT_LABEL.low, hint: 'fastest, uses the least' },
  { id: 'medium', label: EFFORT_LABEL.medium },
  { id: 'high', label: EFFORT_LABEL.high },
  { id: 'xhigh', label: EFFORT_LABEL.xhigh },
  { id: 'max', label: EFFORT_LABEL.max, hint: 'slowest, uses the most' },
];

/** HQ's one effort level, for every desk in every project. Saved as you pick; a failed save shows what the server has. */
function EffortPicker({ meta, onMeta }: { meta: Meta; onMeta: (meta: Meta) => void }) {
  const [pick, setPick] = useState<EffortLevel | null>(meta.effort);
  const [error, setError] = useState<string | null>(null);
  // One save at a time, then the newest pick if it changed meanwhile: arrow keys check every radio they pass,
  // and two saves in flight could land in either order.
  const wanted = useRef<EffortLevel | null>(meta.effort);
  const saving = useRef(false);
  const save = (): void => {
    saving.current = true;
    const level = wanted.current;
    api.setSettings({ effort: level }).then(
      (m) => {
        if (wanted.current !== level) return save();
        saving.current = false;
        onMeta(m);
      },
      (e: unknown) => {
        if (wanted.current !== level) return save();
        saving.current = false;
        setError(e instanceof Error ? e.message : 'Could not save the setting.');
        // An earlier pick may have saved: show what the server has now.
        api.meta().then(
          (m) => {
            if (saving.current) return;
            onMeta(m);
            wanted.current = m.effort;
            setPick(m.effort);
          },
          () => {
            if (!saving.current) setPick(meta.effort);
          },
        );
      },
    );
  };
  const choose = (level: EffortLevel | null) => {
    setPick(level);
    setError(null);
    wanted.current = level;
    if (!saving.current) save();
  };
  return (
    <fieldset className="effort-pick">
      <legend className="menu-label">Effort</legend>
      {EFFORTS.map((e) => (
        <label key={e.id ?? 'default'} className={`menu-row${pick === e.id ? ' on' : ''}`}>
          <input type="radio" name="hq-effort" value={e.id ?? 'default'} checked={pick === e.id} onChange={() => choose(e.id)} />
          <span>{e.label}</span>
          {e.hint && <span className="effort-hint">{e.hint}</span>}
        </label>
      ))}
      <p className="muted small effort-note">
        {meta.runner === 'claude'
          ? 'For every desk in every project, from its next run. More effort means more thinking and more usage. After a change, a desk with a long conversation starts a fresh one.'
          : 'Used once agents run live.'}
      </p>
      {error && (
        <p className="field-hint bad" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * Pause for everything the team starts on its own, in every project. Paused (by you, or by Claude's usage limit),
 * it becomes an amber pill whose popover says why and resumes. Pausing never asks: it only stops work starting.
 */
function AutoControl({ meta, onMeta }: { meta: Meta; onMeta: (meta: Meta) => void }) {
  const pop = usePopover<HTMLDivElement>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = meta.paused;
  // The control swaps between the Pause button and the paused pill: whichever is showing gets focus back after a change,
  // also when Resume came from the banner, so keyboard focus never drops to the page.
  const button = useRef<HTMLButtonElement>(null);
  const wasPaused = useRef(Boolean(paused));
  useEffect(() => {
    if (wasPaused.current === Boolean(paused)) return;
    wasPaused.current = Boolean(paused);
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lost) button.current?.focus();
  }, [paused]);
  const set = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      onMeta(await api.setSettings({ paused: on }));
      if (!on) pop.setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change it.');
      pop.setOpen(true);
    } finally {
      setBusy(false);
    }
  };
  if (!paused) {
    return (
      <div className="popover-anchor" ref={pop.ref}>
        <button
          ref={button}
          type="button"
          className="status-pill auto-pill"
          onClick={() => void set(true)}
          disabled={busy}
          title="Pause everything the team starts on its own"
          aria-label="Pause the team: nothing it starts on its own runs until you resume"
        >
          <Pause size={14} aria-hidden />
          <span className="status-pill-text">Pause</span>
        </button>
        {error && pop.open && (
          <div className="popover status-popover" role="alert">
            <p className="field-hint bad">{error}</p>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="popover-anchor" ref={pop.ref}>
      <button ref={button} type="button" className="status-pill paused" aria-expanded={pop.open} aria-label={`${pauseLabel(paused)}: open to resume`} onClick={() => pop.setOpen((o) => !o)}>
        <CirclePause size={15} aria-hidden />
        <span className="status-pill-text">{pauseLabel(paused)}</span>
      </button>
      {pop.open && (
        <div className="popover status-popover" role="dialog" aria-label="Paused">
          <p className="popover-title">{paused.by === 'you' ? 'The team is paused' : paused.by === 'usage' ? "Claude's usage limit" : 'Claude account problem'}</p>
          <p className="muted small">{pauseText(paused)}</p>
          <p className="muted small">
            Since {clockTime(paused.at)}.{' '}
            {meta.held ? `${meta.held} start${meta.held === 1 ? '' : 's'} waiting.` : 'Nothing waiting yet.'} A huddle that is running keeps going; stop it from Huddles.
          </p>
          <button type="button" className="btn btn-primary btn-sm auto-resume" onClick={() => void set(false)} disabled={busy}>
            <Play size={13} aria-hidden /> {paused.by === 'usage' ? 'Resume now' : 'Resume'}
          </button>
          {error && (
            <p className="field-hint bad" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ meta, onMeta, onAccount }: { meta: Meta | null; onMeta: (meta: Meta) => void; onAccount: () => void }) {
  const pop = usePopover<HTMLDivElement>();
  if (!meta) return null;
  const live = meta.runner === 'claude';
  return (
    <div className="popover-anchor" ref={pop.ref}>
      <button type="button" className={`status-pill${live ? ' live' : ''}`} aria-expanded={pop.open} onClick={() => pop.setOpen((o) => !o)}>
        <span className={`dot${live ? ' pulse' : ''}`} />
        <span className="status-pill-text">
          {runnerLabel(meta)}
          {effortLabel(meta) && <span className="status-pill-effort">{effortLabel(meta)}</span>}
        </span>
      </button>
      {pop.open && (
        <div className="popover status-popover" role="dialog" aria-label="Runner status">
          <p className="popover-title">{live ? 'Live agents' : meta.idle ? 'Not live' : 'Sim mode'}</p>
          <p className="muted small">
            {live
              ? meta.auth === 'none'
                ? 'HQ is live, but there is no Claude login on this PC, so desk runs fail. Sign in again on the Claude account page.'
                : `Each instruction starts a real Claude run on ${meta.auth === 'api-key' ? 'your API key' : 'your Claude login'}. Nothing leaves the building without your approval, except changes on a connection you set to Auto.`
              : meta.idle
                ? `HQ has no Claude login to run desks on, so they are idle, and there is no sim in your projects. ${goLiveHint(meta)}`
                : `Fake activity, no Claude calls. ${goLiveHint(meta)}`}
          </p>
          <button
            type="button"
            className="menu-row"
            onClick={() => {
              pop.setOpen(false);
              onAccount();
            }}
          >
            <UserRound size={15} aria-hidden /> Claude account
          </button>
          <div className="menu-sep" />
          <EffortPicker meta={meta} onMeta={onMeta} />
        </div>
      )}
    </div>
  );
}

function FounderMenu({
  ownerName,
  ownerColor,
  themePref,
  onThemePref,
  onAllProjects,
  onAccount,
}: {
  ownerName: string;
  ownerColor?: string;
  themePref: ThemePref;
  onThemePref: (p: ThemePref) => void;
  onAllProjects: () => void;
  onAccount: () => void;
}) {
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
          <button
            type="button"
            role="menuitem"
            className="menu-row"
            onClick={() => {
              pop.setOpen(false);
              onAccount();
            }}
          >
            Claude account
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
        {p.meta && <AutoControl meta={p.meta} onMeta={p.onMeta} />}
        <StatusPill meta={p.meta} onMeta={p.onMeta} onAccount={p.onAccount} />
        <button type="button" className="icon-btn topbar-btn" onClick={p.onToggleTheme} aria-label={p.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={p.theme === 'dark' ? 'Light theme' : 'Dark theme'}>
          {p.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <FounderMenu ownerName={p.ownerName} ownerColor={p.ownerColor} themePref={p.themePref} onThemePref={p.onThemePref} onAllProjects={p.onAllProjects} onAccount={p.onAccount} />
      </div>
    </header>
  );
});
