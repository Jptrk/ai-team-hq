import { query, type McpServerConfig, type McpServerStatus, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpAuth, McpServerInfo, McpSource, McpToolInfo } from '../shared/types';
import { samePath } from './paths';

/**
 * Per-project MCP servers.
 *
 * Discovery reads the same places Claude Code does for a folder, lowest priority first:
 *   user    ~/.claude.json  mcpServers
 *   repo    <folder>/.mcp.json
 *   folder  ~/.claude.json  projects[<folder>].mcpServers   (your private entries for that folder)
 * plus the claude.ai connectors on your account, which only show up by asking a live session.
 *
 * Configs (with their tokens) are read fresh every time and never written into HQ's data.
 */

const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const PROBE_TIMEOUT_MS = 30_000;

export interface FoundServer {
  info: McpServerInfo;
  config: McpServerConfig;
}

type Raw = Record<string, unknown>;

function readJson(file: string): Raw | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Raw;
  } catch {
    return null;
  }
}

/** ${VAR} and ${VAR:-default}, as Claude Code expands them in .mcp.json. */
function expand(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => process.env[name] ?? fallback ?? '');
  }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  return value;
}

const strings = (v: unknown): Record<string, string> | undefined =>
  v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Raw).map(([k, x]) => [k, String(x)])) : undefined;

function toConfig(raw: Raw): McpServerConfig | null {
  const r = expand(raw) as Raw;
  const type = typeof r.type === 'string' ? r.type : r.command ? 'stdio' : r.url ? 'http' : '';
  if (type === 'stdio' && typeof r.command === 'string') {
    return { type: 'stdio', command: r.command, args: Array.isArray(r.args) ? r.args.map(String) : [], env: strings(r.env) };
  }
  if ((type === 'http' || type === 'sse') && typeof r.url === 'string') {
    return { type, url: r.url, headers: strings(r.headers) };
  }
  return null;
}

const SECRET_FLAG = /key|token|secret|auth|header|password|bearer/i;
const SECRET_VALUE = /^(sk|ctx7sk|ghp|gho|ghs|github_pat|xox[abp]|AIza)[-_]|^[A-Za-z0-9_\-]{32,}$/;

/** Something safe to show on screen: the command or URL with anything secret-looking blanked out. */
function describe(config: McpServerConfig): { transport: McpServerInfo['transport']; target: string; auth: McpAuth } {
  if (config.type === 'http' || config.type === 'sse') {
    let target = config.url;
    try {
      const u = new URL(config.url);
      target = `${u.origin}${u.pathname}`;
    } catch {
      /* keep as written */
    }
    const hasToken = Object.keys(config.headers ?? {}).some((h) => /authorization|token|key/i.test(h));
    return { transport: config.type, target, auth: hasToken ? 'token' : 'oauth' };
  }
  if (config.type === 'stdio' || config.type === undefined) {
    const stdio = config as { command: string; args?: string[]; env?: Record<string, string> };
    const args = stdio.args ?? [];
    const shown = args.map((a, i) => (SECRET_VALUE.test(a) || (i > 0 && SECRET_FLAG.test(args[i - 1]) && !a.startsWith('-')) ? '•••' : a));
    const secretArg = shown.includes('•••');
    const hasEnv = Object.keys(stdio.env ?? {}).length > 0;
    return { transport: 'stdio', target: [stdio.command, ...shown].join(' ').trim(), auth: secretArg || hasEnv ? 'token' : 'none' };
  }
  return { transport: 'unknown', target: '', auth: 'none' };
}

function collect(into: Map<string, FoundServer>, servers: unknown, source: McpSource): void {
  if (!servers || typeof servers !== 'object') return;
  for (const [name, raw] of Object.entries(servers as Raw)) {
    if (!raw || typeof raw !== 'object') continue;
    const config = toConfig(raw as Raw);
    if (!config) continue;
    const shape = describe(config);
    // Later sources win, the same order Claude Code uses: folder beats repo beats user.
    into.set(name, { info: { name, source, ...shape }, config });
  }
}

