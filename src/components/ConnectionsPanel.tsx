import { Plus, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, ConnectionMode, ConnectionRow, ConnectionsResponse, ConnectionState, McpSource } from '../../shared/types';
import { api } from '../api';
import type { Notify } from '../hooks/useFlags';
import { ConfirmInline } from '../ui/ConfirmInline';
import { timeAgo } from '../util';
import { AddConnectionModal } from './connections/AddConnectionModal';
import { canSignIn, GptRow, RowActions, type RowActionHandlers } from './connections/ConnectionActions';

interface Props {
  pid: string;
  agents: Agent[];
  ownerName: string;
  hasFolder: boolean;
  notify: Notify;
}

const SOURCE_LABEL: Record<McpSource, string> = {
  folder: 'your settings for this folder',
  repo: "repo's .mcp.json",
  user: 'your user settings',
  'claude-ai': 'claude.ai',
};

const STATE_LABEL: Record<ConnectionState, string> = {
  connected: 'connected',
  'needs-login': 'needs login',
  failed: 'failed',
  disabled: 'disabled',
  unchecked: 'not checked',
};

function loginHint(row: ConnectionRow): string | null {
  if (row.source === 'claude-ai') return 'Connect it in claude.ai, Settings, Connectors, then check again.';
  // Web servers get a Log in button, or a note that their token was refused.
  if (row.transport === 'http' || row.transport === 'sse') return null;
  return 'Open Claude Code in the project folder, run /mcp, and log in to this server. Then check again.';
}

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

// A second click on Remove counts for this long.
const REMOVE_ARMED_MS = 5_000;

