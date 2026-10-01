import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import type {
  ConnectionCheck,
  ConnectionMode,
  ConnectionRow,
  ConnectionsResponse,
  ConnectionState,
  McpServerInfo,
  McpToolInfo,
  ProjectConnection,
} from '../shared/types';
import { discoverServers, isReadOnlyTool, probeServers, proxyConfigOf, toolKey } from './mcp';
import { folderExists } from './paths';
import { now, type Project } from './store';

/**
 * Per-project MCP connections: which servers are on, which desks may use them, and in what mode.
 * Only those choices and the last check are stored. Tokens stay in Claude Code's own config.
 */

type StoredCheck = ConnectionCheck & { info?: McpServerInfo; proxy?: { url: string; id: string } };

function folderOf(p: Project): string | null {
  return p.meta.path && folderExists(p.meta.path) ? p.meta.path : null;
}

function claudeAiInfo(name: string): McpServerInfo {
  return { name, source: 'claude-ai', transport: 'claude-ai', target: 'claude.ai connector', auth: 'oauth' };
}

function defaultConnection(p: Project, info: McpServerInfo): ProjectConnection {
  return { name: info.name, source: info.source, enabled: false, desks: [], mode: 'ask' };
}

export function listConnections(p: Project): ConnectionsResponse {
  const s = p.state;
  const checks = s.checks as Record<string, StoredCheck>;
  const infos = new Map<string, McpServerInfo>();
  for (const f of discoverServers(folderOf(p))) infos.set(f.info.name, f.info);
  for (const [name, check] of Object.entries(checks)) {
    if (!infos.has(name) && check.info?.source === 'claude-ai') infos.set(name, check.info);
  }
  const saved = new Map(s.connections.map((c) => [c.name, c]));

  const rows: ConnectionRow[] = [];
  for (const info of infos.values()) {
    rows.push({ ...info, connection: saved.get(info.name) ?? defaultConnection(p, info), check: stripCheck(checks[info.name]), present: true });
  }
  // Saved but gone from every config: keep them visible so they can be turned off.
  for (const c of s.connections) {
    if (!infos.has(c.name)) {
      rows.push({ name: c.name, source: c.source, transport: 'unknown', target: 'no longer configured', auth: 'none', connection: c, check: stripCheck(checks[c.name]), present: false });
    }
  }
  const order: Record<string, number> = { folder: 0, repo: 1, user: 2, 'claude-ai': 3 };
  rows.sort((a, b) => Number(b.connection.enabled) - Number(a.connection.enabled) || order[a.source] - order[b.source] || a.name.localeCompare(b.name));
  return { rows, lastCheck: s.lastCheck };
}

function stripCheck(check: StoredCheck | undefined): ConnectionCheck | undefined {
  if (!check) return undefined;
  const { info: _info, proxy: _proxy, ...rest } = check;
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

  let conn = s.connections.find((c) => c.name === name);
  if (!conn) {
    conn = { ...row.connection };
    s.connections.push(conn);
  }
  const desks = new Set(s.agents.filter((a) => !a.isHuman).map((a) => a.id));
  if (patch.enabled !== undefined) {
    // First switch-on: every desk may use it; narrow it down from there.
    if (patch.enabled && !conn.enabled && conn.desks.length === 0 && patch.desks === undefined) conn.desks = [...desks];
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

const checking = new Set<string>();

/**
 * Connect to every server this project can see and record status and tools.
 * Sends no prompt and calls no tool, so nothing is read or written through the servers.
 */
export async function checkConnections(p: Project): Promise<ConnectionsResponse> {
  if (checking.has(p.id)) throw new Error('A check is already running for this project');
  checking.add(p.id);
  try {
    const found = discoverServers(folderOf(p));
    const servers = Object.fromEntries(found.map((f) => [f.info.name, f.config]));
    const statuses = await probeServers(path.join(p.workspace, '.probe'), servers, true);
    const at = now();
    const next: Record<string, StoredCheck> = {};
    for (const st of statuses) {
      const fromFile = found.find((f) => f.info.name === st.name);
      const isClaudeAi = st.scope === 'claudeai' || st.source === 'claudeai';
      if (!fromFile && !isClaudeAi) continue;
      const proxy = isClaudeAi ? proxyConfigOf(st) : null;
      next[st.name] = {
        state: toState(st.status),
        checkedAt: at,
        error: st.error?.slice(0, 300),
        tools: toolsOf(st.tools),
        info: isClaudeAi ? claudeAiInfo(st.name) : undefined,
        proxy: proxy ? (proxy as unknown as { url: string; id: string }) : undefined,
      };
    }
    // Servers that never reported back are failures, not silent gaps.
    for (const f of found) next[f.info.name] ??= { state: 'failed', checkedAt: at, error: 'Did not answer the check', tools: [] };
    p.state.checks = next;
    p.state.lastCheck = at;
    const ok = Object.values(next).filter((c) => c.state === 'connected').length;
    p.log('you', `Checked connections: ${ok} of ${Object.keys(next).length} connected`);
    p.commit();
    return listConnections(p);
  } finally {
    checking.delete(p.id);
  }
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

  const found = new Map(discoverServers(folderOf(p)).map((f) => [f.info.name, f.config]));
  const servers: Record<string, McpServerConfig> = {};
  const allowed: AllowedServer[] = [];
  for (const c of mine) {
    let config: McpServerConfig | undefined = found.get(c.name);
    if (!config && c.source === 'claude-ai' && checks[c.name]?.proxy) {
      config = { type: 'claudeai-proxy', ...checks[c.name].proxy } as unknown as McpServerConfig;
    }
    if (!config) continue;
    servers[c.name] = config;
    allowed.push({ name: c.name, key: toolKey(c.name), mode: c.mode, tools: Object.fromEntries((checks[c.name]?.tools ?? []).map((t) => [t.name, t])) });
  }
  return { servers, allowed };
}
