import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { claudeEnv, HQ_ROOT } from './paths';
import { findProgram, killTree, runProgram, type ProgramResult } from './proc';

/**
 * HQ's own Codex, for GPT desks on your ChatGPT login.
 *
 * `codex app-server` speaks JSON-RPC over stdio, one JSON object per line. HQ starts one for each GPT desk run and
 * for each account check or sign-in, always in a Codex home of its own (data/.codex): your ~/.codex, its settings,
 * MCP servers, AGENTS.md and skills never reach a desk, and HQ's ChatGPT sign-in is its own. The program is the one
 * in the pinned @openai/codex package, never whatever codex is first on PATH. HQ never reads or writes a token:
 * Codex keeps the login in data/.codex/auth.json and refreshes it itself.
 *
 * OpenAI marks app-server as experimental, so the version is pinned in package.json. A new version may change
 * the protocol: check the generated types (`codex app-server generate-ts --experimental`) before moving the pin.
 */

const TARGETS: Partial<Record<string, { triple: string; pkg: string }>> = {
  'linux-x64': { triple: 'x86_64-unknown-linux-musl', pkg: '@openai/codex-linux-x64' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-musl', pkg: '@openai/codex-linux-arm64' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', pkg: '@openai/codex-darwin-x64' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin', pkg: '@openai/codex-darwin-arm64' },
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', pkg: '@openai/codex-win32-x64' },
  'win32-arm64': { triple: 'aarch64-pc-windows-msvc', pkg: '@openai/codex-win32-arm64' },
};

/** The codex program, as a full path. HQ_CODEX_BIN may be a full path or a name looked up in PATH. */
export function codexBin(): string {
  const own = process.env.HQ_CODEX_BIN?.trim();
  if (own) {
    const found = findProgram(own);
    if (!found) throw new Error('HQ_CODEX_BIN must be a full path, or a program on PATH.');
    return found;
  }
  const target = TARGETS[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`Codex has no build for ${process.platform} ${process.arch}.`);
  const require = createRequire(import.meta.url);
  let dir: string;
  try {
    dir = path.dirname(require.resolve(`${target.pkg}/package.json`));
  } catch {
    throw new Error(`Codex is not installed (${target.pkg} is missing). Run npm install in HQ's folder.`);
  }
  return path.join(dir, 'vendor', target.triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
}

/** Where HQ's own Codex home is, without making it. */
export function codexHomePath(): string {
  return path.join(HQ_ROOT, 'data', '.codex');
}

/** HQ's own Codex home: the ChatGPT login, desk threads, Codex's logs. Never your ~/.codex. Made on first use. */
export function codexHome(): string {
  const dir = codexHomePath();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Settings for every app-server HQ starts: the login lives in a file in HQ's Codex home, and nothing phones home or updates itself. */
export const BASE_CONFIG = [
  'cli_auth_credentials_store="file"',
  // Sign-ins to connections for GPT desks live in HQ's Codex home too, never in your keychain.
  'mcp_oauth_credentials_store="file"',
  'check_for_update_on_startup=false',
  'analytics.enabled=false',
  'feedback.enabled=false',
  'features.remote_control=false',
  'features.daemon_auto_start=false',
];

/**
 * What a desk run switches off, so the model sees only apply_patch (every patch asks HQ first), the clock and HQ's
 * own tools. Current GPT models call tools from a JavaScript host with no file, network or process access
 * (code mode), so that host stays on. Off: the shell, sub-agents, ChatGPT apps and plugins, image tools, goals,
 * hooks, memories, Codex's own skills, computer and browser use, the in-app browser and automation, worktrees,
 * workspace dependencies, voice (realtime), web search, and the project's AGENTS.md (HQ puts the project's
 * instructions in the prompt itself). Every features.* key here is one Codex 0.161.0 lists (`codex features list`);
 * Codex ignores an unknown one without a word, so test:codex runs the real program to check they all read false.
 * shell_tool=false is what removes the shell: 0.161.0 keeps unified_exec on whatever it is told, and without the
 * shell tool it has nothing to run. unified_exec=false stays, for a version that does honour it. Exported for tests.
 */
export const DESK_CONFIG = [
  ...BASE_CONFIG,
  'features.shell_tool=false',
  'features.unified_exec=false',
  'features.shell_snapshot=false',
  'features.view_image=false',
  'features.sleep_tool=false',
  'features.multi_agent=false',
  'features.multi_agent_v2=false',
  'features.apps=false',
  'features.plugins=false',
  'features.remote_plugin=false',
  'features.tool_suggest=false',
  'features.image_generation=false',
  'features.goals=false',
  'features.hooks=false',
  'features.skill_search=false',
  'features.skill_mcp_dependency_install=false',
  'features.guardian_approval=false',
  'features.memories=false',
  'features.computer_use=false',
  'features.browser_use=false',
  'features.browser_use_external=false',
  'features.browser_use_full_cdp_access=false',
  'features.in_app_browser=false',
  'features.in_app_local_automation=false',
  'features.worktrees=false',
  'features.workspace_dependencies=false',
  'features.realtime_conversation=false',
  'web_search="disabled"',
  'project_doc_max_bytes=0',
  'skills.include_instructions=false',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
  'include_permissions_instructions=false',
  'tools.experimental_request_user_input.enabled=false',
  'tools.update_plan.enabled=false',
  'history.persistence="save-all"',
];

/**
 * Codex's environment: no OpenAI key (GPT desks run on the ChatGPT login, never an API key), HQ's own Codex home,
 * and git kept out of HQ's repo as for Claude Code (see claudeEnv). Exported for tests.
 */
export function codexEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = claudeEnv({ CODEX_HOME: codexHome() }, base);
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_|CODEX_API_KEY$|CODEX_ACCESS_TOKEN$)/i.test(key)) delete env[key];
  }
  return env;
}

