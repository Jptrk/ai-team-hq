import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { safeAuthUrl, toolKey } from '../shared/mcpSpec';
import type { ConnectionLogin, GptConnection, McpServerInfo, McpToolInfo } from '../shared/types';
import { codexMcp } from './codexMcp';
import { appServerEnv, BASE_CONFIG, codexEnv, codexHome, codexHomePath, openAppServer, runCodex, type AppServer } from './codexServer';
import { configSecrets, isReadOnlyTool } from './mcp';
import { before, Stopped, TimedOut } from './mcpAuth';
import { scrub } from './mcpCli';
import type { Project } from './store';

/**
 * Connections on GPT desks: which of a project's servers work there, and signing in to a server for GPT.
 *
 * A server you sign in to in a browser (Figma, Atlassian…) keeps one sign-in per client: Claude Code's can't be used
 * by Codex. So a GPT project's row has its own Sign in for GPT. HQ's Codex runs the sign-in for that one server,
 * as `codex mcp login` would: the page comes back to Codex on this PC, and the token stays in HQ's Codex home
 * (data/.codex, a file). HQ never sees it. Programs on this PC and servers with a token need nothing.
 * Which servers wait for a sign-in, and their tools' hints (for Auto's delete check), come from Codex itself
 * (mcpServerStatus/list), on Check and right after a sign-in.
 */

const LOGIN_MS = 10 * 60_000;
const PAGE_MS = 60_000;
const FAILED_SHOWN_MS = 60_000;
const STATUS_MS = 60_000;
const HINTS_MS = 30_000;
const STATUS_PAGES = 20;
/** Codex keeps its sign-ins to servers in this file in its home (mcp_oauth_credentials_store="file"). */
const CREDENTIALS = '.credentials.json';

let timing = { loginMs: LOGIN_MS, pageMs: PAGE_MS };

/** Tests only: shorter waits, and nothing remembered. Call with nothing to undo. */
export function setGptLoginTestHooks(hooks?: { loginMs?: number; pageMs?: number }): void {
  timing = { loginMs: hooks?.loginMs ?? LOGIN_MS, pageMs: hooks?.pageMs ?? PAGE_MS };
  for (const j of jobs.values()) {
    j.cancelled = true;
    j.stop();
  }
  jobs.clear();
  known.clear();
}

export class GptLoginError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * What Codex said about a server, by project and name: its sign-in, its tools' hints, and the URL that was for.
 * n orders the writes, so an answer Codex started on before a sign-in or sign-out landed never replaces it. In
 * memory: a check or a sign-in fills it.
 */
interface Known {
  auth: string;
  at: string;
  url: string;
  n: number;
  tools?: Record<string, McpToolInfo>;
}
const known = new Map<string, Known>();
let writes = 0;

interface Job {
  pid: string;
  name: string;
  login: ConnectionLogin;
  server: AppServer | null;
  cancelled: boolean;
  endedAt?: number;
  stop: () => void;
  stopped: Promise<void>;
}

const jobs = new Map<string, Job>();
const keyOf = (pid: string, name: string) => `${pid}\u0000${name}`;
const nameOfKey = (k: string) => k.slice(k.indexOf('\u0000') + 1);

/** The URL a sign-in is for: Codex keeps one per server id and URL. */
const urlOf = (config: McpServerConfig): string => (config.type === 'http' ? config.url : '');

/** A server you sign in to in a browser: online, with no token header. The rest have nothing to sign in to for GPT. */
function signsIn(config: McpServerConfig): boolean {
  return config.type === 'http' && !Object.keys(config.headers ?? {}).length;
}

/** Note what Codex said. since: the write count when Codex was asked; a newer entry stays. */
function remember(pid: string, name: string, url: string, auth: string, tools?: Record<string, McpToolInfo>, since?: number): void {
  const k = keyOf(pid, name);
  const seen = known.get(k);
  if (since !== undefined && seen && seen.n > since) return;
  const kept = tools ?? (seen?.url === url ? seen.tools : undefined);
  known.set(k, { auth, at: new Date().toISOString(), url, n: ++writes, ...(kept ? { tools: kept } : {}) });
}

/** Forget what Codex said about this server, in one project or (pid null) in every one. */
export function forgetGpt(pid: string | null, name: string): void {
  for (const k of [...known.keys()]) if (nameOfKey(k) === name && (pid === null || k === keyOf(pid, name))) known.delete(k);
}

