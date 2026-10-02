import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentPanel } from './components/AgentPanel';
import { Board } from './components/Board';
import { ThreadList } from './components/Chat';
import { ChatThread } from './components/ChatThread';
import { ConnectionsPanel } from './components/ConnectionsPanel';
import { HuddleList } from './components/huddles/HuddleList';
import { HuddleSetup } from './components/huddles/HuddleSetup';
import { HuddleView } from './components/huddles/HuddleView';
import { NeedsYou } from './components/NeedsYou';
import { Office } from './components/Office';
import { ProjectAvatar } from './components/ProjectAvatar';
import { ProjectForm } from './components/ProjectForm';
import { ProjectsPage } from './components/ProjectsPage';
import { Team } from './components/Team';
import { TeamNotes } from './components/TeamNotes';
import { TicketView } from './components/TicketView';
import { useFlags } from './hooks/useFlags';
import { useHotkeys } from './hooks/useHotkeys';
import { useHqData } from './hooks/useHqData';
import { useLayer } from './hooks/useLayer';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useProjectActions } from './hooks/useProjectActions';
import { useTheme } from './hooks/useTheme';
import { roughTokens } from '../shared/huddle';
import { hasQa } from '../shared/types';
import { ProjectIdContext, TeamNotesContext, type TeamNotesInfo } from './lib/projectContext';
import { KEYS, storage } from './lib/storage';
import { projectPath, useHashRoute, type ViewId } from './route';
import { CreateModal, type CreateKind } from './shell/CreateModal';
import { createDraftGuard, DraftGuardProvider } from './shell/draftGuard';
import { PanelModal } from './shell/PanelModal';
import { Flags } from './shell/Flags';
import { PageHeader } from './shell/PageHeader';
import { Sidebar, type SidebarMode } from './shell/Sidebar';
import { TopBar } from './shell/TopBar';
import type { SearchHandle } from './shell/TopBarSearch';
import { agentById, ticketKey } from './util';

const VIEW_TITLE: Record<ViewId, string> = { 'needs-you': 'Needs you', chat: 'Chat', board: 'Board', huddles: 'Huddles', team: 'Team', office: 'Office', notes: 'Team notes' };