/** Every file-configured server Claude Code would see when working in `folder`. */
export function discoverServers(folder: string | null): FoundServer[] {
  const found = new Map<string, FoundServer>();
  const claudeJson = readJson(CLAUDE_JSON);
  collect(found, claudeJson?.mcpServers, 'user');
  if (folder) {
    collect(found, readJson(path.join(folder, '.mcp.json'))?.mcpServers, 'repo');
    const projects = (claudeJson?.projects ?? {}) as Record<string, Raw>;
    for (const [key, entry] of Object.entries(projects)) {
      if (samePath(key, folder)) collect(found, entry?.mcpServers, 'folder');
    }
  }
  return [...found.values()].sort((a, b) => a.info.name.localeCompare(b.info.name));
}

/** How a server name appears inside tool names: mcp__<key>__<tool>. */
export function toolKey(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_-]/g, '_');
}

const WRITE_WORDS = /^(create|update|delete|remove|add|merge|push|post|send|edit|transition|set|write|close|approve|request|assign|upload|move|rename|submit|publish|comment|reply|react|star|fork|dismiss|rerun|cancel|trigger|run|execute|click|fill|type|press|drag|navigate|new|use|generate|export|import|sync|link|unlink|lock|unlock|archive|restore|invite|share)/i;
const READ_WORDS = /^(get|list|search|read|fetch|find|query|lookup|view|describe|show|download|resolve|whoami|check|count|preview|inspect|take_screenshot|take_snapshot|list_)/i;