/** A Codex status row's tools as the guard reads them, by name: the server's read-only and destructive hints. */
function hintsOf(tools: unknown): Record<string, McpToolInfo> | undefined {
  if (!tools || typeof tools !== 'object') return undefined;
  const out: Record<string, McpToolInfo> = {};
  for (const [key, raw] of Object.entries(tools as Record<string, unknown>)) {
    const t = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; annotations?: unknown };
    const name = typeof t.name === 'string' && t.name ? t.name : key;
    const a = (t.annotations && typeof t.annotations === 'object' ? t.annotations : {}) as { readOnlyHint?: unknown; destructiveHint?: unknown };
    const readOnly = typeof a.readOnlyHint === 'boolean' ? a.readOnlyHint : undefined;
    const destructive = typeof a.destructiveHint === 'boolean' ? a.destructiveHint : undefined;
    out[name] = { name, ...(readOnly !== undefined ? { readOnly } : {}), ...(destructive !== undefined ? { destructive } : {}), reads: isReadOnlyTool(name, { readOnly, destructive }) };
  }
  return out;
}

/** Tool hints Codex gave for this server (a GPT check or sign-in), for Auto's delete check. Only for the URL they came from. */
export function gptToolHints(pid: string, name: string, config: McpServerConfig | undefined): Record<string, McpToolInfo> | undefined {
  const seen = known.get(keyOf(pid, name));
  if (!seen?.tools || !config || urlOf(config) !== seen.url) return undefined;
  return seen.tools;
}

/** A server as GPT desks see it, for its row on a GPT project's Connections page. Pure but for what is remembered. */
export function gptRowOf(p: Project, info: McpServerInfo, config: McpServerConfig | undefined): GptConnection {
  const login = gptLoginOf(p.id, info.name);
  const out = (state: GptConnection['state'], why?: string): GptConnection => ({ state, ...(why ? { why } : {}), ...(login ? { login } : {}) });
  if (info.source === 'claude-ai') return out('claude-only', 'a claude.ai connector, which only works on Claude');
  if (!config) return out('unchecked');
  // The same rules as a desk run: a server a run would leave out is Claude only here, with the run's reason.
  const skipped = configFor([{ name: info.name, config }]).skipped[0];
  if (skipped) return out('claude-only', skipped.why);
  // A program on this PC, or a server whose token sits in its headers: nothing to sign in to.
  if (!signsIn(config)) return out('ready');
  const seen = known.get(keyOf(p.id, info.name));
  if (!seen || seen.url !== urlOf(config)) return out('unchecked');
  const state = seen.auth === 'oAuth' ? 'signed-in' : seen.auth === 'notLoggedIn' ? 'needs-login' : seen.auth === 'unknown' ? 'unchecked' : 'ready';
  return { ...out(state), checkedAt: seen.at };
}

/** Codex's settings for a few servers, for a check, a sign-in or a sign-out. Their ids are their tool keys, as on a desk run. */
function configFor(servers: { name: string; config: McpServerConfig }[]) {
  return codexMcp(
    Object.fromEntries(servers.map((s) => [s.name, s.config])),
    servers.map((s) => ({ name: s.name, key: toolKey(s.name), mode: 'ask' as const, tools: {} })),
    { base: codexEnv() },
  );
}

type StatusRow = { name?: unknown; authStatus?: unknown; tools?: unknown };

/** Every row Codex lists, page by page. Tools come with their hints; nothing is called. */
async function statusRows(server: AppServer, params: Record<string, unknown>, timeoutMs: number): Promise<StatusRow[]> {
  const rows: StatusRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < STATUS_PAGES; page++) {
    const res = (await server.request('mcpServerStatus/list', { ...params, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) }, timeoutMs)) as { data?: unknown; nextCursor?: unknown } | null;
    if (Array.isArray(res?.data)) rows.push(...(res.data as StatusRow[]));
    cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null;
    if (!cursor) break;
  }
  return rows;
}

/**
 * Ask Codex which of these servers wait for a sign-in, and what their tools are. Only servers you sign in to in a
 * browser: the rest need nothing, and Claude's check lists their tools. Each starts once, as on a desk run; nothing
 * is called.
 */
