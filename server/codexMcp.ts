import { createHash } from 'node:crypto';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AllowedServer } from './connections';

/**
 * A GPT desk's connections. They are the same servers a Claude desk gets, from the same list (connections.ts reads
 * them from Claude Code's settings), turned into Codex's settings for one app-server:
 *   - a program on this PC: its command and arguments, and its variables passed by name through the environment;
 *   - an online server: its URL, and each header read from a variable.
 *   Secrets in variables and headers never go on a command line. A token inside a server's URL or a program's
 *   arguments does, as it does for Claude.
 *   - every tool call asks HQ first (default_tools_approval_mode = prompt), and HQ answers with the same rules as
 *     for Claude (mcpDecision in claude.ts): Ask, Read only and Auto mean the same on both models.
 * The server's id in Codex is its tool key (mcp__<key>__), the same one Claude uses, so tool names match too.
 * Left out: claude.ai connectors (they only exist inside your Claude account), SSE servers (Codex speaks
 * streamable HTTP), a server named hq (HQ's own tools), and a program whose variables would change Codex itself or
 * another connection. A server you sign in to in a browser needs its own sign-in for GPT (codexMcpAuth.ts).
 */

export interface CodexMcp {
  /** `-c` settings for the app-server. Never a secret: those go in env. */
  config: string[];
  /** Variables the app-server starts with: the servers' own variables and header values. */
  env: Record<string, string>;
  /** The connections GPT desks get this run, for the prompt and the guard. */
  allowed: AllowedServer[];
  /** Connections left out, and why, in a few words. */
  skipped: { name: string; why: string }[];
}

export interface CodexMcpOptions {
  /** How long one tool call may take, 0 for Codex's default. */
  toolTimeoutMs?: number;
  /** The environment Codex starts with (codexEnv()): a connection may add to it, never change it. */
  base?: NodeJS.ProcessEnv;
  /** Windows reads a variable's name in any case. A parameter for tests. */
  platform?: NodeJS.Platform;
}

/** A JSON string is a TOML basic string, escapes included. */
const toml = (v: string): string => JSON.stringify(v);
const tomlList = (list: string[]): string => `[${list.map(toml).join(',')}]`;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names Codex itself reads: a connection setting one would change how Codex signs in or where it keeps things. */
const CODEX_OWN = /^(OPENAI_|CODEX_)/i;
/**
 * Variables Codex hands every program connection, or reads itself: the list in codex.exe 0.161.0 for Windows,
 * and the one Codex has for macOS and Linux. A connection setting one changes Codex and every other connection.
 */
const CODEX_SHARED = new Set([
  'PATH',
  'PATHEXT',
  'SHELL',
  'COMSPEC',
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'USERNAME',
  'USERDOMAIN',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROGRAMFILES',
  'PROGRAMW6432',
  'PROGRAMDATA',
  'LOCALAPPDATA',
  'APPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'POWERSHELL',
  'PWSH',
  'HOME',
  'LOGNAME',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  '__CF_USER_TEXT_ENCODING',
]);
/** How Codex and every online connection reach the network and trust its certificates. Proxies count in any case. */
const NETWORK = /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;
const TLS = new Set(['SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_OPTIONS']);

/** Why GPT desks can't use this server at all, or null. Exported for the Connections page. */
export function gptUnsupported(config: Pick<McpServerConfig, 'type'> | { type?: string }): string | null {
  const type = (config as { type?: string }).type ?? 'stdio';
  if (type === 'claudeai-proxy') return 'a claude.ai connector, which only works on Claude';
  if (type === 'sse') return 'an SSE server, which GPT desks cannot use';
  if (type !== 'stdio' && type !== 'http') return 'not a kind of server GPT desks can use';
  return null;
}

/**
 * The variable a header's value travels in: HQ_MCP_<KEY>_<HEADER>_<hash>, letters, digits and underscores only.
 * The hash of the key and header as written keeps my-api and my_api (one name once cleaned up) apart.
 */