/**
 * Codex's environment plus a run's own variables (a desk's connections, codexMcp.ts). They only add: a name the
 * environment already has, in any case on Windows, keeps its value, so a connection never changes Codex itself.
 * Exported for tests.
 */
export function appServerEnv(vars: Record<string, string> = {}, base: NodeJS.ProcessEnv = codexEnv(), platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const norm = (k: string) => (platform === 'win32' ? k.toUpperCase() : k);
  const had = new Set(Object.keys(base).map(norm));
  const env = { ...base };
  for (const [k, v] of Object.entries(vars)) if (!had.has(norm(k))) env[k] = v;
  return env;
}

export type CodexRun = (args: string[], env: NodeJS.ProcessEnv) => Promise<ProgramResult>;

/** Tests only: run this instead of the codex program. Call with null to undo. */
let codexRun: CodexRun | null = null;
export function setCodexRunForTests(f: CodexRun | null): void {
  codexRun = f;
}

/** Run the codex program once for a command that is not the app-server (`codex mcp logout`): in HQ's Codex home, no shell. */
export function runCodex(args: string[], env: NodeJS.ProcessEnv): Promise<ProgramResult> {
  if (codexRun) return codexRun(args, env);
  let bin: string;
  try {
    bin = codexBin();
  } catch (e) {
    return Promise.resolve({ code: null, out: '', err: '', timedOut: false, truncated: false, startError: e instanceof Error ? e.message : 'Codex is missing.' });
  }
  return runProgram(bin, args, { cwd: codexHome(), env, timeoutMs: 30_000, cap: 64 * 1024 });
}

/** A JSON-RPC error Codex answered with. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Codex exited (or HQ closed it) while a request waited. */
export class ServerGone extends Error {}

export type RequestHandler = (method: string, params: any) => unknown | Promise<unknown>;
export type NotificationHandler = (method: string, params: any) => void;

/** One running `codex app-server`, initialized and ready. */
export interface AppServer {
  /** Ask Codex something. Rejects with RpcError on an error answer, ServerGone if it exits, or after timeoutMs. */
  request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** Codex asks HQ something (an approval, a tool call): the handler's answer goes back. Undefined answers with an error. */
  onRequest(handler: RequestHandler): void;
  onNotification(handler: NotificationHandler): void;
  /** Settles when the program ends, whichever way. */
  readonly exited: Promise<void>;
  /** Stop the program and everything it started. Safe to call twice. */
  close(): Promise<void>;
}