export async function checkGptLogins(p: Project, servers: { name: string; config: McpServerConfig }[]): Promise<void> {
  const web = servers.filter((s) => signsIn(s.config));
  if (!web.length) return;
  const mcp = configFor(web);
  if (!mcp.allowed.length) return;
  // A sign-in or sign-out that lands while Codex answers knows better than this check.
  const since = writes;
  let server: AppServer | null = null;
  try {
    server = await openAppServer({ cwd: codexHome(), config: [...BASE_CONFIG, ...mcp.config], env: mcp.env });
    for (const row of await statusRows(server, {}, STATUS_MS)) {
      const s = web.find((w) => toolKey(w.name) === row.name);
      if (s && typeof row.authStatus === 'string') remember(p.id, s.name, urlOf(s.config), row.authStatus, hintsOf(row.tools), since);
    }
  } catch (e) {
    console.error('[hq] gpt connection check:', e instanceof Error ? e.message.slice(0, 200) : 'error');
  } finally {
    await server?.close();
  }
}

/** The GPT sign-in for this server, if one is running or failed in the last minute. */
export function gptLoginOf(pid: string, name: string): ConnectionLogin | undefined {
  const k = keyOf(pid, name);
  const j = jobs.get(k);
  if (!j) return undefined;
  if (j.login.state === 'failed' && j.endedAt && Date.now() - j.endedAt > FAILED_SHOWN_MS) {
    jobs.delete(k);
    return undefined;
  }
  return { ...j.login };
}

function fail(j: Job, error: string): void {
  if (j.cancelled) return;
  j.login = { state: 'failed', error, expiresAt: j.login.expiresAt };
  j.endedAt = Date.now();
}

/** Start signing in to one server for GPT desks. Returns at once; the row follows it. One sign-in at a time. */
export function startGptLogin(p: Project, name: string, config: McpServerConfig): void {
  if (!signsIn(config)) throw new GptLoginError(`${name} has nothing to sign in to for GPT.`, 400);
  const skipped = configFor([{ name, config }]).skipped[0];
  if (skipped) throw new GptLoginError(`GPT desks can't use ${name}: ${skipped.why}.`, 400);
  const other = [...jobs.values()].find((j) => j.login.state !== 'failed');
  if (other) throw new GptLoginError(other.pid === p.id && other.name === name ? 'Signing in is already running.' : `Another sign-in is running (${other.name}). Finish or cancel it first.`, 409);
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const j: Job = { pid: p.id, name, login: { state: 'starting', expiresAt: new Date(Date.now() + timing.loginMs).toISOString() }, server: null, cancelled: false, stop, stopped };
  jobs.set(keyOf(p.id, name), j);
  void run(p, j, config);
}

async function run(p: Project, j: Job, config: McpServerConfig): Promise<void> {
  const key = toolKey(j.name);
  const deadline = Date.parse(j.login.expiresAt);
  // An error can quote the server's own settings: blank its values out, not only token-like words.
  const secrets = configSecrets(config);
  const mcp = configFor([{ name: j.name, config }]);
  const opening = openAppServer({ cwd: codexHome(), config: [...BASE_CONFIG, ...mcp.config], env: mcp.env });
  let step: 'page' | 'wait' = 'page';
  try {
    const server = await before(j, Math.min(deadline, Date.now() + timing.pageMs), opening);
    j.server = server;
    if (j.cancelled) return;
    let completed: (p: { success?: unknown; error?: unknown }) => void = () => undefined;
    const done = new Promise<{ success?: unknown; error?: unknown }>((resolve) => (completed = resolve));
    server.onNotification((m, params) => {
      if (m === 'mcpServer/oauthLogin/completed' && params?.name === key) completed(params);
    });
    // Codex waits for the page to come back as long as HQ does: what is left of HQ's 10 minutes.
    const timeoutSecs = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const res = (await before(j, Math.min(deadline, Date.now() + timing.pageMs), server.request('mcpServer/oauth/login', { name: key, timeoutSecs }))) as { authorizationUrl?: unknown };
    if (j.cancelled) return;
    // The page signs you in to that service: an https page, or one on this PC.
    const authUrl = typeof res?.authorizationUrl === 'string' ? safeAuthUrl(res.authorizationUrl) : null;
    if (!authUrl) return fail(j, `HQ didn't get a sign-in page for ${j.name} from Codex. Try again.`);
    j.login = { ...j.login, state: 'waiting', authUrl };
    step = 'wait';
    const result = await before(j, deadline, done);
    if (j.cancelled) return;
    if (result.success !== true) {
      const said = typeof result.error === 'string' ? scrub(result.error, secrets) : '';
      return fail(j, said ? `Signing in failed: ${said}` : 'Signing in did not finish. Try again.');
    }
    const url = urlOf(config);
    remember(p.id, j.name, url, 'oAuth');
    const since = writes;
    p.log('you', `Signed in to ${j.name} for GPT desks`);
    jobs.delete(keyOf(p.id, j.name));
    // Its tools and their hints, now that Codex can reach it: Auto's delete check reads them. The sign-in itself just
    // landed, so it stays signed in whatever this look says.
    const rows = await statusRows(server, { serverName: key }, HINTS_MS).catch(() => [] as StatusRow[]);
    const row = rows.find((r) => r.name === key);
    if (row) remember(p.id, j.name, url, 'oAuth', hintsOf(row.tools), since);
  } catch (e) {
    if (e instanceof Stopped) return;
    if (e instanceof TimedOut) return fail(j, step === 'page' ? "Codex didn't give a sign-in page in time. Try again." : 'Signing in timed out. Try again.');
    fail(j, scrub(e instanceof Error ? e.message : String(e), secrets) || 'Signing in failed.');
  } finally {
    const s = j.server;
    j.server = null;
    if (s) await s.close();
    // Stopped or timed out while Codex was still starting: close it once it has.
    else void opening.then((late) => late.close()).catch(() => undefined);
  }
}