function headerVar(key: string, header: string): string {
  const hash = createHash('sha256').update(`${key}\u0000${header}`).digest('hex').slice(0, 8);
  return `HQ_MCP_${key}_${header}`.slice(0, 110).concat(`_${hash}`).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

/**
 * This desk's connections as Codex settings. servers: their configs by connection name (runtimeServers). A
 * connection's variables only add to Codex's environment (base): one that would change Codex itself, or a variable
 * another connection sets differently, leaves that connection out. Pure: exported for tests.
 */
export function codexMcp(servers: Record<string, McpServerConfig>, allowed: AllowedServer[], opts: CodexMcpOptions = {}): CodexMcp {
  const out: CodexMcp = { config: [], env: {}, allowed: [], skipped: [] };
  const win = (opts.platform ?? process.platform) === 'win32';
  const same = (a: string, b: string) => (win ? a.toUpperCase() === b.toUpperCase() : a === b);
  const lookup = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
    const k = Object.keys(env).find((x) => same(x, name));
    return k === undefined ? undefined : env[k];
  };
  const base = opts.base ?? {};
  /** Why this variable can't go to Codex, or null. 'base' when Codex already has it with this very value. */
  const clash = (k: string, v: string): string | 'base' | null => {
    if (!VAR_NAME.test(k)) return `${k} is not a usable variable name`;
    if (CODEX_OWN.test(k)) return `it sets ${k}, which Codex reads itself`;
    const had = lookup(base, k);
    if (had === v) return 'base';
    const name = win ? k.toUpperCase() : k;
    if (CODEX_SHARED.has(name) || NETWORK.test(k) || TLS.has(name)) return `it sets ${k}, which would change Codex itself and every other connection`;
    if (had !== undefined) return `it sets ${k}, which HQ's own environment has with another value`;
    const other = lookup(out.env, k);
    if (other !== undefined && other !== v) return `another connection sets ${k} differently`;
    return null;
  };
  for (const a of allowed) {
    const config = servers[a.name];
    if (!config) continue;
    // HQ's own tools are mcp__hq__*, and the guard lets all of them through: a connection can't take that name.
    if (a.key === 'hq') {
      out.skipped.push({ name: a.name, why: "hq is HQ's own name" });
      continue;
    }
    const unsupported = gptUnsupported(config);
    if (unsupported) {
      out.skipped.push({ name: a.name, why: unsupported });
      continue;
    }
    const lines: string[] = [];
    const env: Record<string, string> = {};
    const at = `mcp_servers.${a.key}`;
    let why: string | null = null;
    if (config.type === 'http') {
      lines.push(`${at}.url=${toml(config.url)}`);
      const headers = Object.entries(config.headers ?? {});
      if (headers.length) {
        const pairs = headers.map(([h, v]) => {
          const name = headerVar(a.key, h);
          const c = clash(name, v);
          if (c !== 'base') {
            if (c) why ??= c;
            env[name] = v;
          }
          return `${toml(h)}=${toml(name)}`;
        });
        lines.push(`${at}.env_http_headers={${pairs.join(',')}}`);
      }
    } else {
      const stdio = config as { command: string; args?: string[]; env?: Record<string, string> };
      lines.push(`${at}.command=${toml(stdio.command)}`);
      if (stdio.args?.length) lines.push(`${at}.args=${tomlList(stdio.args)}`);
      // Variables go to the server by name, through Codex's own environment: they may only add to it.
      const vars = Object.entries(stdio.env ?? {});
      for (const [k, v] of vars) {
        const c = clash(k, v) ?? (Object.keys(env).some((x) => same(x, k) && env[x] !== v) ? `it sets ${k} twice` : null);
        if (c === 'base') continue;
        if (c) {
          why = c;
          break;
        }
        env[k] = v;
      }
      if (vars.length) lines.push(`${at}.env_vars=${tomlList(vars.map(([k]) => k))}`);
    }
    if (why) {
      out.skipped.push({ name: a.name, why });
      continue;
    }
    // Every call asks HQ first, and a server that never starts doesn't hold the run up for long.
    lines.push(`${at}.default_tools_approval_mode="prompt"`, `${at}.startup_timeout_sec=30`);
    if (opts.toolTimeoutMs && opts.toolTimeoutMs > 0) lines.push(`${at}.tool_timeout_sec=${Math.max(1, Math.round(opts.toolTimeoutMs / 1000))}`);
    out.config.push(...lines);
    Object.assign(out.env, env);
    out.allowed.push(a);
  }
  return out;
}
