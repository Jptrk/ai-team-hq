import fs from 'node:fs';
import path from 'node:path';
import { safeClaudeUrl } from '../shared/account';
import type { AccountLogin, ClaudeAccount } from '../shared/types';
import { openSession, type McpSession } from './mcp';
import { before, Stopped, TimedOut } from './mcpAuth';
import { claudeConfigDir, cliMessage, runCli, scrub } from './mcpCli';
import { claudeEnv, HQ_ROOT } from './paths';
import { setClaudeLogin } from './settings';

/**
 * Signing in to your Claude account (a Claude subscription, not an API key) from HQ.
 *
 * Claude Code does the sign-in, as `claude auth login` would. A session with no tools and no servers asks it
 * for the sign-in page; HQ shows the page; you sign in in your own browser; Claude Code takes the
 * browser's answer on its own page on this PC, saves the login where every Claude Code here finds it
 * (~/.claude, the login desks run on), and the wait ends. When the browser can't come back (another device),
 * the second page ends on a code you paste into HQ instead. HQ never sees a token: only the account's email,
 * organization and plan, from `claude auth status`.
 *
 * Signing in from HQ also says desks may run on this login (data/settings.json), so the next start is live
 * without HQ_RUNNER in .env. One sign-in at a time. Every wait has a deadline: the SDK's own calls never time out.
 */

const LOGIN_MS = 600_000;
/** Claude Code gives the sign-in page in seconds: a first step that takes longer has stuck. */
const PAGE_MS = 60_000;
const FAILED_SHOWN_MS = 60_000;
const STATUS_TIMEOUT_MS = 20_000;
/** A status this fresh is used again instead of asking Claude Code. */
const FRESH_MS = 30_000;
/** The sign-in pages Claude Code can't give: the terminal way, then the switch here. */
const TERMINAL_WAY = 'Sign in with Claude Code in a terminal (claude auth login), then turn on Run desks on my Claude login here.';

let timing = { loginMs: LOGIN_MS, pageMs: PAGE_MS };
let open: typeof openSession = openSession;
let cli: typeof runCli = runCli;

/** Tests only: a stand-in for the Claude Code session and CLI, and shorter waits. Call with nothing to undo. */
export function setAccountTestHooks(hooks?: { open?: typeof openSession; cli?: typeof runCli; loginMs?: number; pageMs?: number }): void {
  open = hooks?.open ?? openSession;
  cli = hooks?.cli ?? runCli;
  timing = { loginMs: hooks?.loginMs ?? LOGIN_MS, pageMs: hooks?.pageMs ?? PAGE_MS };
  cached = null;
  checking = null;
  recheck = null;
  lastSignInAt = undefined;
}

type AuthQuery = McpSession['q'] & {
  claudeAuthenticate?: (loginWithClaudeAi: boolean) => Promise<unknown>;
  claudeOAuthCallback?: (authorizationCode: string, state: string) => Promise<unknown>;
  claudeOAuthWaitForCompletion?: () => Promise<unknown>;
};

interface Job {
  login: AccountLogin;
  session: McpSession | null;
  cancelled: boolean;
  endedAt?: number;
  /** Ends any wait in progress when the sign-in is cancelled. */
  stop: () => void;
  stopped: Promise<void>;
  /** Settles when the sign-in has ended, whichever way. */
  finished?: Promise<void>;
  /** It worked: Claude Code saved a login and HQ saw it. */
  ok?: boolean;
  /** The pasted code and state, kept out of any error shown. */
  secrets: string[];
}

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let job: Job | null = null;
let cached: { account: ClaudeAccount | null; at: number } | null = null;
let checking: Promise<ClaudeAccount | null> | null = null;
/** A forced check waiting for the running one to end. Forced callers meanwhile share it. */
let recheck: Promise<ClaudeAccount | null> | null = null;
/** When the last sign-in from HQ worked: the page says "Signed in as" once for each. */
let lastSignInAt: string | undefined;

/** Where the sign-in session and `claude auth` start: an empty folder of HQ's own. */
function homeDir(): string {
  const dir = path.join(HQ_ROOT, 'data', '.account');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Claude Code's environment, without an API key: `claude auth` then reports the saved login, not the key. */
function loginEnv(): NodeJS.ProcessEnv {
  const env = claudeEnv({ DISABLE_AUTOUPDATER: '1' });
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/** The last read of the credentials file, kept while it is unchanged: the meta asks on every poll. */
let credsSeen: { file: string; mtimeMs: number; size: number; login: boolean } | null = null;

/** The credentials file holds a Claude login. It can also hold only MCP sign-ins, so being there is not enough. Exported for tests. */
export function credentialsHaveLogin(file = path.join(claudeConfigDir(), '.credentials.json')): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (credsSeen && credsSeen.file === file && credsSeen.mtimeMs === st.mtimeMs && credsSeen.size === st.size) return credsSeen.login;
  let login = false;
  try {
    const o = (JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown } }).claudeAiOauth;
    login = Boolean(o && ((typeof o.refreshToken === 'string' && o.refreshToken) || (typeof o.accessToken === 'string' && o.accessToken)));
  } catch {
    login = false;
  }
  credsSeen = { file, mtimeMs: st.mtimeMs, size: st.size, login };
  return login;
}