export interface OpenOptions {
  /** Where the program starts. A desk run starts in its workspace. */
  cwd: string;
  /** `-c key=value` settings for this program. BASE_CONFIG when left out. */
  config?: string[];
  /** More variables for this program: a desk's connections read their secrets from them (codexMcp.ts). They only add (appServerEnv). */
  env?: Record<string, string>;
}

export type AppServerFactory = (opts: OpenOptions) => Promise<AppServer>;

/** Tests only: start this instead of Codex. Call with null to undo. */
let factory: AppServerFactory | null = null;
export function setAppServerForTests(f: AppServerFactory | null): void {
  factory = f;
}

const REQUEST_MS = 60_000;
const INIT_MS = 30_000;
const LINE_CAP = 32 * 1024 * 1024;

/** Start `codex app-server` and initialize it. */
export function openAppServer(opts: OpenOptions): Promise<AppServer> {
  return (factory ?? spawnAppServer)(opts);
}

async function spawnAppServer(opts: OpenOptions): Promise<AppServer> {
  const args = ['app-server', ...(opts.config ?? BASE_CONFIG).flatMap((c) => ['-c', c])];
  const child = spawn(codexBin(), args, {
    cwd: opts.cwd,
    env: appServerEnv(opts.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    // Its own process group elsewhere, so closing it ends what it started too.
    detached: process.platform !== 'win32',
  });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let next = 1;
  let gone = false;
  let onReq: RequestHandler = () => undefined;
  let onNote: NotificationHandler = () => undefined;
  let stderrTail = '';
  const exited = new Promise<void>((resolve) => {
    const end = () => {
      if (gone) return;
      gone = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new ServerGone(`Codex stopped.${stderrTail ? ` ${lastLine(stderrTail)}` : ''}`));
      }
      pending.clear();
      resolve();
    };
    child.on('exit', end);
    child.on('error', end);
  });
  const write = (msg: unknown) => {
    if (gone || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  // Codex logs to stderr. Only the tail is kept, for an error that explains an exit.
  child.stderr.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-4000);
  });
  child.stdin.on('error', () => undefined);
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim() || line.length > LINE_CAP) return;
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string; code?: number } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) {
      const id = msg.id;
      Promise.resolve()
        .then(() => onReq(msg.method!, msg.params))
        .then(
          (result) =>
            result === undefined
              ? write({ id, error: { code: -32601, message: `HQ does not handle ${msg.method}` } })
              : write({ id, result }),
          (e: unknown) => write({ id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }),
        );
    } else if (msg.method) {
      try {
        onNote(msg.method, msg.params);
      } catch (e) {
        console.error('[hq] codex notification:', e instanceof Error ? e.message : e);
      }
    } else if (typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.message ?? 'Codex refused the request.', msg.error.code));
      else p.resolve(msg.result);
    }
  });

  const server: AppServer = {
    request<T>(method: string, params?: unknown, timeoutMs = REQUEST_MS) {
      if (gone) return Promise.reject(new ServerGone('Codex stopped.'));
      return new Promise<T>((resolve, reject) => {
        const id = next++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex did not answer ${method} in time.`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        write(params === undefined ? { id, method } : { id, method, params });
      });
    },
    onRequest(handler) {
      onReq = handler;
    },
    onNotification(handler) {
      onNote = handler;
    },
    exited,
    async close() {
      if (gone) return;
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      // A moment to exit on its own, then the whole tree goes.
      const quit = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);
      if (!quit) killTree(child);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    },
  };
  try {
    await server.request('initialize', { clientInfo: { name: 'ai_team_hq', title: 'AI Team HQ', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } }, INIT_MS);
    write({ method: 'initialized' });
  } catch (e) {
    await server.close();
    throw e instanceof ServerGone ? new Error(`Codex did not start.${stderrTail ? ` ${lastLine(stderrTail)}` : ''}`) : e;
  }
  return server;
}

/** The last line Codex logged, without colour codes or anything that looks like a token. */
function lastLine(text: string): string {
  const lines = text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/PATH aliases/.test(l));
  const last = lines.at(-1) ?? '';
  return last.replace(/\b[A-Za-z0-9_\-.]{32,}\b/g, '…').slice(0, 300);
}
