import type { McpServerConfig, McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { presetById } from '../shared/mcpPresets';
import { buildSpec, maskUrl, nameProblem, SCOPE_TO_SOURCE, secretArgs, SOURCE_TO_SCOPE, toolKey, type AddRequest, type BuiltSpec } from '../shared/mcpSpec';
import type {
  AddPreview,
  ConnectionCheck,
  ConnectionMode,
  ConnectionRow,
  ConnectionsResponse,
  ConnectionState,
  McpServerInfo,
  McpSource,
  McpToolInfo,
  ProjectConnection,
} from '../shared/types';
import { configSecrets, discoverAll, discoverServers, gitRoot, isReadOnlyTool, openSession, probeServers, proxyConfigOf, type FoundServer } from './mcp';
import { cancelLogin, cancelLoginsNamed, LoginError, loginOf, loginRunning, loginRunningIn, startLogin } from './mcpAuth';
import { addArgs, claudeJsonPath, cliMessage, logoutArgs, openTerminal, removeArgs, runCli, scrub } from './mcpCli';
import { folderExists } from './paths';
import { allProjects, now, type Project } from './store';

/**
 * Per-project MCP connections: which servers are on, which desks may use them, and in what mode.
 * Only those choices, a fingerprint of the server you turned on, and the last check are stored.
 * Tokens stay in Claude Code's own config, and never reach HQ's data, logs or API.
 *
 * Adding, removing and logging out go through Claude Code's own `claude mcp` commands, so the
 * servers land exactly where Claude Code keeps them. A new server always starts off.
 */

/** fingerprint: the server the check ran against, so a tool list never carries over to another one. Never sent to the page. */
type StoredCheck = ConnectionCheck & { info?: McpServerInfo; proxy?: { url: string; id: string }; fingerprint?: string };

/** A failure with the HTTP status the route should answer with. */
export class ConnectionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const SOURCE_LABEL: Record<McpSource, string> = {
  folder: "this project's settings",
  repo: "the repo's .mcp.json",
  user: 'your settings for all projects',
  'claude-ai': 'claude.ai',
};

function folderOf(p: Project): string | null {
  return p.meta.path && folderExists(p.meta.path) ? p.meta.path : null;
}

function claudeAiInfo(name: string): McpServerInfo {
  return { name, source: 'claude-ai', transport: 'claude-ai', target: 'claude.ai connector', auth: 'oauth' };
}

function defaultConnection(p: Project, info: McpServerInfo): ProjectConnection {
  return { name: info.name, source: info.source, enabled: false, desks: [], mode: 'ask' };
}

/** A server as discovery knows it. claude.ai connectors have no fingerprint. */
type Known = { info: McpServerInfo; fingerprint?: string };

/** A saved connection that now points at a different server than the one you turned on. */
function changedFrom(c: ProjectConnection, k: Known): boolean {
  return c.source !== k.info.source || (c.fingerprint !== undefined && c.fingerprint !== k.fingerprint);
}

/** A check's tool list is for the server it checked. Checks from before HQ kept fingerprints count as current. */
function checkFits(check: StoredCheck | undefined, f: FoundServer): boolean {
  return !check?.fingerprint || check.fingerprint === f.fingerprint;
}

/** What the page gets: the fingerprint stays on the server. */
function shown(c: ProjectConnection): ProjectConnection {
  const { fingerprint: _fingerprint, ...rest } = c;
  return rest;
}

export function listConnections(p: Project): ConnectionsResponse {
  const s = p.state;
  const checks = s.checks as Record<string, StoredCheck>;
  const known = new Map<string, Known>();
  for (const f of discoverServers(folderOf(p))) known.set(f.info.name, f);
  for (const [name, check] of Object.entries(checks)) {
    if (!known.has(name) && check.info?.source === 'claude-ai') known.set(name, { info: check.info });
  }
  const saved = new Map(s.connections.map((c) => [c.name, c]));

  const rows: ConnectionRow[] = [];
  for (const k of known.values()) {
    const { info } = k;
    const c = saved.get(info.name);
    const row: ConnectionRow = { ...info, connection: shown(c ?? defaultConnection(p, info)), check: stripCheck(checks[info.name]), present: true };
    if (c?.enabled && changedFrom(c, k)) row.changed = true;
    const login = loginOf(p.id, info.name);
    if (login) row.login = login;
    rows.push(row);
  }
  // Saved but gone from every config: keep them visible so they can be turned off.
  for (const c of s.connections) {
    if (!known.has(c.name)) {
      rows.push({ name: c.name, source: c.source, transport: 'unknown', target: 'no longer configured', auth: 'none', connection: shown(c), check: stripCheck(checks[c.name]), present: false });
    }
  }
  const order: Record<string, number> = { folder: 0, repo: 1, user: 2, 'claude-ai': 3 };
  rows.sort((a, b) => Number(b.connection.enabled) - Number(a.connection.enabled) || order[a.source] - order[b.source] || a.name.localeCompare(b.name));
  return { rows, lastCheck: s.lastCheck, canTerminal: terminalReady(p) };
}

function stripCheck(check: StoredCheck | undefined): ConnectionCheck | undefined {
  if (!check) return undefined;
  const { info: _info, proxy: _proxy, fingerprint: _fingerprint, ...rest } = check;
  return rest;
}

export interface ConnectionPatch {
  enabled?: boolean;
  desks?: string[];
  mode?: ConnectionMode;
}

export function updateConnection(p: Project, name: string, patch: ConnectionPatch): ProjectConnection | string {
  const s = p.state;
  const row = listConnections(p).rows.find((r) => r.name === name);
  if (!row) return 'Unknown connection. Run a check to find claude.ai connectors.';
  // Gone from Claude Code's setup: turning it on would only wait for whatever takes the name next.
  if (patch.enabled && !row.present && !row.connection.enabled) return `${name} is no longer set up in Claude Code. Add it back first.`;

  let conn = s.connections.find((c) => c.name === name);
  if (!conn) {
    conn = { ...row.connection };
    s.connections.push(conn);
  }
  const desks = new Set(s.agents.filter((a) => !a.isHuman).map((a) => a.id));
  if (patch.enabled !== undefined) {
    // First switch-on: every desk may use it; narrow it down from there.
    if (patch.enabled && !conn.enabled && conn.desks.length === 0 && patch.desks === undefined) conn.desks = [...desks];
    // Turning it on means this server, as it is set up now.
    if (patch.enabled && row.present) {
      const f = discoverServers(folderOf(p)).find((x) => x.info.name === name);
      const check = (s.checks as Record<string, StoredCheck>)[name];
      const moved = conn.source !== row.source || (f !== undefined && conn.fingerprint !== undefined && conn.fingerprint !== f.fingerprint);
      // A tool list of another server says nothing about this one. A check of this very server stays.
      const stale = check?.fingerprint ? !f || check.fingerprint !== f.fingerprint : moved;
      if (stale) delete s.checks[name];
      conn.source = row.source;
      if (f) conn.fingerprint = f.fingerprint;
    }
    conn.enabled = patch.enabled;
  }
  if (patch.desks !== undefined) conn.desks = patch.desks.filter((d) => desks.has(d));
  if (patch.mode !== undefined) conn.mode = patch.mode;
  // A connection that is off never keeps Auto: turned back on, it starts at Ask, so Auto is picked again on purpose.
  const backToAsk = !conn.enabled && conn.mode === 'auto';
  if (backToAsk) conn.mode = 'ask';

  const how = conn.mode === 'read' ? 'read only' : conn.mode === 'auto' ? 'changes run on their own, deletes need approval' : 'changes need approval';
  p.log('you', `${conn.enabled ? 'Connection' : 'Turned off'} ${name}${conn.enabled ? ` for ${conn.desks.length} desk${conn.desks.length === 1 ? '' : 's'}, ${how}` : backToAsk ? ', Auto back to Ask' : ''}`);
  p.commit();
  return conn;
}

function toState(status: string): ConnectionState {
  if (status === 'connected') return 'connected';
  if (status === 'needs-auth') return 'needs-login';
  if (status === 'disabled') return 'disabled';
  return 'failed';
}

function toolsOf(tools: { name: string; annotations?: { readOnly?: boolean; destructive?: boolean } }[] | undefined): McpToolInfo[] {
  return (tools ?? []).map((t) => ({
    name: t.name,
    readOnly: t.annotations?.readOnly,
    destructive: t.annotations?.destructive,
    reads: isReadOnlyTool(t.name, t.annotations),
  }));
}

// One check or change per project at a time.
const busy = new Map<string, 'check' | 'change'>();

/** Exported for tests. */
export async function locked<T>(p: Project, what: 'check' | 'change', fn: () => Promise<T>): Promise<T> {
  const doing = busy.get(p.id);
  if (doing) throw new ConnectionError(doing === 'check' ? 'A check is already running for this project. Wait for it to finish.' : 'Another change is still saving. Wait for it to finish.', 409);
  busy.set(p.id, what);
  try {
    return await fn();
  } finally {
    busy.delete(p.id);
  }
}

/**
 * Connection work running for this project: a check, a change being saved, or a sign-in. Each may run in the
 * project's workspace and logs to the project when done, so removing the project waits for it.
 */
export function connectionWork(pid: string): 'check' | 'change' | 'sign-in' | null {
  return busy.get(pid) ?? (loginRunningIn(pid) ? 'sign-in' : null);
}

// A first `npx` run downloads the package, which can take longer than the usual check.
const LOCAL_CHECK_MS = 90_000;

/**
 * Connect to this project's servers and record status and tools: all of them plus your claude.ai
 * connectors, or only `only`. Sends no prompt and calls no tool, so nothing is read or written
 * through the servers.
 */
export async function checkConnections(p: Project, only?: string[]): Promise<ConnectionsResponse> {
  return locked(p, 'check', async () => {
    const started = now();
    let found = discoverServers(folderOf(p));
    if (only) {
      found = found.filter((f) => only.includes(f.info.name));
      if (found.length === 0) throw new ConnectionError('Nothing to check. Reload the page.', 404);
    }
    const servers = Object.fromEntries(found.map((f) => [f.info.name, f.config]));
    const local = found.some((f) => f.config.type === 'stdio' || f.config.type === undefined);
    const statuses = await probeServers(path.join(p.workspace, '.probe'), servers, !only, only && local ? LOCAL_CHECK_MS : undefined);
    const at = now();
    // An add or remove (here or in another project) may have changed a server while this ran:
    // a result for a definition that is no longer the one set up is dropped, never saved over the new one.
    const latest = new Map(discoverServers(folderOf(p)).map((f) => [f.info.name, f]));
    const current = found.filter((f) => {
      const n = latest.get(f.info.name);
      return n !== undefined && n.info.source === f.info.source && n.fingerprint === f.fingerprint;
    });
    const next: Record<string, StoredCheck> = {};
    for (const st of statuses) {
      const fromFile = current.find((f) => f.info.name === st.name);
      const isClaudeAi = !only && (st.scope === 'claudeai' || st.source === 'claudeai');
      if (!fromFile && !isClaudeAi) continue;
      const proxy = isClaudeAi ? proxyConfigOf(st) : null;
      next[st.name] = {
        state: toState(st.status),
        checkedAt: at,
        // Errors can quote the server's own config: blank its values out, not only token-like words.
        error: st.error ? scrub(st.error, fromFile ? configSecrets(fromFile.config) : []) : undefined,
        tools: toolsOf(st.tools),
        info: isClaudeAi ? claudeAiInfo(st.name) : undefined,
        proxy: proxy ? (proxy as unknown as { url: string; id: string }) : undefined,
        fingerprint: fromFile?.fingerprint,
      };
    }
    // Servers that never reported back are failures, not silent gaps.
    for (const f of current) next[f.info.name] ??= { state: 'failed', checkedAt: at, error: 'Did not answer the check', tools: [], fingerprint: f.fingerprint };
    // A sign-in that finished while this ran knows better than this check.
    const old = p.state.checks as Record<string, StoredCheck>;
    const newer = (name: string) => Boolean(old[name] && old[name].checkedAt > started);
    if (only) {
      for (const [name, c] of Object.entries(next)) if (!newer(name)) old[name] = c;
      const states = Object.entries(next).map(([name, c]) => `${name} ${c.state === 'needs-login' ? 'needs login' : c.state}`);
      if (states.length) p.log('you', `Checked ${states.join(', ')}`);
    } else {
      for (const name of Object.keys(next)) if (newer(name)) next[name] = old[name];
      p.state.checks = next;
      p.state.lastCheck = at;
      const ok = Object.values(next).filter((c) => c.state === 'connected').length;
      p.log('you', `Checked connections: ${ok} of ${Object.keys(next).length} connected`);
    }
    p.commit();
    return listConnections(p);
  });
}

/** A server one desk may use in one run. */
export interface AllowedServer {
  name: string;
  /** Tool prefix: mcp__<key>__ */
  key: string;
  mode: ConnectionMode;
  tools: Record<string, McpToolInfo>;
}

/** Configs for this desk's enabled servers, resolved fresh, plus what the guard needs to judge each tool. */
export function runtimeServers(p: Project, agentId: string): { servers: Record<string, McpServerConfig>; allowed: AllowedServer[] } {
  const s = p.state;
  const checks = s.checks as Record<string, StoredCheck>;
  const mine = s.connections.filter((c) => c.enabled && c.desks.includes(agentId));
  if (mine.length === 0) return { servers: {}, allowed: [] };

  const found = new Map(discoverServers(folderOf(p)).map((f) => [f.info.name, f]));
  const servers: Record<string, McpServerConfig> = {};
  const allowed: AllowedServer[] = [];
  for (const c of mine) {
    const f = found.get(c.name);
    // Turned on for one server, now set up as another: wait until you turn it on again.
    if (f && changedFrom(c, f)) continue;
    let config: McpServerConfig | undefined = f?.config;
    if (!config && c.source === 'claude-ai' && checks[c.name]?.proxy) {
      config = { type: 'claudeai-proxy', ...checks[c.name].proxy } as unknown as McpServerConfig;
    }
    if (!config) continue;
    servers[c.name] = config;
    // The guard trusts a tool's read-only and destructive hints only from a check of this very server.
    const tools = f && !checkFits(checks[c.name], f) ? [] : (checks[c.name]?.tools ?? []);
    allowed.push({ name: c.name, key: toolKey(c.name), mode: c.mode, tools: Object.fromEntries(tools.map((t) => [t.name, t])) });
  }
  return { servers, allowed };
}

// ---------- adding, removing, signing in ----------

/**
 * After Claude Code's setup changed, in every project:
 *   - a saved connection whose name now means a different server, or no server at all, is turned
 *     off and its old tool list dropped, so it can't come back on its own;
 *   - `added` is a server just added: every saved connection that now gets it starts off too, even
 *     one saved before HQ kept fingerprints. That keeps "new servers start off" true;
 *   - tool lists of servers that are gone or changed are dropped, saved connection or not;
 *   - connections saved before HQ kept fingerprints get one, while their source still matches.
 */
function settleSaved(added?: { name: string; source: McpSource }): void {
  for (const proj of allProjects()) {
    const checks = proj.state.checks as Record<string, StoredCheck>;
    const saved = proj.state.connections.filter((c) => c.source !== 'claude-ai');
    const checked = Object.keys(checks).filter((n) => checks[n].info?.source !== 'claude-ai');
    if (saved.length === 0 && checked.length === 0) continue;
    const found = new Map(discoverServers(folderOf(proj)).map((f) => [f.info.name, f]));
    const isNew = (name: string) => added !== undefined && name === added.name && found.get(name)?.info.source === added.source;
    let touched = false;
    for (const c of saved) {
      const f = found.get(c.name);
      if (f && !isNew(c.name) && !changedFrom(c, f)) {
        if (c.fingerprint === undefined) {
          c.fingerprint = f.fingerprint;
          touched = true;
        }
        continue;
      }
      // Gone and already off: the row says so.
      if (!f && !c.enabled) continue;
      if (c.enabled) {
        proj.log('you', f ? `Turned off ${c.name}: its setup in Claude Code changed. Turn it on again to use the new one.` : `Turned off ${c.name}: it is no longer set up in Claude Code.`);
      }
      c.enabled = false;
      if (c.mode === 'auto') c.mode = 'ask';
      if (f) c.source = f.info.source;
      delete c.fingerprint;
      delete checks[c.name];
      touched = true;
    }
    for (const name of checked) {
      const f = found.get(name);
      if (checks[name] && (!f || isNew(name) || !checkFits(checks[name], f))) {
        delete checks[name];
        touched = true;
      }
    }
    if (touched) proj.commit();
  }
}

/** On start: saved connections from before HQ kept fingerprints get one for the server they mean now, while their source still matches. */
export function backfillFingerprints(): void {
  for (const proj of allProjects()) {
    const legacy = proj.state.connections.filter((c) => c.source !== 'claude-ai' && c.fingerprint === undefined);
    if (legacy.length === 0) continue;
    const found = new Map(discoverServers(folderOf(proj)).map((f) => [f.info.name, f]));
    let touched = false;
    for (const c of legacy) {
      const f = found.get(c.name);
      if (f && f.info.source === c.source) {
        c.fingerprint = f.fingerprint;
        touched = true;
      }
    }
    if (touched) proj.commit();
  }
}

function forget(p: Project, name: string): void {
  p.state.connections = p.state.connections.filter((c) => c.name !== name);
  delete p.state.checks[name];
}

function presentRow(p: Project, name: string): ConnectionRow {
  const row = listConnections(p).rows.find((r) => r.name === name);
  if (!row || !row.present) throw new ConnectionError(`${name} is not set up for this project. Reload the page.`, 404);
  return row;
}

function workDir(p: Project): string {
  const dir = folderOf(p) ?? p.workspace;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

interface AddPlan {
  spec: BuiltSpec;
  preview: AddPreview;
}

function planAdd(p: Project, req: AddRequest): AddPlan {
  const spec = buildSpec(req);
  if ('error' in spec) throw new ConnectionError(spec.error, 400);
  const folder = folderOf(p);
  if (spec.scope === 'local' && !folder) throw new ConnectionError("This project has no folder, so it can't have its own settings. Save it for all your projects instead.", 400);
  if (spec.commandPath && !isFile(spec.commandPath)) throw new ConnectionError(`No program was found at ${spec.commandPath}.`, 400);

  const { servers, hidden } = discoverAll(folder);
  const all = [...servers, ...hidden];
  const source = SCOPE_TO_SOURCE[spec.scope];
  if (all.some((f) => f.info.name === spec.name && f.info.source === source)) {
    throw new ConnectionError(`${spec.name} is already set up in ${SOURCE_LABEL[source]}. Remove it first, or pick another name.`, 409);
  }
  // Tool names use the server name with odd characters swapped for _: two names must not end up the same.
  const names = new Set([...all.map((f) => f.info.name), ...Object.keys(p.state.checks), ...p.state.connections.map((c) => c.name)]);
  for (const n of names) {
    if (n !== spec.name && toolKey(n) === toolKey(spec.name)) throw new ConnectionError(`${spec.name} is too close to ${n}, which is already set up. Pick another name.`, 409);
  }

  const warnings: string[] = [];
  const effective = servers.find((f) => f.info.name === spec.name);
  if (effective) {
    const rank: Record<string, number> = { user: 0, repo: 1, folder: 2 };
    warnings.push(
      rank[source] > rank[effective.info.source]
        ? `This replaces the ${spec.name} from ${SOURCE_LABEL[effective.info.source]} in this project. If that one is turned on anywhere it's affected, HQ turns it off.`
        : `The ${spec.name} in ${SOURCE_LABEL[effective.info.source]} comes first in this project, so this one stays hidden here.`,
    );
  }
  if (spec.scope === 'user') warnings.push('Every HQ project and every Claude Code session on this PC will see it. In HQ it stays off until you turn it on in a project.');
  if (spec.config.type === 'stdio' && spec.custom && secretArgs(spec.config.args).length > 0) {
    warnings.push('An argument looks like a token. Other programs on this PC can read arguments every time the server runs. Put tokens under Environment instead.');
  }
  if (spec.config.type !== 'stdio' && maskUrl(spec.config.url).secrets.length > 0) {
    warnings.push('The URL looks like it holds a token. HQ masks it, but Claude Code saves it as written. Use a header for it if the server allows that.');
  }
  // add-json takes the whole config on its command line: there is no other way in.
  if (spec.secrets.length > 0) {
    warnings.push(
      'While Claude Code saves this, other programs on this PC can briefly see every value, secrets too. To keep a token out entirely, enter ${MY_TOKEN} instead (not marked Secret) and set MY_TOKEN in your environment.',
    );
  }
  const location = spec.scope === 'local' ? `${claudeJsonPath()}, under ${gitRoot(folder!) ?? folder}` : `${claudeJsonPath()}, for all projects`;
  return { spec, preview: { preview: spec.preview, runs: spec.runs, location, warnings } };
}

/** What adding would save, masked, for you to review. Changes nothing. */
export function previewAdd(p: Project, req: AddRequest): AddPreview {
  return planAdd(p, req).preview;
}

function describeKind(spec: BuiltSpec, req: AddRequest): string {
  if (req.preset) return presetById(req.preset)?.title ?? 'preset';
  return spec.config.type === 'stdio' ? 'local command' : spec.config.type === 'sse' ? 'SSE' : 'HTTP';
}

/** Save a new server with `claude mcp add-json`. It starts off; `confirm` must be the preview you reviewed. */
export async function addConnection(p: Project, req: AddRequest, confirm: string | undefined): Promise<ConnectionsResponse> {
  return locked(p, 'change', async () => {
    const { spec, preview } = planAdd(p, req);
    if (spec.custom && spec.config.type === 'stdio' && !req.trustCommand) throw new ConnectionError('Tick "I trust this command" to add it.', 400);
    if (confirm !== preview.preview) throw new ConnectionError('The details changed since you reviewed them. Review them again.', 409);
    // A server for all projects replaces the name in every project, so a sign-in in any of them counts.
    const everywhere = spec.scope === 'user';
    if (loginRunning(everywhere ? null : p.id, spec.name)) throw new ConnectionError(`A sign-in for ${spec.name} is running. Cancel it first.`, 409);

    const r = await runCli(addArgs(spec), { cwd: workDir(p), secrets: spec.secrets });
    if (r.code !== 0) throw new ConnectionError(cliMessage(r, 'Claude Code could not save it.'), r.timedOut ? 504 : 400);
    if (everywhere) cancelLoginsNamed(spec.name);
    settleSaved({ name: spec.name, source: SCOPE_TO_SOURCE[spec.scope] });

    const warnings: string[] = [];
    const seen = discoverServers(folderOf(p)).find((f) => f.info.name === spec.name);
    if (!seen) warnings.push(`Claude Code saved it, but HQ can't see it for this project's folder. Check ${claudeJsonPath()}.`);
    else if (seen.info.source !== SCOPE_TO_SOURCE[spec.scope]) warnings.push(`Saved, but the ${spec.name} in ${SOURCE_LABEL[seen.info.source]} comes first in this project.`);
    p.log('you', `Added ${spec.name} (${describeKind(spec, req)}) to ${SOURCE_LABEL[SCOPE_TO_SOURCE[spec.scope]]}. It is off until you turn it on.`);
    p.commit();
    return { ...listConnections(p), added: spec.name, warnings };
  });
}

/**
 * Remove a server from the place `source` says, with `claude mcp remove`. That also clears its
 * saved sign-in. A row whose config is already gone is just forgotten.
 */
export async function removeConnection(p: Project, name: string, source: string): Promise<ConnectionsResponse> {
  return locked(p, 'change', async () => {
    const row = listConnections(p).rows.find((r) => r.name === name);
    if (!row) throw new ConnectionError(`${name} is not set up for this project. Reload the page.`, 404);
    if (row.source === 'claude-ai') throw new ConnectionError('claude.ai connectors are managed in claude.ai, Settings, Connectors.', 400);
    if (!row.present) {
      forget(p, name);
      p.log('you', `Forgot ${name}`);
      p.commit();
      return listConnections(p);
    }
    if (row.source !== source) throw new ConnectionError(`${name} changed since this page loaded. Reload and try again.`, 409);
    const everywhere = row.source === 'user';
    if (loginRunning(everywhere ? null : p.id, name)) throw new ConnectionError(`A sign-in for ${name} is running. Cancel it first.`, 409);
    const scope = SOURCE_TO_SCOPE[row.source];
    if (!scope) throw new ConnectionError(`${name} can't be removed from here.`, 400);

    const r = await runCli(removeArgs(name, scope), { cwd: workDir(p) });
    if (r.code !== 0) throw new ConnectionError(cliMessage(r, 'Claude Code could not remove it.'), r.timedOut ? 504 : 400);
    if (everywhere) cancelLoginsNamed(name);
    else cancelLogin(p.id, name);
    settleSaved();

    const warnings: string[] = [];
    const still = discoverServers(folderOf(p)).find((f) => f.info.name === name);
    if (still) warnings.push(`The ${name} in ${SOURCE_LABEL[still.info.source]} shows through now. It is off.`);
    else forget(p, name);
    p.log('you', `Removed ${name} from ${SOURCE_LABEL[row.source]}`);
    p.commit();
    return { ...listConnections(p), warnings };
  });
}

function recordCheck(p: Project, f: FoundServer, st: McpServerStatus): void {
  const check: StoredCheck = {
    state: toState(st.status),
    checkedAt: now(),
    error: st.error ? scrub(st.error, configSecrets(f.config)) : undefined,
    tools: toolsOf(st.tools),
    fingerprint: f.fingerprint,
  };
  p.state.checks[f.info.name] = check;
  p.commit();
}

function webRow(p: Project, name: string): ConnectionRow {
  const row = presentRow(p, name);
  if (row.source === 'claude-ai') throw new ConnectionError('Sign in to claude.ai connectors in claude.ai, Settings, Connectors.', 400);
  if (row.transport !== 'http' && row.transport !== 'sse') throw new ConnectionError('Only servers reached by URL have a sign-in.', 400);
  return row;
}

/** Start signing in to a server that needs it. The row shows the sign-in page once the server gives one. */
export function loginConnection(p: Project, name: string): ConnectionsResponse {
  webRow(p, name);
  if (busy.get(p.id) === 'change') throw new ConnectionError('Another change is still saving. Wait for it to finish.', 409);
  const found = discoverServers(folderOf(p)).find((f) => f.info.name === name);
  if (!found) throw new ConnectionError(`${name} is not set up for this project. Reload the page.`, 404);
  try {
    startLogin(p, name, found.config, {
      onConnected: (st) => {
        // Its setup changed while you signed in: that tool list belongs to the old one.
        const still = discoverServers(folderOf(p)).find((f) => f.info.name === name);
        if (!still || still.info.source !== found.info.source || still.fingerprint !== found.fingerprint) return;
        recordCheck(p, found, st);
        p.log('you', `Logged in to ${name}`);
      },
    });
  } catch (e) {
    if (e instanceof LoginError) throw new ConnectionError(e.message, e.status);
    throw e;
  }
  return listConnections(p);
}

export function cancelConnectionLogin(p: Project, name: string): ConnectionsResponse {
  if (!cancelLogin(p.id, name)) throw new ConnectionError('No sign-in is running for it.', 404);
  return listConnections(p);
}

/** Clear a server's saved sign-in with `claude mcp logout`, or the session's own call if that refuses. */
export async function logoutConnection(p: Project, name: string): Promise<ConnectionsResponse> {
  return locked(p, 'change', async () => {
    webRow(p, name);
    if (loginRunning(p.id, name)) throw new ConnectionError(`A sign-in for ${name} is running. Cancel it first.`, 409);
    const r = await runCli(logoutArgs(name), { cwd: workDir(p) });
    if (r.code !== 0) {
      let cleared = false;
      const found = discoverServers(folderOf(p)).find((f) => f.info.name === name);
      if (found) {
        const session = openSession(path.join(p.workspace, '.probe'), { [name]: found.config }, false);
        const q = session.q as typeof session.q & { mcpClearAuth?: (n: string) => Promise<unknown> };
        try {
          if (typeof q.mcpClearAuth === 'function') {
            await q.mcpClearAuth(name);
            cleared = true;
          }
        } catch {
          /* fall through to the CLI's message */
        } finally {
          await session.close();
        }
      }
      if (!cleared) throw new ConnectionError(cliMessage(r, 'Could not log out.'), 400);
    }
    p.state.checks[name] = { state: 'needs-login', checkedAt: now(), tools: [] };
    p.log('you', `Logged out of ${name}`);
    p.commit();
    return listConnections(p);
  });
}

/** Windows Terminal in the project's folder. Hidden when HQ uses its own Claude config dir, since the terminal would not. */
function terminalReady(p: Project): boolean {
  return process.platform === 'win32' && !process.env.CLAUDE_CONFIG_DIR && Boolean(folderOf(p));
}

/** Open your own terminal in the project folder, optionally running `claude mcp login <name>` there. */
export async function openProjectTerminal(p: Project, loginName?: string): Promise<void> {
  // The name goes on a command line. Names from a repo's .mcp.json or a hand edit are never checked, so check here.
  if (loginName !== undefined && nameProblem(loginName) !== null) {
    throw new ConnectionError("HQ can't open a terminal for that name. Open Claude Code in the project folder, run /mcp, and log in there.", 400);
  }
  if (!terminalReady(p)) throw new ConnectionError(folderOf(p) ? 'Opening a terminal is not available here.' : 'This project has no folder to open.', 400);
  if (loginName !== undefined) webRow(p, loginName);
  try {
    await openTerminal(folderOf(p)!, loginName);
  } catch (e) {
    throw new ConnectionError(e instanceof Error ? e.message : 'Could not open a terminal.', 501);
  }
  p.log('you', loginName ? `Opened a terminal to log in to ${loginName}` : 'Opened a terminal in the project folder');
}
