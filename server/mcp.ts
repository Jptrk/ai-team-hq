import { query, type McpServerConfig, type McpServerStatus, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { maskArgs, maskPath, maskUrl, SECRET_NAME, secretForms, toolKey, type Masked } from '../shared/mcpSpec';
import type { McpAuth, McpServerInfo, McpSource, McpToolInfo } from '../shared/types';
import { claudeJsonPath } from './mcpCli';
import { claudeEnv, samePath } from './paths';

export { toolKey };

/**
 * Per-project MCP servers.
 *
 * Discovery reads the same places Claude Code does for a folder, lowest priority first:
 *   user    ~/.claude.json  mcpServers
 *   repo    <folder>/.mcp.json
 *   folder  ~/.claude.json  projects[<folder>].mcpServers   (your private entries for that folder,
 *                                                         or for the git repo it sits in)
 * plus the claude.ai connectors on your account, which only show up by asking a live session.
 *
 * Configs (with their tokens) are read fresh every time and never written into HQ's data.
 * ~/.claude.json moves with CLAUDE_CONFIG_DIR, as it does for Claude Code.
 */

const PROBE_TIMEOUT_MS = 30_000;

export interface FoundServer {
  info: McpServerInfo;
  config: McpServerConfig;
  /** Which server this is, with no secret in it (see fingerprintOf). Saved when you turn it on. */
  fingerprint: string;
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

type Stdio = { command: string; args?: string[]; env?: Record<string, string> };
type Web = { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

/** A server URL as HQ shows and remembers it: origin and path, token-looking parts blanked, no query. */
function shownUrl(url: string): Masked<string> {
  try {
    const u = new URL(url);
    const p = maskPath(u.pathname);
    return { shown: `${u.origin}${p.shown}`, secrets: p.secrets };
  } catch {
    return maskUrl(url);
  }
}

/** Something safe to show on screen: the command or URL with anything secret-looking blanked out. Exported for tests. */
export function describe(config: McpServerConfig): { transport: McpServerInfo['transport']; target: string; auth: McpAuth } {
  if (config.type === 'http' || config.type === 'sse') {
    const url = shownUrl(config.url);
    const inUrl = maskUrl(config.url).secrets.length > 0;
    const hasToken = inUrl || Object.keys(config.headers ?? {}).some((h) => SECRET_NAME.test(h));
    return { transport: config.type, target: url.shown, auth: hasToken ? 'token' : 'oauth' };
  }
  if (config.type === 'stdio' || config.type === undefined) {
    const stdio = config as Stdio;
    const args = maskArgs(stdio.args ?? []);
    const hasEnv = Object.keys(stdio.env ?? {}).length > 0;
    return { transport: 'stdio', target: [stdio.command, ...args.shown].join(' ').trim(), auth: args.secrets.length > 0 || hasEnv ? 'token' : 'none' };
  }
  return { transport: 'unknown', target: '', auth: 'none' };
}

/**
 * Which server a config means, without any secret in it: a hash of its masked shape (command and
 * masked arguments, or URL origin and masked path, plus header and variable names, never values).
 * A new token keeps it; a new URL, command or argument changes it. Exported for tests.
 */
export function fingerprintOf(config: McpServerConfig): string {
  const names = (o: Record<string, string> | undefined) => Object.keys(o ?? {}).map((k) => k.toLowerCase()).sort();
  let shape: unknown;
  if (config.type === 'http' || config.type === 'sse') {
    const web = config as Web;
    shape = { type: web.type, url: shownUrl(web.url).shown, headers: names(web.headers) };
  } else if (config.type === 'stdio' || config.type === undefined) {
    const stdio = config as Stdio;
    shape = { type: 'stdio', command: stdio.command, args: maskArgs(stdio.args ?? []).shown, env: names(stdio.env) };
  } else {
    shape = { type: config.type };
  }
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

/** Every value in a server's config that could be secret: header and variable values, and secrets in its arguments and URL. For scrubbing its errors. */
export function configSecrets(config: McpServerConfig): string[] {
  const c = config as Partial<Stdio & Web>;
  const out: string[] = [];
  for (const v of [...Object.values(c.headers ?? {}), ...Object.values(c.env ?? {})]) out.push(...secretForms(String(v)));
  if (Array.isArray(c.args)) out.push(...maskArgs(c.args).secrets);
  if (typeof c.url === 'string') out.push(...maskUrl(c.url).secrets);
  return [...new Set(out.filter(Boolean))];
}

function collect(into: Map<string, FoundServer>, hidden: FoundServer[], servers: unknown, source: McpSource): void {
  if (!servers || typeof servers !== 'object') return;
  for (const [name, raw] of Object.entries(servers as Raw)) {
    if (!raw || typeof raw !== 'object') continue;
    const config = toConfig(raw as Raw);
    if (!config) continue;
    const shape = describe(config);
    // Later sources win, the same order Claude Code uses: folder beats repo beats user.
    const before = into.get(name);
    if (before && before.info.source !== source) hidden.push(before);
    into.set(name, { info: { name, source, ...shape }, config, fingerprint: fingerprintOf(config) });
  }
}

/**
 * The git repo a folder sits in: Claude Code keys its per-folder settings by the repo's top folder.
 * A .git file (a git worktree) counts as a repo top too; worktrees are untested.
 */
export function gitRoot(folder: string): string | null {
  for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

export interface Discovery {
  /** What Claude Code uses in that folder, one per name. */
  servers: FoundServer[];
  /** Same-named definitions that a higher-priority one hides. */
  hidden: FoundServer[];
}

/** Every file-configured server Claude Code would see when working in `folder`, plus the ones a same name hides. */
export function discoverAll(folder: string | null): Discovery {
  const found = new Map<string, FoundServer>();
  const hidden: FoundServer[] = [];
  const claudeJson = readJson(claudeJsonPath());
  collect(found, hidden, claudeJson?.mcpServers, 'user');
  if (folder) {
    collect(found, hidden, readJson(path.join(folder, '.mcp.json'))?.mcpServers, 'repo');
    const projects = (claudeJson?.projects ?? {}) as Record<string, Raw>;
    const keys = Object.keys(projects);
    const root = gitRoot(folder);
    // The repo's entries first, then the folder's own, so the folder's win.
    const forRoot = root && !samePath(root, folder) ? keys.filter((k) => samePath(k, root)) : [];
    const forFolder = keys.filter((k) => samePath(k, folder));
    for (const key of [...forRoot, ...forFolder]) collect(found, hidden, projects[key]?.mcpServers, 'folder');
  }
  const byName = (a: FoundServer, b: FoundServer) => a.info.name.localeCompare(b.info.name);
  return { servers: [...found.values()].sort(byName), hidden: hidden.sort(byName) };
}

/** Every file-configured server Claude Code would see when working in `folder`. */
export function discoverServers(folder: string | null): FoundServer[] {
  return discoverAll(folder).servers;
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

// Keys whose short value names the action: { method: 'delete_pending' }, { ops: ['remove'] }.
const ACTION_KEYS = new Set(['method', 'action', 'operation', 'op', 'type', 'command', 'verb', 'mode']);
// Keys that hold code, SQL or a shell command. Not body, text or content: on GitHub, Jira and docs those are prose.
const CODE_KEYS = new Set(['code', 'script', 'sql', 'query', 'js', 'javascript', 'source', 'function', 'expression', 'statement', 'command']);
// Tools a server marks destructive because they run a script, where HQ's scan of the script can stand in
// for the mark, and the key (one of CODE_KEYS) that holds it. Figma's use_figma runs a Plugin API script,
// and the Plugin API deletes through remove() and delete*() calls, which CODE_DELETES catches.
const CODE_RUNNERS = new Map([['use_figma', 'code']]);
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
 * What a look through a tool's input found:
 *   deletes  it asks for a delete (see inputSaysDelete)
 *   whole    every value was looked at: nothing was too deep or past the 500-value limit
 */
function scanInput(input: unknown): { deletes: boolean; whole: boolean } {
  let seen = 0;
  let whole = true;
  const walk = (value: unknown, key: string, depth: number): boolean => {
    if (++seen > MAX_VALUES) {
      whole = false;
      return false;
    }
    if (typeof value === 'string') {
      if (value.length <= 40 && keyIn(ACTION_KEYS, key) && nameSaysDelete(value)) return true;
      return keyIn(CODE_KEYS, key) && CODE_DELETES.test(value);
    }
    if (!value || typeof value !== 'object') return false;
    if (depth >= MAX_DEPTH) {
      whole = false;
      return false;
    }
    // Items of a list are read under the list's key, so { ops: ['delete'] } counts.
    if (Array.isArray(value)) return value.some((v) => walk(v, key, depth + 1));
    for (const [k, v] of Object.entries(value)) {
      if ((isSet(v) && nameSaysDelete(k)) || (v === true && DELETE_FLAGS.test(snakeOf(k)))) return true;
      if (walk(v, k, depth + 1)) return true;
    }
    return false;
  };
  const deletes = walk(input, '', 0);
  return { deletes, whole };
}

/**
 * True when a tool's input asks for a delete its name does not show: GitHub's *_write tools with
 * method "remove", a batch with a delete operation, a key like deleteContentRange or force: true,
 * or code and SQL that deletes. Best effort: it looks 4 levels deep and at 500 values at most,
 * and code can always hide a delete.
 */
export function inputSaysDelete(input: unknown): boolean {
  return scanInput(input).deletes;
}

/** True when a CODE_RUNNERS tool's input is its script and plain labels (a file key, a description), nothing else. */
function onlyRunsScript(tool: string, input: unknown): boolean {
  const key = CODE_RUNNERS.get(tool);
  if (!key || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  const script = (input as Record<string, unknown>)[key];
  if (typeof script !== 'string' || !script.trim()) return false;
  return Object.values(input).every((v) => ['string', 'number', 'boolean'].includes(typeof v));
}

/**
 * Why a change on an Auto connection waits for approval as a delete, or null when it may run:
 *   name   the tool's name says it deletes or removes
 *   input  this call's input asks for a delete (see inputSaysDelete)
 *   hint   the server marks the tool destructive, and HQ can't see what this call will do
 * A server marks a tool destructive when it *may* overwrite or delete. Figma marks use_figma that
 * way because it runs any plugin script. For a tool in CODE_RUNNERS, when the input is just the
 * script and the whole input was scanned, the scan decides instead: a script that only creates or
 * reads runs, and one that calls .remove() waits. Every other marked tool waits.
 */
export function autoDelete(tool: string, hint: Pick<McpToolInfo, 'destructive'> | undefined, input: unknown): 'name' | 'input' | 'hint' | null {
  if (nameSaysDelete(tool)) return 'name';
  const scan = scanInput(input);
  if (scan.deletes) return 'input';
  if (hint?.destructive === true && !(scan.whole && onlyRunsScript(tool, input))) return 'hint';
  return null;
}

export interface McpSession {
  q: Query;
  close(): Promise<void>;
}

/**
 * A Claude Code session that only connects to these servers: it sends no prompt, has no tools of
 * its own, and refuses every tool request. Checks and sign-ins run in one.
 */
export function openSession(cwd: string, servers: Record<string, McpServerConfig>, includeClaudeAi: boolean): McpSession {
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
      env: claudeEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: 'ai-team-hq/0.3.0' }),
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
  let closed = false;
  return {
    q,
    async close() {
      if (closed) return;
      closed = true;
      release();
      abort.abort();
      try {
        q.close();
      } catch {
        /* already closed */
      }
      await drain;
    },
  };
}

/**
 * Connect to servers and report their status and tools, without sending any prompt.
 * No model call is made and no tool is called: every tool request is refused.
 */
export async function probeServers(
  cwd: string,
  servers: Record<string, McpServerConfig>,
  includeClaudeAi: boolean,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<McpServerStatus[]> {
  const { q, close } = openSession(cwd, servers, includeClaudeAi);
  try {
    // claude.ai connectors register a few seconds after start, so wait until the list stops
    // growing and nothing is pending, with a floor when connectors are expected.
    const start = Date.now();
    const deadline = start + timeoutMs;
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
    await close();
  }
}

/** The claude.ai connector config a live session reports, so a run can load just that connector. */
export function proxyConfigOf(status: McpServerStatus): McpServerConfig | null {
  const c = status.config as { type?: string; url?: string; id?: string } | undefined;
  if (c?.type === 'claudeai-proxy' && c.url && c.id) return { type: 'claudeai-proxy', url: c.url, id: c.id } as unknown as McpServerConfig;
  return null;
}
