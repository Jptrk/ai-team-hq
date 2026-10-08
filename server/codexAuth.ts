import fs from 'node:fs';
import path from 'node:path';
import { safeOpenAiUrl } from '../shared/account';
import type { ChatGptAccount, ChatGptLogin, ChatGptWindow, GptModel } from '../shared/types';
import { codexHome, codexHomePath, openAppServer, type AppServer } from './codexServer';
import { before, Stopped, TimedOut } from './mcpAuth';
import { scrub } from './mcpCli';
import { setChatGptLogin, settings } from './settings';

/**
 * Signing in to your ChatGPT account (a ChatGPT plan, not an API key) from HQ, for GPT desks.
 *
 * HQ's own Codex does the sign-in (codexServer.ts), as `codex login` would, into HQ's Codex home: never your
 * ~/.codex. On this PC, Codex gives a sign-in page and takes the browser's answer on its own page at
 * 127.0.0.1:1455. From another device, Codex gives a code to type at OpenAI's device page instead (ChatGPT must
 * allow device code sign-in in its security settings). HQ never sees a token: only the account's email and plan,
 * from `account/read`, and the plan's usage windows.
 *
 * Signing in from HQ also says GPT desks may run on this login (data/settings.json). One sign-in at a time.
 * OpenAI allows this sign-in for local apps like HQ, never for a hosted or commercial service.
 */

const LOGIN_MS = 15 * 60_000;
/** Codex gives the sign-in page in seconds: a first step that takes longer has stuck. */
const PAGE_MS = 60_000;
const FAILED_SHOWN_MS = 60_000;
const STATUS_TIMEOUT_MS = 30_000;
/** A status this fresh is used again instead of asking Codex. */
const FRESH_MS = 30_000;
/** The model list changes rarely: asked again after an hour. */
const MODELS_FRESH_MS = 60 * 60_000;
/** Efforts GPT desks don't use: they hand work to sub-agents, which desks don't have. */
const NO_EFFORTS = new Set(['ultra', 'persistent']);

let timing = { loginMs: LOGIN_MS, pageMs: PAGE_MS };

/** Tests only: shorter waits, and the caches forgotten. Call with nothing to undo. */
export function setChatGptTestHooks(hooks?: { loginMs?: number; pageMs?: number }): void {
  timing = { loginMs: hooks?.loginMs ?? LOGIN_MS, pageMs: hooks?.pageMs ?? PAGE_MS };
  cached = null;
  checking = null;
  recheck = null;
  usage = null;
  models = null;
  lastSignInAt = undefined;
  generation++;
  if (job) cancelChatGptLogin();
}

export class ChatGptError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface Job {
  login: ChatGptLogin;
  server: AppServer | null;
  loginId?: string;
  cancelled: boolean;
  endedAt?: number;
  stop: () => void;
  stopped: Promise<void>;
  /** Settles when the sign-in has ended, whichever way. */
  finished?: Promise<void>;
  ok?: boolean;
}

let job: Job | null = null;
let cached: { account: ChatGptAccount | null; at: number } | null = null;
let checking: Promise<ChatGptAccount | null> | null = null;
let recheck: Promise<ChatGptAccount | null> | null = null;
let usage: { windows: ChatGptWindow[]; at: number } | null = null;
let models: { list: GptModel[]; at: number } | null = null;
let lastSignInAt: string | undefined;
/**
 * Bumped when a sign-in works and when you sign out. A status check started before then answers about the login
 * that was, so it saves nothing: a check that read "signed in" just before a sign-out never brings the login back.
 */
let generation = 0;

/** Codex keeps the login here. Being there is the login: signing out removes it. */
export function chatGptAuthFile(): string {
  return path.join(codexHomePath(), 'auth.json');
}

/**
 * A ChatGPT login exists in HQ's Codex home. Cheap: no program runs. Codex is told to keep the login in this file
 * (BASE_CONFIG), so the file is the truth, never what an earlier status check said.
 */
export function hasChatGptLogin(): boolean {
  try {
    return fs.statSync(chatGptAuthFile()).size > 0;
  } catch {
    return false;
  }
}