/** Cancel a GPT sign-in, or dismiss a failed one. False when there is none. */
export function cancelGptLogin(pid: string, name: string): boolean {
  const k = keyOf(pid, name);
  const j = jobs.get(k);
  if (!j) return false;
  j.cancelled = true;
  j.stop();
  jobs.delete(k);
  return true;
}

/** Cancel the GPT sign-ins for this name, in one project or (pid null) in every one: the server is gone. */
export function cancelGptLoginsNamed(pid: string | null, name: string): void {
  for (const j of [...jobs.values()]) if (j.name === name && (pid === null || j.pid === pid)) cancelGptLogin(j.pid, j.name);
}

/** HQ is stopping: every GPT sign-in goes with it. */
export function cancelAllGptLogins(): void {
  for (const j of [...jobs.values()]) cancelGptLogin(j.pid, j.name);
}

/** The last line Codex printed, without its note about PATH helpers in a temp folder. */
function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/PATH aliases/.test(l));
  return (lines.at(-1) ?? '').replace(/^Error:\s*/, '');
}

/**
 * Sign HQ's Codex out of one server with `codex mcp logout`, given the server's settings as on a sign-in. Codex
 * keeps one sign-in per server id and URL for all of HQ. Nothing runs when Codex keeps no sign-ins at all, or
 * could never have used this server. Throws GptLoginError with what Codex said, the server's secrets blanked.
 */
export async function codexLogout(name: string, config: McpServerConfig): Promise<void> {
  if (config.type !== 'http' || !fs.existsSync(path.join(codexHomePath(), CREDENTIALS))) return;
  const mcp = configFor([{ name, config }]);
  if (!mcp.allowed.length) return;
  const settings = [...BASE_CONFIG, ...mcp.config].flatMap((c) => ['-c', c]);
  const r = await runCodex(['mcp', 'logout', ...settings, '--', toolKey(name)], appServerEnv(mcp.env));
  if (r.code === 0) return;
  if (r.timedOut) throw new GptLoginError('Codex did not answer in time.', 504);
  const said = scrub(lastLine(r.startError ?? (r.err || r.out)), configSecrets(config));
  throw new GptLoginError(said ? `Codex could not sign out of ${name}: ${said}` : `Codex could not sign out of ${name}.`, 400);
}

/**
 * Sign out of a server for GPT desks (Sign out for GPT). The sign-in is HQ-wide, one per server id and URL, so
 * other projects' rows for this name say not checked yet until their next Check. Throws GptLoginError.
 */
export async function signOutGpt(p: Project, name: string, config: McpServerConfig): Promise<void> {
  if (!signsIn(config)) throw new GptLoginError(`${name} has nothing to sign in to for GPT.`, 400);
  const j = jobs.get(keyOf(p.id, name));
  if (j && j.login.state !== 'failed') throw new GptLoginError(`Signing in to ${name} for GPT is running. Cancel it first.`, 409);
  await codexLogout(name, config);
  forgetGpt(null, name);
  remember(p.id, name, urlOf(config), 'notLoggedIn');
  p.log('you', `Signed out of ${name} for GPT desks`);
}