/**
 * Some Claude login exists for desks to run on: a token in the environment, a saved login, or what Claude Code
 * said last (on a Mac the login is in the keychain, not the file). Cheap: no program runs.
 */
export function hasClaudeLogin(): boolean {
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) || credentialsHaveLogin() || Boolean(cached?.account?.loggedIn);
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);

/** What `claude auth status --json` printed, keeping only what HQ shows. Null when it isn't that. Exported for tests. */
export function parseAuthStatus(out: string): ClaudeAccount | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(out.trim()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof raw.loggedIn !== 'boolean') return null;
  if (!raw.loggedIn) return { loggedIn: false };
  const account: ClaudeAccount = { loggedIn: true };
  const fields: [keyof ClaudeAccount, unknown][] = [
    ['method', raw.authMethod],
    ['email', raw.email],
    ['org', raw.orgName],
    ['plan', raw.subscriptionType],
  ];
  for (const [key, value] of fields) {
    const v = text(value);
    if (v) (account[key] as string) = v;
  }
  return account;
}

/** Run `claude auth status` once, and remember the answer. */
function askStatus(): Promise<ClaudeAccount | null> {
  const run = (async () => {
    const r = await cli(['auth', 'status', '--json'], { cwd: homeDir(), timeoutMs: STATUS_TIMEOUT_MS, env: loginEnv() });
    const account = r.timedOut ? null : parseAuthStatus(r.out);
    cached = { account, at: Date.now() };
    return account;
  })();
  checking = run;
  run
    .finally(() => {
      if (checking === run) checking = null;
    })
    .catch(() => undefined);
  return run;
}

/** Ask Claude Code who is signed in, or use what it said in the last half minute. Null: it did not answer. */
export function checkAccount(force = false): Promise<ClaudeAccount | null> {
  if (!force) {
    // A check running now is newer than the cache: right after a sign-in, the cache still says signed out.
    const pending = recheck ?? checking;
    if (pending) return pending;
    if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.account);
    return askStatus();
  }
  // Forced (after a sign-in or sign-out): a check already running may have started before it, so one more
  // runs after it. Only one waits: forced callers meanwhile share it, so they can't pile up Claude Code runs.
  if (recheck) return recheck;
  if (!checking) return askStatus();
  const next: Promise<ClaudeAccount | null> = checking
    .catch(() => null)
    .then(() => {
      if (recheck === next) recheck = null;
      return askStatus();
    });
  recheck = next;
  return next;
}

/** The last answer, without asking again. */
export function accountCached(): { account: ClaudeAccount | null; checkedAt?: string } {
  return cached ? { account: cached.account, checkedAt: new Date(cached.at).toISOString() } : { account: null };
}

/** When the last sign-in from HQ worked, since HQ started. */
export function lastSignIn(): string | undefined {
  return lastSignInAt;
}

/** The sign-in, if one is running or failed in the last minute. */
export function accountLogin(): AccountLogin | undefined {
  if (!job) return undefined;
  if (job.login.state === 'failed' && job.endedAt && Date.now() - job.endedAt > FAILED_SHOWN_MS) {
    job = null;
    return undefined;
  }
  return { ...job.login };
}

function running(): boolean {
  return Boolean(job && job.login.state !== 'failed');
}

function fail(j: Job, error: string): void {
  if (j.cancelled) return;
  j.login = { state: 'failed', error, expiresAt: j.login.expiresAt };
  j.endedAt = Date.now();
}

/** Start signing in. Returns at once; GET /api/account follows it. */
export function startAccountLogin(): void {
  if (running()) throw new AccountError('Signing in is already running.', 409);
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const j: Job = { login: { state: 'starting', expiresAt: new Date(Date.now() + timing.loginMs).toISOString() }, session: null, cancelled: false, stop, stopped, secrets: [] };
  job = j;
  let session: McpSession;
  try {
    session = open(homeDir(), {}, false);
  } catch {
    // A sign-in that never started must not block the next one.
    fail(j, 'Could not start Claude Code to sign in. Try again.');
    return;
  }
  if (typeof (session.q as AuthQuery).claudeAuthenticate !== 'function' || typeof (session.q as AuthQuery).claudeOAuthWaitForCompletion !== 'function') {
    void session.close();
    fail(j, `This version of the Agent SDK can't sign in from HQ. ${TERMINAL_WAY}`);
    return;
  }
  j.session = session;
  j.finished = run(j);
}