/** getJiraIssue -> get_jira_issue, resolve-library-id -> resolve_library_id, files.delete -> files_delete */
function snakeOf(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

// A word that deletes or removes, with an optional plural: delete_node, remove-labels, force_push.
// Close, cancel, dismiss, revert, unassign and disable are not here: they can be undone.
const DELETE_WORDS = /(^|_)(delete|remove|destroy|drop|purge|erase|wipe|trash|revoke|unpublish|uninstall|truncate|clear|rm|del|unlink|detach|disconnect|archive|discard|prune|flush|kill|terminate|reset|overwrite|force)(e?s)?(_|$)/;
// Run together inside one word: deleteall, batchdelete, HTTPDelete. Never undelete, and not removed or deleted (those name what is gone).
const DELETE_INSIDE = /(?<!un)(delete|remove|destroy|purge)(?!d)/;

/** True when a tool name, or an action word like "delete_pending", says it deletes or removes something. */
function nameSaysDelete(name: string): boolean {
  const snake = snakeOf(name);
  return DELETE_WORDS.test(snake) || snake.split('_').some((word) => DELETE_INSIDE.test(word));
}

/**
 * True only for tools that cannot change anything. A server's readOnly hint counts,
 * but a name that sounds like a write or a delete overrides it. Unknown means not read-only.
 */
export function isReadOnlyTool(tool: string, hint?: Pick<McpToolInfo, 'readOnly' | 'destructive'>): boolean {
  const snake = snakeOf(tool);
  // A name that says delete never reads, whatever the hint or the prefix: purge_cache, get_and_purge.
  if (nameSaysDelete(tool)) return false;
  const soundsLikeWrite = WRITE_WORDS.test(snake) || /(^|_)(write|create|update|delete|remove|merge|comment|post|send|edit|approve|close)(_|$)/.test(snake);
  if (soundsLikeWrite) return false;
  if (hint?.readOnly === true) return true;
  if (hint?.readOnly === false || hint?.destructive === true) return false;
  return READ_WORDS.test(snake) || /_read$/.test(snake) || /user_?info$/.test(snake);
}

/**
 * Tools that delete or remove something. On an auto connection these still wait for your approval.
 * The server's own destructive hint counts, and so does the name, because hints are often missing.
 */
export function isDestructiveTool(tool: string, hint?: Pick<McpToolInfo, 'destructive'>): boolean {
  return hint?.destructive === true || nameSaysDelete(tool);
}

// Keys whose short value names the action: { method: 'delete_pending' }, { ops: ['remove'] }.
const ACTION_KEYS = new Set(['method', 'action', 'operation', 'op', 'type', 'command', 'verb', 'mode']);
// Keys that hold code, SQL or a shell command. Not body, text or content: on GitHub, Jira and docs those are prose.
const CODE_KEYS = new Set(['code', 'script', 'sql', 'query', 'js', 'javascript', 'source', 'function', 'expression', 'statement', 'command']);
// Common ways code deletes. Best effort: code can always hide one.
const CODE_DELETES =
  /\bdelete\s+from\b|\bdrop\s+(table|schema|database|index|view|column)\b|\btruncate\s+(table\s+)?[\w"`[]|\b(delete|remove|destroy|purge|unlink)\w*\s*\(|\brm\s+-?\w/i;
// Flags that put something in the bin: { archived: true }, { isDeleted: true }.
const DELETE_FLAGS = /(^|_)(archived|deleted|trashed|removed)$/;
const MAX_DEPTH = 4;
const MAX_VALUES = 500;

/** A value that asks for something: not false, empty or missing. */
const isSet = (v: unknown): boolean => Boolean(v) && (typeof v !== 'object' || Object.keys(v as object).length > 0);

/** The last word of a key, also without a plural s: http_method -> method, ops -> op. */
function keyIn(set: Set<string>, key: string): boolean {
  const snake = snakeOf(key);
  const last = snake.slice(snake.lastIndexOf('_') + 1);
  return set.has(last) || set.has(last.replace(/s$/, ''));
}

/**
 * True when a tool's input asks for a delete its name does not show: GitHub's *_write tools with
 * method "remove", a batch with a delete operation, a key like deleteContentRange or force: true,
 * or code and SQL that deletes. Best effort: it looks 4 levels deep and at 500 values at most,
 * and code can always hide a delete.
 */
export function inputSaysDelete(input: unknown): boolean {
  let seen = 0;
  const walk = (value: unknown, key: string, depth: number): boolean => {
    if (++seen > MAX_VALUES) return false;
    if (typeof value === 'string') {
      if (value.length <= 40 && keyIn(ACTION_KEYS, key) && nameSaysDelete(value)) return true;
      return keyIn(CODE_KEYS, key) && CODE_DELETES.test(value);
    }
    if (!value || typeof value !== 'object' || depth >= MAX_DEPTH) return false;
    // Items of a list are read under the list's key, so { ops: ['delete'] } counts.
    if (Array.isArray(value)) return value.some((v) => walk(v, key, depth + 1));
    for (const [k, v] of Object.entries(value)) {
      if ((isSet(v) && nameSaysDelete(k)) || (v === true && DELETE_FLAGS.test(snakeOf(k)))) return true;
      if (walk(v, k, depth + 1)) return true;
    }
    return false;
  };
  return walk(input, '', 0);
}

/**
 * Connect to servers and report their status and tools, without sending any prompt.
 * No model call is made and no tool is called: every tool request is refused.
 */
export async function probeServers(cwd: string, servers: Record<string, McpServerConfig>, includeClaudeAi: boolean): Promise<McpServerStatus[]> {
  fs.mkdirSync(cwd, { recursive: true });
  const abort = new AbortController();
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => (release = resolve));
  async function* nothing(): AsyncGenerator<SDKUserMessage> {
    await hold;
  }

  const q = query({
    prompt: nothing(),
    options: {
      cwd,
      settingSources: [],
      strictMcpConfig: !includeClaudeAi,
      mcpServers: servers,
      tools: [],
      permissionMode: 'default',
      canUseTool: async () => ({ behavior: 'deny', message: 'Connection check only.' }),
      abortController: abort,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'ai-team-hq/0.3.0' },
    },
  });
  const drain = (async () => {
    try {
      for await (const _msg of q) {
        /* no messages expected; nothing is sent */
      }
    } catch {
      /* aborted */
    }
  })();

  try {
    // claude.ai connectors register a few seconds after start, so wait until the list stops
    // growing and nothing is pending, with a floor when connectors are expected.
    const start = Date.now();
    const deadline = start + PROBE_TIMEOUT_MS;
    const floor = includeClaudeAi ? 6_000 : 0;
    let statuses = await q.mcpServerStatus();
    let stableFor = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 750));
      const next = await q.mcpServerStatus();
      stableFor = next.length === statuses.length ? stableFor + 1 : 0;
      statuses = next;
      const settled = !statuses.some((s) => s.status === 'pending') && stableFor >= 2;
      if (settled && Date.now() - start >= floor) break;
    }
    return statuses;
  } finally {
    release();
    abort.abort();
    try {
      q.close();
    } catch {
      /* already closed */
    }
    await drain;
  }
}

/** The claude.ai connector config a live session reports, so a run can load just that connector. */
export function proxyConfigOf(status: McpServerStatus): McpServerConfig | null {
  const c = status.config as { type?: string; url?: string; id?: string } | undefined;
  if (c?.type === 'claudeai-proxy' && c.url && c.id) return { type: 'claudeai-proxy', url: c.url, id: c.id } as unknown as McpServerConfig;
  return null;
}