export function App() {
  const [route, navigate] = useHashRoute();
  const pid = route.kind === 'project' || route.kind === 'settings' || route.kind === 'connections' ? route.pid : null;
  const { meta, projects, state, error, after, loadProjects, setPollPaused } = useHqData(pid);
  const { theme, pref, setPref, toggle } = useTheme();
  const { flags, notify, dismiss } = useFlags();
  const searchRef = useRef<SearchHandle>(null);

  // ---------- layout ----------
  const wide = useMediaQuery('(min-width: 1100px)');
  const mid = useMediaQuery('(min-width: 720px)');
  const chatSplit = useMediaQuery('(min-width: 900px)');
  const [collapsed, setCollapsed] = useState(() => storage.get(KEYS.sidebar) === 'rail');
  const [overlayOpen, setOverlayOpen] = useState(false);
  const inlineMode: SidebarMode | null = wide ? (collapsed ? 'rail' : 'expanded') : mid ? 'rail' : null;
  useLayer(overlayOpen && !wide, () => setOverlayOpen(false), { blurFirst: false });
  useEffect(() => {
    if (wide) setOverlayOpen(false);
  }, [wide]);

  const toggleSidebar = useCallback(() => {
    if (wide) {
      setCollapsed((c) => {
        storage.set(KEYS.sidebar, c ? 'expanded' : 'rail');
        return !c;
      });
    } else setOverlayOpen((o) => !o);
  }, [wide]);

  // ---------- landing ----------
  useEffect(() => {
    if (!projects) return;
    const fallback = () => {
      const last = storage.get(KEYS.lastProject);
      const target = projects.find((p) => p.id === last) ?? projects[0];
      return target ? projectPath(target.id) : '/projects/new';
    };
    if (route.kind === 'home') navigate(fallback(), true);
    else if (pid && !projects.some((p) => p.id === pid)) navigate(fallback(), true);
  }, [projects, route, pid, navigate]);

  useEffect(() => {
    if (pid) storage.set(KEYS.lastProject, pid);
  }, [pid]);

  const current = useMemo(() => (pid && projects ? projects.find((p) => p.id === pid) : undefined), [pid, projects]);
  const view: ViewId = route.kind === 'project' ? route.view : 'needs-you';
  const threadId = route.kind === 'project' ? route.threadId : undefined;
  const huddleId = route.kind === 'project' ? route.huddleId : undefined;
  const panelTicket = route.kind === 'project' ? route.ticket : undefined;
  const panelAgent = route.kind === 'project' ? route.agent : undefined;

  // ---------- ticket modal navigation ----------
  const pushedPanel = useRef(false);
  useEffect(() => {
    if (!panelTicket && !panelAgent) pushedPanel.current = false;
  }, [panelTicket, panelAgent]);

  // Editors in the ticket modal report unsaved text here. True when you choose to keep it.
  const [panelDrafts] = useState(createDraftGuard);
  const keepDrafts = useCallback(() => panelDrafts.dirty() && !window.confirm('Discard your unsaved text?'), [panelDrafts]);

  const openPanel = useCallback(
    (subject: { ticket?: string; agent?: string }) => {
      if (!pid) return;
      const onProject = route.kind === 'project';
      const path = projectPath(pid, onProject ? view : 'board', { threadId: onProject ? threadId : undefined, huddleId: onProject ? huddleId : undefined, ...subject });
      const replacing = Boolean(panelTicket || panelAgent);
      // Switching to another ticket or person drops what you typed in this one.
      if (replacing && (subject.ticket !== panelTicket || subject.agent !== panelAgent) && keepDrafts()) return;
      if (!replacing) pushedPanel.current = true;
      navigate(path, replacing);
    },
    [pid, route.kind, view, threadId, huddleId, panelTicket, panelAgent, navigate, keepDrafts],
  );
  const openTicket = useCallback((key: string) => openPanel({ ticket: key }), [openPanel]);
  const openAgent = useCallback((id: string) => openPanel({ agent: id }), [openPanel]);
  // Esc, the backdrop, the close button and Android back all come here. False when the modal stays open.
  const closePanel = useCallback((): boolean => {
    if (!pid || keepDrafts()) return false;
    if (pushedPanel.current) {
      pushedPanel.current = false;
      window.history.back();
    } else navigate(projectPath(pid, view, { threadId, huddleId }), true);
    return true;
  }, [pid, view, threadId, huddleId, navigate, keepDrafts]);
  const openThread = useCallback((id: string) => pid && navigate(projectPath(pid, 'chat', { threadId: id })), [pid, navigate]);
  const openHuddle = useCallback((id: string) => pid && navigate(projectPath(pid, 'huddles', { huddleId: id })), [pid, navigate]);

  const actions = useProjectActions({ pid, state, notify, after, openTicket, openThread, openHuddle });
  const [huddleSetupOpen, setHuddleSetupOpen] = useState(false);

  // The "Include team notes" boxes: hidden when there are no notes.
  const teamNotes = useMemo<TeamNotesInfo | null>(
    () => (state?.teamNotes.trim() ? { tokens: roughTokens(state.teamNotes), always: state.notesEveryRun } : null),
    [state?.teamNotes, state?.notesEveryRun],
  );

  // ---------- create dialog ----------
  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState<CreateKind>('task');
  const openCreate = useCallback(
    (kind: CreateKind = 'task') => {
      if (!pid) {
        navigate('/projects/new');
        return;
      }
      setCreateKind(kind);
      setCreateOpen(true);
    },
    [pid, navigate],
  );

  useHotkeys({
    c: () => openCreate('task'),
    '/': () => searchRef.current?.focus(),
    '[': toggleSidebar,
  });

  // ---------- counts ----------
  const counts = useMemo(() => {
    if (!state) return { needsYou: 0, paused: 0, unread: 0, huddling: false };
    const paused = state.threads.filter((t) => t.status === 'paused').length;
    const proposals = state.huddles.reduce((n, h) => n + h.proposals.filter((x) => x.status === 'pending').length, 0);
    return {
      huddling: state.huddles.some((h) => h.status === 'running'),
      needsYou: state.items.filter((i) => i.status === 'needs-you' || i.status === 'signoff').length + paused + proposals,
      paused,
      unread: state.threads.filter((t) => t.status !== 'closed' && t.count > t.youSeen).length,
    };
  }, [state]);

  // ---------- tab title ----------
  const pageName =
    route.kind === 'projects'
      ? 'Projects'
      : route.kind === 'new'
        ? 'Create project'
        : route.kind === 'settings'
          ? 'Project settings'
          : route.kind === 'connections'
            ? 'Connections'
            : route.kind === 'project'
              ? VIEW_TITLE[view]
              : '';
  useEffect(() => {
    document.title = [panelTicket, pageName, current?.name, 'AI Team HQ'].filter(Boolean).join(' · ');
  }, [panelTicket, pageName, current?.name]);

  // ---------- loading ----------
  if (!projects) {
    return (
      <div className="boot">
        <span className="wordmark-mark" aria-hidden>
          HQ
        </span>
        <p className="muted">{error ? `Cannot reach HQ: ${error}` : 'Opening HQ...'}</p>
      </div>
    );
  }

  const live = meta?.runner === 'claude';
  const owner = state?.agents.find((a) => a.isHuman);
  const crumbs = current ? [<span key="p" className="crumb-project"><ProjectAvatar project={current} size={16} /> {current.name}</span>] : [];

  // ---------- main view ----------
  let body: ReactNode = null;
  let mainClass = 'main';
  if (route.kind === 'projects') {
    body = <ProjectsPage projects={projects} currentId={storage.get(KEYS.lastProject) ?? undefined} onNavigate={navigate} />;
  } else if (route.kind === 'new') {
    body = (
      <ProjectForm
        mode="create"
        projects={projects}
        onCancel={() => window.history.back()}
        onSaved={async (p) => {
          await loadProjects();
          notify(`${p.name} created`, { tone: 'success' });
          navigate(projectPath(p.id));
        }}
      />
    );
  } else if (route.kind === 'settings' && current) {
    body = (
      <ProjectForm
        key={current.id}
        mode="edit"
        project={current}
        projects={projects}
        onCancel={() => navigate(projectPath(current.id))}
        onSaved={async (p) => {
          await loadProjects();
          notify('Saved', { tone: 'success' });
          navigate(projectPath(p.id));
        }}
        onArchived={async () => {
          notify(`${current.name} removed. Its data is in data/archive.`);
          await loadProjects();
          navigate('/projects');
        }}
      />
    );
  } else if (route.kind === 'connections' && current) {
    body = state ? (
      <ConnectionsPanel key={current.id} pid={current.id} agents={state.agents} ownerName={owner?.name ?? 'you'} hasFolder={Boolean(current.path && current.pathOk)} notify={notify} />
    ) : (
      <p className="muted page">Loading...</p>
    );
  } else if (route.kind === 'project' && current) {
    mainClass = `main view-${view}`;
    if (!state) {
      body = <p className="muted page">Opening {current.name}...</p>;
    } else {
      const key = state.project.key;
      const header = (actionsSlot?: ReactNode) => <PageHeader crumbs={crumbs} title={VIEW_TITLE[view]} actions={actionsSlot} />;
      if (view === 'needs-you') {
        body = (
          <div className="page">
            {header()}
            <NeedsYou
              items={state.items}
              agents={state.agents}
              projectKey={key}
              paused={state.threads.filter((t) => t.status === 'paused')}
              huddles={state.huddles}
              onDecideProposal={actions.decideProposal}
              onOpenHuddle={openHuddle}
              onOpen={openTicket}
              onDecide={actions.decide}
              onOpenAgent={openAgent}
              onOpenThread={openThread}
              onResumeThread={actions.resumeThread}
              onCreate={() => openCreate('task')}
            />
          </div>
        );
      } else if (view === 'board') {
        const selected = panelTicket ? state.items.find((i) => ticketKey(i, key) === panelTicket || i.id === panelTicket) : undefined;
        body = (
          <div className="page page-full">
            {header()}
            <Board
              items={state.items}
              agents={state.agents}
              projectKey={key}
              selectedId={selected?.id}
              onOpen={openTicket}
              onMove={actions.move}
              onDragActive={setPollPaused}
              flash={(t) => notify(t)}
              showQa={hasQa(state.project.template)}
            />
          </div>
        );
      } else if (view === 'huddles') {
        const summary = huddleId ? state.huddles.find((h) => h.id === huddleId) : undefined;
        const start = (
          <button type="button" className="btn btn-primary" onClick={() => setHuddleSetupOpen(true)}>
            Start huddle
          </button>
        );
        body = (
          <div className="page">
            {header(huddleId ? undefined : start)}
            {summary ? (
              <HuddleView
                key={summary.id}
                pid={current.id}
                summary={summary}
                agents={state.agents}
                items={state.items}
                projectKey={key}
                notesEveryRun={state.notesEveryRun}
                onBack={() => navigate(projectPath(current.id, 'huddles'))}
                onOpenTicket={openTicket}
                onStop={actions.stopHuddle}
                onResume={actions.resumeHuddle}
                onSteer={actions.steerHuddle}
                onDecide={actions.decideProposal}
              />
            ) : huddleId ? (
              <div className="empty">
                <p className="empty-title">Huddle not found</p>
                <p>It is not on this project any more.</p>
                <button type="button" className="btn btn-outline" onClick={() => navigate(projectPath(current.id, 'huddles'))}>
                  All huddles
                </button>
              </div>
            ) : (
              <HuddleList huddles={state.huddles} agents={state.agents} onOpen={openHuddle} onStart={() => setHuddleSetupOpen(true)} />
            )}
            <HuddleSetup
              open={huddleSetupOpen}
              agents={state.agents}
              live={live}
              startedToday={state.huddleDay.day === new Date().toISOString().slice(0, 10) ? state.huddleDay.started : 0}
              limit={state.huddleLimit}
              onClose={() => setHuddleSetupOpen(false)}
              onStart={actions.startHuddle}
            />
          </div>
        );
      } else if (view === 'notes') {
        body = (
          <div className="page">
            {header()}
            <TeamNotes teamNotes={state.teamNotes} notesEveryRun={state.notesEveryRun} onSave={actions.saveTeamNotes} />
          </div>
        );
      } else if (view === 'team') {
        body = (
          <div className="page">
            {header()}
            <Team agents={state.agents} items={state.items} qa={hasQa(state.project.template)} onSelect={openAgent} onAdd={actions.addAgent} />
          </div>
        );
      } else if (view === 'office') {
        const saying: Record<string, string> = {};
        for (const t of state.threads) {
          const last = t.last;
          if (!last || last.from === 'you' || Date.now() - new Date(last.ts).getTime() > 15_000) continue;
          const to = last.to.map((id) => (id === 'you' ? 'you' : agentById(state.agents, id)?.name)).filter(Boolean);
          if (to.length) saying[last.from] = `@${to[0]}${to.length > 1 ? ` +${to.length - 1}` : ''}`;
        }
        body = (
          <div className="page">
            {header()}
            <Office agents={state.agents} onSelect={openAgent} saying={saying} />
          </div>
        );
      } else {
        const thread = threadId ? state.threads.find((t) => t.id === threadId) : undefined;
        const list = <ThreadList state={state} selectedId={thread?.id} onOpen={openThread} onNew={() => openCreate('thread')} />;
        const pane = thread ? (
          <ChatThread
            key={thread.id}
            pid={current.id}
            thread={thread}
            state={state}
            onBack={chatSplit ? undefined : () => navigate(projectPath(current.id, 'chat'))}
            onOpenTicket={openTicket}
            onChanged={after}
          />
        ) : (
          <div className="thread-pane empty">
            <p className="empty-title">Pick a thread</p>
            <p className="muted">Or start one. Desks you @mention are woken to reply.</p>
            <button type="button" className="btn btn-primary" onClick={() => openCreate('thread')}>
              New thread
            </button>
          </div>
        );
        body = (
          <div className="page page-full">
            {header()}
            {chatSplit ? (
              <div className="chat-split">
                {list}
                {pane}
              </div>
            ) : (
              <div className="chat-single">{thread ? pane : list}</div>
            )}
          </div>
        );
      }
    }
  }

  // ---------- ticket / person modal ----------
  let panel: ReactNode = null;
  let panelKey = '';
  let panelLabel = 'Details';
  let returnFocus: string | undefined;
  if (state && route.kind === 'project') {
    if (panelTicket) {
      const item = state.items.find((i) => ticketKey(i, state.project.key) === panelTicket || i.id === panelTicket);
      panelKey = `t-${panelTicket}`;
      panelLabel = item ? `${panelTicket} ${item.title}` : panelTicket;
      returnFocus = item ? `[data-card="${item.id}"] .bcard-title` : undefined;
      panel = item ? (
        <TicketView
          key={item.id}
          item={item}
          state={state}
          live={live}
          onClose={closePanel}
          onDecide={actions.decide}
          onComment={actions.comment}
          onAttach={actions.attachToItem}
          onEditDescription={actions.editDescription}
          onRun={actions.runItem}
          onMove={actions.move}
          onOpenAgent={openAgent}
          onOpenThread={openThread}
          onDiscuss={(id) => {
            const it = state.items.find((i) => i.id === id);
            const who = it ? agentById(state.agents, it.assignee) : undefined;
            const mention = who && !who.isHuman ? `@${who.name} ` : '';
            void actions.guard(() => actions.startThread(`${mention}Let's discuss ${it ? ticketKey(it, state.project.key) : 'this ticket'}.`, id), 'Could not start the thread');
          }}
        />
      ) : (
        <div className="panel-view">
          <div className="empty">
            <p className="empty-title" tabIndex={-1} data-drawer-title>
              Ticket not found
            </p>
            <p>{panelTicket} is not on this project any more.</p>
            <button type="button" className="btn btn-outline" onClick={closePanel}>
              Close
            </button>
          </div>
        </div>
      );
    } else if (panelAgent) {
      const agent = agentById(state.agents, panelAgent);
      panelKey = `a-${panelAgent}`;
      panelLabel = agent ? agent.name : panelAgent;
      panel = agent ? (
        <AgentPanel
          key={agent.id}
          agent={agent}
          state={state}
          onClose={closePanel}
          onOpenTicket={openTicket}
          onOpenThread={openThread}
          onOpenHuddle={openHuddle}
          onMakeLead={actions.makeLead}
          onSetQa={actions.setQaDesk}
          onRemove={(id) => actions.removeAgent(id, closePanel)}
        />
      ) : null;
    }
  }
  const panelOpen = panel !== null;

  const sidebar = (mode: SidebarMode) => (
    <Sidebar projects={projects} current={current} route={route} counts={counts} mode={mode} onNavigate={navigate} onFollow={() => setOverlayOpen(false)} />
  );

  return (
    <ProjectIdContext.Provider value={pid}>
      <TeamNotesContext.Provider value={teamNotes}>
      <div className={`shell${inlineMode ? ` side-${inlineMode}` : ' side-none'}`}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <TopBar
          ref={searchRef}
          meta={meta}
          ownerName={owner?.name ?? 'You'}
          ownerColor={owner?.color}
          items={state?.items ?? null}
          agents={state?.agents ?? []}
          projectKey={state?.project.key ?? ''}
          sidebarMode={wide ? (collapsed ? 'rail' : 'expanded') : 'overlay'}
          sidebarOpen={wide ? !collapsed : overlayOpen}
          onToggleSidebar={toggleSidebar}
          onCreate={() => openCreate('task')}
          createLabel={pid ? 'Create' : 'Create project'}
          onOpenTicket={openTicket}
          onAllProjects={() => navigate('/projects')}
          theme={theme}
          themePref={pref}
          onThemePref={setPref}
          onToggleTheme={toggle}
          narrow={!mid}
        />
        {inlineMode && <div className="shell-side">{sidebar(inlineMode)}</div>}
        {overlayOpen && !wide && (
          <>
            <div className="scrim" onClick={() => setOverlayOpen(false)} aria-hidden />
            <div className="shell-overlay">{sidebar('overlay')}</div>
          </>
        )}
        <main id="main" className={mainClass} tabIndex={-1}>
          {error && <p className="banner danger main-error">Lost the server: {error}</p>}
          {!live && meta && route.kind === 'project' && view === 'needs-you' && <p className="sim-note muted small">Sim mode: fake activity, no Claude calls.</p>}
          {body}
        </main>
        <PanelModal open={panelOpen} subjectKey={panelKey} label={panelLabel} onClose={closePanel} returnFocus={returnFocus}>
          <DraftGuardProvider value={panelDrafts}>{panel}</DraftGuardProvider>
        </PanelModal>
        {state && current && (
          <CreateModal
            open={createOpen}
            initialKind={createKind}
            agents={state.agents}
            projectName={current.name}
            onClose={() => setCreateOpen(false)}
            onTask={actions.instruct}
            onThread={(text, ids) => actions.startThread(text, undefined, ids)}
          />
        )}
        <Flags flags={flags} dismiss={dismiss} />
      </div>
      </TeamNotesContext.Provider>
    </ProjectIdContext.Provider>
  );
}