export function ConnectionsPanel({ pid, agents, ownerName, hasFolder, notify }: Props) {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [checking, setChecking] = useState(false);
  // Rows with an action on its way. Each row has its own, so one finishing never frees another.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  // The connection whose switch to Auto waits for your yes.
  const [confirmAuto, setConfirmAuto] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  // A fresh form after every close, so typed secrets never stay in memory.
  const [addKey, setAddKey] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Bumped whenever an action starts or ends: a reload that began before then is older than what's shown.
  const version = useRef(0);
  const desks = agents.filter((a) => !a.isHuman);

  const load = useCallback(async () => {
    const v = ++version.current;
    try {
      const res = await api.connections(pid);
      if (version.current === v) setData(res);
    } catch (e) {
      if (version.current === v) setError(msg(e, 'Could not load connections'));
    }
  }, [pid]);

  // Swap the form for a fresh one once it has closed (and focus has gone back), so nothing typed stays mounted.
  useEffect(() => {
    if (!adding) setAddKey((k) => k + 1);
  }, [adding]);

  // A Remove click that isn't followed up disarms on its own.
  useEffect(() => {
    if (!confirmRemove) return;
    const t = window.setTimeout(() => setConfirmRemove(null), REMOVE_ARMED_MS);
    return () => window.clearTimeout(t);
  }, [confirmRemove]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a sign-in runs, follow it; and look again whenever you come back from the browser.
  const signingIn = (data?.rows ?? []).some((r) => (r.login && r.login.state !== 'failed') || (r.gpt?.login && r.gpt.login.state !== 'failed'));
  useEffect(() => {
    if (!signingIn) return;
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [signingIn, load]);
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // Say so when a sign-in finishes, for Claude or for GPT.
  const wasSigningIn = useRef(new Set<string>());
  const wasGptSigningIn = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set<string>();
    const gptNow = new Set<string>();
    for (const r of data?.rows ?? []) {
      if (r.login && r.login.state !== 'failed') now.add(r.name);
      else if (wasSigningIn.current.has(r.name) && !r.login && r.check?.state === 'connected') notify(`Logged in to ${r.name}`, { tone: 'success' });
      if (r.gpt?.login && r.gpt.login.state !== 'failed') gptNow.add(r.name);
      else if (wasGptSigningIn.current.has(r.name) && !r.gpt?.login && r.gpt?.state === 'signed-in') notify(`Signed in to ${r.name} for GPT`, { tone: 'success' });
    }
    wasSigningIn.current = now;
    wasGptSigningIn.current = gptNow;
  }, [data, notify]);

  const check = async () => {
    setChecking(true);
    setError(null);
    version.current++;
    try {
      const res = await api.checkConnections(pid);
      version.current++;
      setData(res);
    } catch (e) {
      setError(msg(e, 'Check failed'));
    } finally {
      setChecking(false);
    }
  };

  const markBusy = (name: string, on: boolean) =>
    setBusy((b) => {
      const next = new Set(b);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  /** Run one row's action; show its warnings, and an error in the banner. */
  const act = async (row: ConnectionRow, run: () => Promise<ConnectionsResponse>, done?: (res: ConnectionsResponse) => void) => {
    markBusy(row.name, true);
    setError(null);
    setConfirmRemove(null);
    setConfirmAuto((c) => (c === row.name ? null : c));
    version.current++;
    let res: ConnectionsResponse | null = null;
    try {
      res = await run();
      version.current++;
      setData(res);
      for (const w of res.warnings ?? []) notify(w, { tone: 'warning' });
    } catch (e) {
      setError(msg(e, 'That did not work'));
    } finally {
      markBusy(row.name, false);
    }
    // After the row is free again, so a follow-up action (a check) can mark it busy itself.
    if (res) done?.(res);
  };

  /** After turning a row on: if HQ dropped its old tool list (another server than before), check this one. */
  const checkIfCleared = (row: ConnectionRow) => (res: ConnectionsResponse) => {
    const after = res.rows.find((r) => r.name === row.name);
    if (after?.present && after.connection.enabled && row.check && !after.check) checkOne(after);
  };

  const update = (row: ConnectionRow, body: { enabled?: boolean; desks?: string[]; mode?: ConnectionMode }) =>
    void act(row, () => api.updateConnection(pid, row.name, body), body.enabled ? checkIfCleared(row) : undefined);

  const toggleDesk = (row: ConnectionRow, id: string) => {
    const has = row.connection.desks.includes(id);
    update(row, { desks: has ? row.connection.desks.filter((d) => d !== id) : [...row.connection.desks, id] });
  };

  const checkOne = (row: ConnectionRow, afterAdd = false) =>
    void act(
      row,
      () => api.checkConnections(pid, [row.name]),
      (res) => {
        const c = res.rows.find((r) => r.name === row.name)?.check;
        if (!c) return;
        if (c.state === 'connected') notify(afterAdd ? `${row.name} is connected. Turn it on to let desks use it.` : `${row.name} is connected`, { tone: 'success' });
        else if (c.state === 'needs-login') notify(`${row.name} needs you to log in`, { tone: 'warning' });
        else if (c.state === 'failed') notify(`${row.name}: ${c.error ?? 'the check failed'}`, { tone: 'danger' });
      },
    );

  const handlers: RowActionHandlers = {
    check: (row) => checkOne(row),
    login: (row) => void act(row, () => api.loginConnection(pid, row.name)),
    cancelLogin: (row) => void act(row, () => api.cancelLogin(pid, row.name)),
    gptLogin: (row) => void act(row, () => api.gptLoginConnection(pid, row.name)),
    cancelGptLogin: (row) => void act(row, () => api.cancelGptLogin(pid, row.name)),
    gptLogout: (row) => void act(row, () => api.gptLogoutConnection(pid, row.name), () => notify(`Signed out of ${row.name} for GPT`, { tone: 'success' })),
    logout: (row) => void act(row, () => api.logoutConnection(pid, row.name), () => notify(`Logged out of ${row.name}`, { tone: 'success' })),
    remove: (row) => {
      if (row.present && confirmRemove !== row.name) {
        setConfirmRemove(row.name);
        return;
      }
      void act(row, () => api.removeConnection(pid, row.name, row.source), () => notify(row.present ? `Removed ${row.name}` : `Forgot ${row.name}`, { tone: 'success' }));
    },
    disarmRemove: (row) => setConfirmRemove((c) => (c === row.name ? null : c)),
    terminalLogin: (row) => {
      api
        .openTerminal(pid, row.name)
        .then(() => notify('Opened Windows Terminal. Log in there, then click Check.', { tone: 'info' }))
        .catch((e) => setError(msg(e, 'Could not open a terminal')));
    },
    // Its old tool list was for the old setup: check the new one straight after.
    useNewSetup: (row) =>
      void act(
        row,
        () => api.updateConnection(pid, row.name, { enabled: true }),
        (res) => {
          const after = res.rows.find((r) => r.name === row.name);
          if (after?.present) checkOne(after);
        },
      ),
  };

  const openTerminal = () => {
    api
      .openTerminal(pid)
      .then(() => notify('Opened Windows Terminal in the project folder', { tone: 'info' }))
      .catch((e) => setError(msg(e, 'Could not open a terminal')));
  };

  const onAdded = (res: ConnectionsResponse) => {
    setAdding(false);
    setData(res);
    for (const w of res.warnings ?? []) notify(w, { tone: 'warning' });
    const row = res.rows.find((r) => r.name === res.added);
    if (!row) return;
    notify(`Added ${row.name}. Checking it now...`, { tone: 'success' });
    checkOne(row, true);
  };

  const rows = data?.rows ?? [];
  const fileRows = rows.filter((r) => r.source !== 'claude-ai');
  const claudeRows = rows.filter((r) => r.source === 'claude-ai');
  // claude.ai connectors that aren't logged in are noise until you want one.
  const usable = (r: ConnectionRow) => r.connection.enabled || r.check?.state === 'connected';
  const notLoggedIn = claudeRows.filter((r) => !usable(r)).length;
  const claudeVisible = showAll ? claudeRows : claudeRows.filter(usable);

  const renderRow = (row: ConnectionRow) => {
    const state: ConnectionState = row.check?.state ?? 'unchecked';
    const tools = row.check?.tools ?? [];
    const reads = tools.filter((t) => t.reads).length;
    const on = row.connection.enabled;
    const hint = state === 'needs-login' && !canSignIn(row) ? loginHint(row) : null;
    return (
      <li key={row.name} className={`conn${on ? ' on' : ''}${row.present ? '' : ' gone'}`}>
        <div className="conn-head">
          <span className={`conn-dot st-${state}`} title={STATE_LABEL[state]} />
          <span className="conn-body">
            <span className="conn-name">{row.name}</span>
            <span className="conn-sub">
              {SOURCE_LABEL[row.source]} · {STATE_LABEL[state]}
              {tools.length > 0 && ` · ${tools.length} tools, ${reads} only read`}
            </span>
            {row.target && row.source !== 'claude-ai' && <span className="conn-target mono">{row.target}</span>}
            {hint && <span className="conn-note">{hint}</span>}
            {state === 'failed' && row.check?.error && <span className="conn-note bad">{row.check.error}</span>}
            {!row.present && <span className="conn-note bad">No longer in any config. Turn it off, forget it, or add it back.</span>}
          </span>
          <label className="switch" title={on ? 'Turn off' : 'Turn on'}>
            {/* A server that is gone can be turned off, not on. */}
            <input type="checkbox" checked={on} disabled={busy.has(row.name) || (!row.present && !on)} onChange={(e) => update(row, { enabled: e.target.checked })} />
            <span className="switch-track" aria-hidden />
            <span className="sr-only">{on ? `Turn off ${row.name}` : `Turn on ${row.name}`}</span>
          </label>
        </div>

        {row.source !== 'claude-ai' && (
          <div className="conn-extra">
            <RowActions row={row} busy={busy.has(row.name)} confirming={confirmRemove === row.name} canTerminal={Boolean(data?.canTerminal)} on={handlers} />
          </div>
        )}
        {row.gpt && row.present && <GptRow row={row} busy={busy.has(row.name)} on={handlers} />}

        {on && (
          <div className="conn-config">
            <div className="conn-modes" role="group" aria-label={`${row.name} mode`}>
              <button
                type="button"
                className={`seg${row.connection.mode === 'ask' ? ' on' : ''}`}
                aria-pressed={row.connection.mode === 'ask'}
                disabled={busy.has(row.name)}
                onClick={() => update(row, { mode: 'ask' })}
              >
                Ask before changes
              </button>
              <button
                type="button"
                className={`seg${row.connection.mode === 'read' ? ' on' : ''}`}
                aria-pressed={row.connection.mode === 'read'}
                disabled={busy.has(row.name)}
                onClick={() => update(row, { mode: 'read' })}
              >
                Read only
              </button>
              <button
                type="button"
                className={`seg${row.connection.mode === 'auto' ? ' on' : ''}`}
                aria-pressed={row.connection.mode === 'auto'}
                disabled={busy.has(row.name)}
                onClick={() => {
                  // It acts as you on that service, so it waits for a yes in the page.
                  if (row.connection.mode !== 'auto') setConfirmAuto(row.name);
                }}
              >
                Auto
              </button>
            </div>
            {confirmAuto === row.name && row.connection.mode !== 'auto' && (
              <ConfirmInline
                title={`Turn on Auto for ${row.name}?`}
                confirmLabel="Turn on Auto"
                busy={busy.has(row.name)}
                onConfirm={() => {
                  setConfirmAuto(null);
                  update(row, { mode: 'auto' });
                }}
                onCancel={() => setConfirmAuto(null)}
              >
                Desks will post and change things on {row.name} as {ownerName}, without asking you first. Deleting or removing anything still waits for your approval, but
                HQ can't fully see inside tools that run code, scripts or batches, so a delete there can slip through. What desks read (issues, pages, the web) can also
                steer what they do.
              </ConfirmInline>
            )}
            {row.connection.mode === 'auto' && (
              <p className="field-hint conn-auto-note">
                <span className="warn">Auto:</span> desks change things on {row.name} as you without asking. Deletes still wait for your approval, but ones hidden inside code,
                scripts or batches can slip through, and what desks read can steer them. Every change shows in the activity feed. Turning it off puts it back on Ask.
              </p>
            )}
            <div className="conn-desks">
              <span className="label">Desks</span>
              <div className="chips">
                {desks.map((a) => {
                  const picked = row.connection.desks.includes(a.id);
                  return (
                    <button key={a.id} type="button" className={`mention-chip${picked ? ' on' : ''}`} disabled={busy.has(row.name)} onClick={() => toggleDesk(row, a.id)}>
                      <span className="dot" style={{ background: a.color }} />
                      {a.name}
                    </button>
                  );
                })}
              </div>
              {row.connection.desks.length === 0 && <span className="field-hint bad">No desk can use it until you pick one.</span>}
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="page narrow-page connections">
      <div className="page-head">
        <h3 className="page-title">Connections</h3>
        <div className="conn-head-actions">
          {data?.canTerminal && (
            <button type="button" className="btn btn-ghost" title="Open Windows Terminal in the project folder" onClick={openTerminal}>
              <SquareTerminal size={16} aria-hidden /> Open terminal
            </button>
          )}
          <button type="button" className="btn btn-outline" disabled={checking} onClick={() => void check()}>
            {checking ? 'Checking...' : 'Check connections'}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden /> Add connection
          </button>
        </div>
      </div>
      <p className="muted conn-intro">
        MCP servers act as {ownerName}. Anything posted shows up under your name. Reading runs on its own. With Ask before changes, anything that posts or
        changes something waits for your approval in Needs you. With Auto, it runs on its own, except deletes.
        {data?.lastCheck ? ` Last checked ${timeAgo(data.lastCheck)}.` : ' Run a check to see status and to find your claude.ai connectors.'}
      </p>
      {error && <p className="banner danger">{error}</p>}
      {checking && <p className="small muted">Connecting to each server. No prompts are sent and no tools are called. This takes about 10 seconds.</p>}

      <h4 className="section-label conn-group">From {hasFolder ? 'the project folder' : 'your settings'}</h4>
      {fileRows.length ? (
        <ul className="conn-list">{fileRows.map(renderRow)}</ul>
      ) : (
        <p className="small muted">No MCP servers are configured {hasFolder ? 'for this folder' : 'in your user settings'}. Use Add connection to set one up.</p>
      )}

      <h4 className="section-label conn-group">claude.ai connectors</h4>
      {claudeRows.length === 0 ? (
        <p className="small muted">None found yet. Run a check.</p>
      ) : (
        <>
          <ul className="conn-list">{claudeVisible.map(renderRow)}</ul>
          {notLoggedIn > 0 && (
            <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
              {showAll ? `Hide the ${notLoggedIn} not logged in` : `Show ${notLoggedIn} more that ${notLoggedIn === 1 ? 'is' : 'are'} not logged in`}
            </button>
          )}
        </>
      )}

      <AddConnectionModal key={addKey} open={adding} onClose={() => setAdding(false)} pid={pid} rows={rows} hasFolder={hasFolder} onAdded={onAdded} />
    </section>
  );
}
