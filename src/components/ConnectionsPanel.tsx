import { useCallback, useEffect, useState } from 'react';
import type { Agent, ConnectionMode, ConnectionRow, ConnectionsResponse, ConnectionState, McpSource } from '../../shared/types';
import { api } from '../api';
import { timeAgo } from '../util';

interface Props {
  pid: string;
  agents: Agent[];
  ownerName: string;
  hasFolder: boolean;
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

function loginHint(row: ConnectionRow): string {
  if (row.source === 'claude-ai') return 'Connect it in claude.ai, Settings, Connectors, then check again.';
  return 'Open Claude Code in the project folder, run /mcp, and log in to this server. Then check again.';
}

export function ConnectionsPanel({ pid, agents, ownerName, hasFolder }: Props) {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const desks = agents.filter((a) => !a.isHuman);

  const load = useCallback(async () => {
    try {
      setData(await api.connections(pid));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load connections');
    }
  }, [pid]);

  useEffect(() => {
    void load();
  }, [load]);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setData(await api.checkConnections(pid));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setChecking(false);
    }
  };

  const update = async (row: ConnectionRow, body: { enabled?: boolean; desks?: string[]; mode?: ConnectionMode }) => {
    setBusy(row.name);
    setError(null);
    try {
      setData(await api.updateConnection(pid, row.name, body));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  const toggleDesk = (row: ConnectionRow, id: string) => {
    const has = row.connection.desks.includes(id);
    void update(row, { desks: has ? row.connection.desks.filter((d) => d !== id) : [...row.connection.desks, id] });
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
            {state === 'needs-login' && <span className="conn-note">{loginHint(row)}</span>}
            {state === 'failed' && row.check?.error && <span className="conn-note bad">{row.check.error}</span>}
            {!row.present && <span className="conn-note bad">No longer in any config. Turn it off or add it back.</span>}
          </span>
          <label className="switch" title={on ? 'Turn off' : 'Turn on'}>
            <input type="checkbox" checked={on} disabled={busy === row.name} onChange={(e) => void update(row, { enabled: e.target.checked })} />
            <span className="switch-track" aria-hidden />
            <span className="sr-only">{on ? `Turn off ${row.name}` : `Turn on ${row.name}`}</span>
          </label>
        </div>

        {on && (
          <div className="conn-config">
            <div className="conn-modes" role="group" aria-label={`${row.name} mode`}>
              <button
                type="button"
                className={`seg${row.connection.mode === 'ask' ? ' on' : ''}`}
                aria-pressed={row.connection.mode === 'ask'}
                disabled={busy === row.name}
                onClick={() => void update(row, { mode: 'ask' })}
              >
                Ask before changes
              </button>
              <button
                type="button"
                className={`seg${row.connection.mode === 'read' ? ' on' : ''}`}
                aria-pressed={row.connection.mode === 'read'}
                disabled={busy === row.name}
                onClick={() => void update(row, { mode: 'read' })}
              >
                Read only
              </button>
              <button
                type="button"
                className={`seg${row.connection.mode === 'auto' ? ' on' : ''}`}
                aria-pressed={row.connection.mode === 'auto'}
                disabled={busy === row.name}
                onClick={() => {
                  if (row.connection.mode === 'auto') return;
                  // It acts as you on that service, so make it a deliberate choice.
                  if (
                    !window.confirm(
                      `Desks will post and change things on ${row.name} as ${ownerName}, without asking you first. Deleting or removing anything still waits for your approval, but HQ can't fully see inside tools that run code, scripts or batches, so a delete there can slip through. What desks read (issues, pages, the web) can also steer what they do. Turn on Auto?`,
                    )
                  )
                    return;
                  void update(row, { mode: 'auto' });
                }}
              >
                Auto
              </button>
            </div>
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
                    <button key={a.id} type="button" className={`mention-chip${picked ? ' on' : ''}`} disabled={busy === row.name} onClick={() => toggleDesk(row, a.id)}>
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
        <button type="button" className="btn btn-outline" disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking...' : 'Check connections'}
        </button>
      </div>
      <p className="muted conn-intro">
        MCP servers act as {ownerName}. Anything posted shows up under your name. Reading runs on its own. With Ask before changes, anything that posts or
        changes something waits for your approval in Needs you. With Auto, it runs on its own, except deletes.
        {data?.lastCheck ? ` Last checked ${timeAgo(data.lastCheck)}.` : ' Run a check to see status and to find your claude.ai connectors.'}
      </p>
      {error && <p className="banner danger">{error}</p>}
      {checking && <p className="small muted">Connecting to each server. No prompts are sent and no tools are called. This takes about 10 seconds.</p>}

      <h4 className="section-label conn-group">From {hasFolder ? 'the project folder' : 'your settings'}</h4>
      {fileRows.length ? <ul className="conn-list">{fileRows.map(renderRow)}</ul> : <p className="small muted">No MCP servers are configured {hasFolder ? 'for this folder' : 'in your user settings'}.</p>}

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
    </section>
  );
}