async function run(j: Job): Promise<void> {
  const q = j.session!.q as AuthQuery;
  const deadline = Date.parse(j.login.expiresAt);
  let step: 'page' | 'wait' = 'page';
  try {
    // A shorter wait for the page: with no page, there is nothing for you to do for ten minutes.
    const res = (await before(j, Math.min(deadline, Date.now() + timing.pageMs), q.claudeAuthenticate!(true))) as { automaticUrl?: unknown; manualUrl?: unknown } | undefined;
    if (j.cancelled) return;
    const authUrl = safeClaudeUrl(res?.automaticUrl);
    const manualUrl = safeClaudeUrl(res?.manualUrl);
    // The link signs in to your Claude account: only ever an https page on Anthropic's own sites.
    if (!authUrl && !manualUrl) return fail(j, `HQ didn't get a Claude sign-in page. ${TERMINAL_WAY}`);
    j.login = { ...j.login, state: 'waiting', ...(authUrl ? { authUrl } : {}), ...(manualUrl ? { manualUrl } : {}) };

    step = 'wait';
    await before(j, deadline, q.claudeOAuthWaitForCompletion!());
    if (j.cancelled) return;
    // Ask who is signed in while the sign-in still shows as running, so a poll never sees it gone and
    // the login not there yet. A wait that ended without a saved login is no sign-in.
    const account = await checkAccount(true).catch(() => null);
    if (j.cancelled) return;
    if (!(account?.loggedIn || credentialsHaveLogin())) return fail(j, 'Claude Code finished but saved no login. Try again.');
    setClaudeLogin(true);
    j.ok = true;
    lastSignInAt = new Date().toISOString();
    if (job === j) job = null;
  } catch (e) {
    if (e instanceof Stopped) return;
    if (e instanceof TimedOut) return fail(j, step === 'page' ? "Claude Code didn't give a sign-in page in time. Try again." : 'Signing in timed out. Try again.');
    fail(j, scrub(e instanceof Error ? e.message : String(e), j.secrets) || 'Signing in failed.');
  } finally {
    const s = j.session;
    j.session = null;
    await s?.close();
  }
}

const CODE_PART = /^[A-Za-z0-9._~-]+$/;

/** The code the sign-in page shows: `code#state`. A sentence when it isn't one. Exported for tests. */
export function parseAuthCode(raw: unknown): { code: string; state: string } | string {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return 'Paste the code from the sign-in page.';
  if (t.length > 4000) return "That isn't a sign-in code.";
  const parts = t.split('#');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return 'Paste the whole code, including the part after #.';
  if (!CODE_PART.test(parts[0]) || !CODE_PART.test(parts[1])) return "That isn't a sign-in code.";
  return { code: parts[0], state: parts[1] };
}

/** The browser couldn't come back to this PC: finish with the code the sign-in page showed. Resolves once Claude Code took it. */
export async function submitAccountCode(raw: unknown): Promise<void> {
  const j = job;
  if (!j || j.login.state !== 'waiting' || !j.session) throw new AccountError('No sign-in is waiting for a code. Start again.', 409);
  const q = j.session.q as AuthQuery;
  if (typeof q.claudeOAuthCallback !== 'function') throw new AccountError(`This version of the Agent SDK can't take a code. ${TERMINAL_WAY}`, 501);
  const parsed = parseAuthCode(raw);
  if (typeof parsed === 'string') throw new AccountError(parsed, 400);
  // A refusal ends the whole sign-in, and its error may quote the code back.
  j.secrets = [parsed.code, parsed.state];
  try {
    await before(j, Date.parse(j.login.expiresAt), q.claudeOAuthCallback(parsed.code, parsed.state));
    // Claude Code took it: answer once HQ has saved the opt-in and asked who is signed in now.
    await j.finished;
  } catch (e) {
    if (e instanceof Stopped) throw new AccountError('The sign-in was cancelled.', 409);
    if (e instanceof TimedOut) throw new AccountError('Signing in timed out. Try again.', 504);
    // The browser may have finished the same sign-in meanwhile: Claude Code then says no sign-in is running.
    await j.finished?.catch(() => undefined);
    if (j.ok) return;
    if (j.cancelled) throw new AccountError('The sign-in was cancelled.', 409);
    const said = scrub(e instanceof Error ? e.message : String(e), j.secrets);
    throw new AccountError(said || 'Claude did not take that code. Start again and paste the new one.', 400);
  }
}

export function cancelAccountLogin(): boolean {
  const j = job;
  if (!j) return false;
  j.cancelled = true;
  j.stop();
  job = null;
  void j.session?.close();
  return true;
}

/** May desks run on the Claude login already on this PC? Yes needs a login; it takes effect when HQ next starts. */
export function useClaudeLogin(on: boolean): void {
  if (on && !hasClaudeLogin()) throw new AccountError('Sign in to your Claude account first.', 409);
  setClaudeLogin(on);
}

/**
 * Sign out of the Claude account, as `claude auth logout` does: for every Claude Code on this PC, not just HQ.
 * Desks stop running on it until you sign in again.
 */
export async function signOutAccount(): Promise<void> {
  if (running()) throw new AccountError('A sign-in is running. Cancel it first.', 409);
  const r = await cli(['auth', 'logout'], { cwd: homeDir(), timeoutMs: 30_000, env: loginEnv() });
  if (r.code !== 0) throw new AccountError(cliMessage(r, 'Claude Code could not sign out.'), 502);
  setClaudeLogin(false);
  await checkAccount(true);
}