/** GPT desks may run on HQ's ChatGPT login: you signed in from HQ, or turned it on on the Accounts page. */
export function gptOptIn(): boolean {
  return Boolean(settings().chatgptLogin);
}

/** GPT desks can run: you said yes to the ChatGPT login and HQ's Codex has one. */
export function gptReady(): boolean {
  return gptOptIn() && hasChatGptLogin();
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);

/** What `account/read` answered, keeping only what HQ shows. An API-key login is not a ChatGPT login. Exported for tests. */
export function parseAccount(raw: unknown): ChatGptAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const account = (raw as { account?: unknown }).account;
  if (account === null) return { loggedIn: false };
  if (!account || typeof account !== 'object') return null;
  const a = account as { type?: unknown; email?: unknown; planType?: unknown };
  if (a.type !== 'chatgpt') return { loggedIn: false };
  const out: ChatGptAccount = { loggedIn: true };
  const email = text(a.email);
  const plan = text(a.planType);
  if (email) out.email = email;
  if (plan && plan !== 'unknown') out.plan = plan;
  return out;
}

type Window = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined;

function windowLabel(mins: number | undefined): string {
  if (mins === 300) return '5-hour';
  if (mins === 10_080) return 'weekly';
  if (!mins) return 'usage';
  return mins % 1440 === 0 ? `${mins / 1440}-day` : mins % 60 === 0 ? `${mins / 60}-hour` : `${mins}-minute`;
}

/** A rate-limit snapshot from Codex as usage windows: the 5-hour and the weekly one. Exported for tests. */
export function windowsOf(snapshot: unknown): ChatGptWindow[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const s = snapshot as { primary?: Window; secondary?: Window };
  const out: ChatGptWindow[] = [];
  for (const w of [s.primary, s.secondary]) {
    if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
    const mins = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : undefined;
    const resets = typeof w.resetsAt === 'number' && w.resetsAt > 0 ? new Date(w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) : undefined;
    out.push({ label: windowLabel(mins), usedPercent: Math.max(0, Math.min(100, Math.round(w.usedPercent))), ...(resets ? { resetsAt: resets.toISOString() } : {}) });
  }
  return out;
}

/** The plan's usage, from a check or a desk run (`account/rateLimits/updated`). A run's updates can be partial: they merge in. */
export function noteRateLimits(snapshot: unknown, nowMs = Date.now()): void {
  const windows = windowsOf(snapshot);
  if (!windows.length) return;
  const merged = new Map((usage?.windows ?? []).map((w) => [w.label, w]));
  for (const w of windows) merged.set(w.label, w);
  usage = { windows: [...merged.values()], at: nowMs };
}

/** The plan's usage windows as Codex last reported them. */
export function chatGptUsage(): ChatGptWindow[] | undefined {
  return usage?.windows;
}

/** Codex's model list, as HQ shows it: hidden models left out, and efforts desks can't use. Exported for tests. */
export function parseModels(raw: unknown): GptModel[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: GptModel[] = [];
  for (const m of data as Record<string, unknown>[]) {
    const id = text(m?.id);
    if (!id || m.hidden === true || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) continue;
    const efforts = Array.isArray(m.supportedReasoningEfforts)
      ? (m.supportedReasoningEfforts as { reasoningEffort?: unknown }[])
          .map((e) => e?.reasoningEffort)
          .filter((e): e is string => typeof e === 'string' && /^[a-z]{1,20}$/.test(e) && !NO_EFFORTS.has(e))
      : [];
    const def = text(m.defaultReasoningEffort);
    out.push({ id, name: text(m.displayName) ?? id, efforts, ...(def && !NO_EFFORTS.has(def) ? { defaultEffort: def } : {}), ...(m.isDefault === true ? { isDefault: true } : {}) });
  }
  return out;
}

/** The models GPT desks can use, as Codex last listed them. */
export function gptModels(): GptModel[] {
  return models?.list ?? [];
}

/**
 * Ask Codex who is signed in (and, signed in, the plan's usage), plus the model list when it is stale. gen: the
 * generation the ask started in; the usage is kept only while it is still the current one.
 */
