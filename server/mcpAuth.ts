import type { McpServerConfig, McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { safeAuthUrl } from '../shared/mcpSpec';
import type { ConnectionLogin } from '../shared/types';
import { configSecrets, openSession, type McpSession } from './mcp';
import { scrub } from './mcpCli';
import type { Project } from './store';

/**
 * Signing in to an MCP server from HQ.
 *
 * `claude mcp login` needs a real terminal, so HQ uses the session's own sign-in instead: a
 * session with just that server asks Claude Code for the sign-in page, Claude Code waits for the
 * browser to come back to it, saves the token where desks and Claude Code find it, and reconnects.
 * You sign in yourself in your browser, so it is your account. One sign-in at a time.
 *
 * The SDK call is not in its published types. If it is missing, or it gives no sign-in page, the
 * row offers a terminal instead. Every wait has a deadline: the SDK's own calls never time out.
 */

// Claude Code waits 5 minutes for the browser; give it a little longer.
const LOGIN_MS = 330_000;
const FIRST_STATUS_MS = 20_000;
const POLL_MS = 1_500;
const FAILED_SHOWN_MS = 60_000;

let timing = { loginMs: LOGIN_MS, firstStatusMs: FIRST_STATUS_MS, pollMs: POLL_MS };
let open: typeof openSession = openSession;

/** Tests only: a stand-in for the Claude Code session, and shorter waits. Call with nothing to undo. */
export function setLoginTestHooks(hooks?: { open?: typeof openSession; loginMs?: number; firstStatusMs?: number; pollMs?: number }): void {
  open = hooks?.open ?? openSession;
  timing = { loginMs: hooks?.loginMs ?? LOGIN_MS, firstStatusMs: hooks?.firstStatusMs ?? FIRST_STATUS_MS, pollMs: hooks?.pollMs ?? POLL_MS };
}

interface Job {
  pid: string;
  name: string;
  login: ConnectionLogin;
  session: McpSession | null;
  /** Values from the server's config, blanked out of its error messages. */
  secrets: string[];
  endedAt?: number;
  cancelled: boolean;
  /** Ends any wait in progress when the sign-in is cancelled. */
  stop: () => void;
  stopped: Promise<void>;
}

type AuthQuery = McpSession['q'] & { mcpAuthenticate?: (name: string, redirectUri?: string) => Promise<unknown> };

const jobs = new Map<string, Job>();
const keyOf = (pid: string, name: string) => `${pid}\n${name}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LoginError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A wait ran past its deadline. */
export class TimedOut extends Error {}
/** The sign-in was cancelled while waiting. */
export class Stopped extends Error {}

export interface LoginHooks {
  /** The server reports connected: record its tools. */
  onConnected(status: McpServerStatus): void;
}

function running(): Job | undefined {
  return [...jobs.values()].find((j) => j.login.state !== 'failed');
}

/** The sign-in for this server, if one is running or failed in the last minute. */
export function loginOf(pid: string, name: string): ConnectionLogin | undefined {
  const key = keyOf(pid, name);
  const j = jobs.get(key);
  if (!j) return undefined;
  if (j.login.state === 'failed' && j.endedAt && Date.now() - j.endedAt > FAILED_SHOWN_MS) {
    jobs.delete(key);
    return undefined;
  }
  return { ...j.login };
}

/** A sign-in is running for this server: in project `pid`, or in any project when pid is null (servers saved for all projects). */
export function loginRunning(pid: string | null, name: string): boolean {
  return [...jobs.values()].some((j) => j.name === name && (pid === null || j.pid === pid) && (j.login.state === 'starting' || j.login.state === 'waiting'));
}

function fail(job: Job, error: string, unsupported = false): void {
  if (job.cancelled) return;
  job.login = { state: 'failed', error, expiresAt: job.login.expiresAt, ...(unsupported ? { unsupported } : {}) };
  job.endedAt = Date.now();
}

/** Start signing in. Returns at once; the row shows the progress. */
export function startLogin(p: Project, name: string, config: McpServerConfig, hooks: LoginHooks): void {
  const other = running();
  if (other) {
    throw new LoginError(other.pid === p.id && other.name === name ? 'Signing in is already running.' : `Another sign-in is running (${other.name}). Finish or cancel it first.`, 409);
  }
  const key = keyOf(p.id, name);
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const job: Job = {
    pid: p.id,
    name,
    login: { state: 'starting', expiresAt: new Date(Date.now() + timing.loginMs).toISOString() },
    session: null,
    secrets: configSecrets(config),
    cancelled: false,
    stop,
    stopped,
  };
  jobs.set(key, job);
  let session: McpSession;
  try {
    session = open(path.join(p.workspace, '.probe'), { [name]: config }, false);
  } catch {
    // A sign-in that never started must not block every other one.
    fail(job, 'Could not start a session to sign in. Try again.');
    return;
  }
  if (typeof (session.q as AuthQuery).mcpAuthenticate !== 'function') {
    void session.close();
    fail(job, "This version of the Agent SDK can't sign in from HQ. Log in from a terminal instead.", true);
    return;
  }
  job.session = session;
  void run(job, hooks);
}

/** `promise`, unless the time `by` passes (TimedOut) or the sign-in is cancelled (Stopped) first. Also used by claudeAuth.ts. */
export async function before<T>(job: { stopped: Promise<void> }, by: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TimedOut()), Math.max(0, by - Date.now()))));
  const stopped = job.stopped.then(() => Promise.reject(new Stopped()));
  try {
    return await Promise.race([promise, late, stopped]);
  } finally {
    clearTimeout(timer);
  }
}

async function run(job: Job, hooks: LoginHooks): Promise<void> {
  const q = job.session!.q as AuthQuery;
  const deadline = Date.parse(job.login.expiresAt);
  const statusBy = async (by: number) => (await before(job, by, q.mcpServerStatus())).find((s) => s.name === job.name);
  const clean = (text: string) => scrub(text, job.secrets);
  const done = (st: McpServerStatus) => {
    if (job.cancelled) return;
    // Only this job's own entry: a newer sign-in for the same server may have taken its place.
    if (jobs.get(keyOf(job.pid, job.name)) === job) jobs.delete(keyOf(job.pid, job.name));
    hooks.onConnected(st);
  };
  try {
    const firstBy = Date.now() + timing.firstStatusMs;
    let st: McpServerStatus | undefined;
    try {
      st = await statusBy(firstBy);
      while ((!st || st.status === 'pending') && Date.now() < firstBy && !job.cancelled) {
        await sleep(500);
        st = await statusBy(firstBy);
      }
    } catch (e) {
      if (!(e instanceof TimedOut)) throw e;
      st = undefined;
    }
    if (job.cancelled) return;
    if (st?.status === 'connected') return done(st);
    if (st?.status !== 'needs-auth') {
      return fail(job, st?.error ? clean(st.error) : st ? 'The server did not ask for a sign-in.' : 'The server did not answer.');
    }

    const res = (await before(job, deadline, q.mcpAuthenticate!(job.name))) as { authUrl?: unknown; requiresUserAction?: unknown } | undefined;
    if (job.cancelled) return;
    const raw = typeof res?.authUrl === 'string' && res.authUrl ? res.authUrl : undefined;
    const url = safeAuthUrl(raw);
    // The link comes from the remote server: only ever show a web page.
    if (raw && !url) return fail(job, 'The server sent a sign-in link that is not a web page, so HQ did not show it.');
    // It needs you in a browser but gave no page (a newer SDK may name it differently): the terminal works instead.
    if (!url && res?.requiresUserAction !== false) return fail(job, "HQ didn't get a sign-in page for it. Log in from a terminal instead.", true);
    job.login = { ...job.login, state: 'waiting', ...(url ? { authUrl: url } : {}) };

    while (Date.now() < deadline && !job.cancelled) {
      await sleep(timing.pollMs);
      if (job.cancelled) return;
      st = await statusBy(deadline);
      if (job.cancelled) return;
      if (st?.status === 'connected') return done(st);
      if (st?.status === 'failed') return fail(job, st.error ? clean(st.error) : 'Signing in failed.');
    }
    fail(job, 'Signing in timed out. Try again.');
  } catch (e) {
    if (e instanceof Stopped) return;
    if (e instanceof TimedOut) return fail(job, 'Signing in timed out. Try again.');
    fail(job, clean(e instanceof Error ? e.message : String(e)) || 'Signing in failed.');
  } finally {
    const s = job.session;
    job.session = null;
    await s?.close();
  }
}

export function cancelLogin(pid: string, name: string): boolean {
  const key = keyOf(pid, name);
  const j = jobs.get(key);
  if (!j) return false;
  j.cancelled = true;
  j.stop();
  jobs.delete(key);
  void j.session?.close();
  return true;
}

/** Cancel the sign-ins for a server name in every project: after a server saved for all projects is added or removed. */
export function cancelLoginsNamed(name: string): void {
  for (const j of [...jobs.values()]) if (j.name === name) cancelLogin(j.pid, j.name);
}

/** On shutdown: close every sign-in session. */
export function cancelAllLogins(): void {
  for (const j of [...jobs.values()]) cancelLogin(j.pid, j.name);
}