async function readAll(server: AppServer, gen: number): Promise<ChatGptAccount | null> {
  const account = parseAccount(await server.request('account/read', { refreshToken: false }, STATUS_TIMEOUT_MS));
  if (account?.loggedIn) {
    try {
      const limits = (await server.request('account/rateLimits/read', undefined, STATUS_TIMEOUT_MS)) as { rateLimits?: unknown };
      if (gen === generation) noteRateLimits(limits?.rateLimits);
    } catch {
      /* usage is a nice-to-have */
    }
  }
  if (!models || Date.now() - models.at > MODELS_FRESH_MS) {
    try {
      const list = parseModels(await server.request('model/list', { limit: 50 }, STATUS_TIMEOUT_MS));
      if (list.length) models = { list, at: Date.now() };
    } catch {
      /* the model list is a nice-to-have */
    }
  }
  return account;
}

/**
 * Ask Codex who is signed in, and save the answer. A sign-in or sign-out meanwhile makes the answer stale: it saves
 * nothing, and the caller gets what HQ knows now instead.
 */
function askStatus(): Promise<ChatGptAccount | null> {
  const gen = generation;
  const run = (async () => {
    let account: ChatGptAccount | null = null;
    let server: AppServer | null = null;
    try {
      server = await openAppServer({ cwd: codexHome() });
      account = await readAll(server, gen);
    } catch (e) {
      console.error('[hq] chatgpt status:', e instanceof Error ? e.message.slice(0, 200) : 'error');
      account = null;
    } finally {
      await server?.close();
    }
    if (gen !== generation) return cached?.account ?? null;
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

/** Ask Codex who is signed in, or use what it said in the last half minute. Null: it did not answer. */
export function checkChatGpt(force = false): Promise<ChatGptAccount | null> {
  if (!force) {
    const pending = recheck ?? checking;
    if (pending) return pending;
    if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.account);
    return askStatus();
  }
  // Forced (after a sign-in or sign-out): one more check runs after any already running, shared by forced callers.
  if (recheck) return recheck;
  if (!checking) return askStatus();
  const next: Promise<ChatGptAccount | null> = checking
    .catch(() => null)
    .then(() => {
      if (recheck === next) recheck = null;
      return askStatus();
    });
  recheck = next;
  return next;
}

/** The last answer, without asking again. */
export function chatGptCached(): { account: ChatGptAccount | null; checkedAt?: string } {
  return cached ? { account: cached.account, checkedAt: new Date(cached.at).toISOString() } : { account: null };
}

/** When the last sign-in from HQ worked, since HQ started. */
export function lastChatGptSignIn(): string | undefined {
  return lastSignInAt;
}

/** The sign-in, if one is running or failed in the last minute. */
export function chatGptLogin(): ChatGptLogin | undefined {
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
  j.login = { state: 'failed', method: j.login.method, error, expiresAt: j.login.expiresAt };
  j.endedAt = Date.now();
}

const USER_CODE = /^[A-Za-z0-9-]{4,24}$/;

/** Start signing in. Returns at once; GET /api/account/chatgpt follows it. */
export function startChatGptLogin(method: 'browser' | 'device'): void {
  if (running()) throw new ChatGptError('Signing in is already running.', 409);
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const j: Job = { login: { state: 'starting', method, expiresAt: new Date(Date.now() + timing.loginMs).toISOString() }, server: null, cancelled: false, stop, stopped };
  job = j;
  j.finished = run(j);
}

async function run(j: Job): Promise<void> {
  const deadline = Date.parse(j.login.expiresAt);
  const pageBy = Math.min(deadline, Date.now() + timing.pageMs);
  let step: 'page' | 'wait' = 'page';
  const opening = openAppServer({ cwd: codexHome() });
  try {
    const server = await before(j, pageBy, opening);
    j.server = server;
    if (j.cancelled) return;
    let completed: (p: { loginId?: unknown; success?: unknown; error?: unknown }) => void = () => undefined;
    const done = new Promise<{ loginId?: unknown; success?: unknown; error?: unknown }>((resolve) => (completed = resolve));
    server.onNotification((m, p) => {
      if (m === 'account/login/completed' && p && (!j.loginId || p.loginId === j.loginId)) completed(p);
    });
    const res = (await before(j, pageBy, server.request('account/login/start', j.login.method === 'device' ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt' }))) as Record<string, unknown>;
    if (j.cancelled) return;
    if (typeof res?.loginId === 'string') j.loginId = res.loginId;
    if (j.login.method === 'device') {
      // The device page is OpenAI's own; the code is short letters and digits.
      const verificationUrl = safeOpenAiUrl(res?.verificationUrl);
      const userCode = typeof res?.userCode === 'string' && USER_CODE.test(res.userCode) ? res.userCode : undefined;
      if (!verificationUrl || !userCode) return fail(j, "HQ didn't get a device code from Codex. Sign in on this PC instead.");
      j.login = { ...j.login, state: 'waiting', verificationUrl, userCode };
    } else {
      // The link signs in to your ChatGPT account: only ever an https page on OpenAI's sign-in site.
      const authUrl = safeOpenAiUrl(res?.authUrl);
      if (!authUrl) return fail(j, "HQ didn't get a ChatGPT sign-in page from Codex. Try again.");
      j.login = { ...j.login, state: 'waiting', authUrl };
    }

    step = 'wait';
    const result = await before(j, deadline, done);
    if (j.cancelled) return;
    if (result.success !== true) {
      const said = typeof result.error === 'string' ? scrub(result.error) : '';
      return fail(j, said ? `Signing in failed: ${said}` : 'Signing in did not finish. Try again.');
    }
    // A new login: a status check that started before it answers about the old one, and saves nothing.
    const gen = ++generation;
    // Ask who is signed in while the sign-in still shows as running, so a poll never sees it gone and the login not there yet.
    const account = await readAll(server, gen).catch(() => null);
    if (gen === generation) cached = { account, at: Date.now() };
    if (j.cancelled) return;
    if (!account?.loggedIn) return fail(j, 'Codex finished but saved no ChatGPT login. Try again.');
    setChatGptLogin(true);
    j.ok = true;
    lastSignInAt = new Date().toISOString();
    if (job === j) job = null;
  } catch (e) {
    if (e instanceof Stopped) return;
    if (e instanceof TimedOut) return fail(j, step === 'page' ? "Codex didn't give a sign-in page in time. Try again." : 'Signing in timed out. Try again.');
    const said = scrub(e instanceof Error ? e.message : String(e));
    if (j.login.method === 'device' && /device/i.test(said)) {
      return fail(j, 'ChatGPT refused a device code. Turn on device code sign-in in ChatGPT (Settings, Security), or sign in on this PC.');
    }
    fail(j, said || 'Signing in failed.');
  } finally {
    const s = j.server;
    j.server = null;
    if (s) {
      if (!j.ok && j.loginId) await s.request('account/login/cancel', { loginId: j.loginId }, 5_000).catch(() => undefined);
      await s.close();
    } else {
      // Stopped or timed out while Codex was still starting: close it once it has.
      void opening.then((late) => late.close()).catch(() => undefined);
    }
  }
}

export function cancelChatGptLogin(): boolean {
  const j = job;
  if (!j) return false;
  j.cancelled = true;
  j.stop();
  job = null;
  return true;
}

/** May GPT desks run on the ChatGPT login HQ has? Yes needs a login. */
export function useChatGptLogin(on: boolean): void {
  if (on && !hasChatGptLogin()) throw new ChatGptError('Sign in to ChatGPT first.', 409);
  setChatGptLogin(on);
}

/** Sign HQ's Codex out of ChatGPT. Your own Codex CLI keeps its login: HQ's is separate. */
export async function signOutChatGpt(): Promise<void> {
  if (running()) throw new ChatGptError('A sign-in is running. Cancel it first.', 409);
  let server: AppServer | null = null;
  try {
    server = await openAppServer({ cwd: codexHome() });
    await server.request('account/logout', undefined, STATUS_TIMEOUT_MS);
  } catch (e) {
    throw new ChatGptError(`Codex could not sign out: ${scrub(e instanceof Error ? e.message : String(e)) || 'no answer'}`, 502);
  } finally {
    await server?.close();
  }
  // Signed out: a status check still running read the login that was, so it saves nothing (see askStatus).
  generation++;
  setChatGptLogin(false);
  usage = null;
  cached = { account: { loggedIn: false }, at: Date.now() };
}
