import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { AuthStatus } from '../shared/types';
import { hostAllowed } from './http';

/**
 * HQ's own login. One owner account for now, kept as a list so more people can come later.
 *
 *   data/auth.json   the users (a name and a scrypt hash of the password) and the sessions (a SHA-256 of each code)
 *
 * A session code lives only in the browser's hq_session_<port> cookie (COOKIE):
 *   - HttpOnly: page scripts can't read it.
 *   - SameSite=Strict: another site can't make the browser send it, so a cross-site <img> or form never counts as
 *     you. No sign-in flow comes back to HQ's port (Claude, Codex and MCP sign-ins land on their own pages), so
 *     Strict costs nothing.
 * The first account can only be made from the PC HQ runs on (setupAllowed).
 * Lost password: stop HQ, delete data/auth.json, start HQ and open it on that PC. Projects are not touched.
 */

const FILE = path.resolve(process.cwd(), 'data', 'auth.json');

/**
 * Named after the API's port (read once, as server/index.ts listens on it). Cookies don't tell ports apart, so with
 * one name a scratch copy on another port (README, Tests) would log the real HQ out and back.
 */
export const COOKIE = `hq_session_${Number(process.env.PORT ?? 4747)}`;
const DAY = 86_400_000;
/** A session ends this long after it was last used. */
export const SESSION_DAYS = 30;
/** Polling refreshes a session at most this often, so data/auth.json isn't rewritten every 3 seconds. */
const REFRESH_MS = DAY;
const MAX_SESSIONS = 20;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;
const NAME_MAX = 40;

// scrypt at N=2^15, r=8, p=3, one of OWASP's settings. It needs about 32 MB, just over Node's default maxmem.
const COST = { N: 2 ** 15, r: 8, p: 3 };
const KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

// Failed logins: after FAIL_MAX in FAIL_WINDOW counted against one key (tryKey), it waits out the rest of the window.
const FAIL_WINDOW = 15 * 60_000;
const FAIL_MAX = 5;

export interface AuthUser {
  id: string;
  name: string;
  /** scrypt$N$r$p$salt$key, salt and key in base64url. */
  hash: string;
  createdAt: string;
}

interface StoredSession {
  /** SHA-256 of the session code, hex. The code itself is only in the cookie. */
  id: string;
  userId: string;
  createdAt: string;
  /** Last use, refreshed at most once a day. The session ends SESSION_DAYS after it. */
  seenAt: string;
}

interface AuthFile {
  users: AuthUser[];
  sessions: StoredSession[];
}

/** What the login code needs from a request. Express's Request has it; tests pass a plain object. */
export interface AuthRequest {
  get(header: string): string | undefined;
  socket?: { remoteAddress?: string };
  ip?: string;
  secure?: boolean;
}

let current: AuthFile | null = null;
/** data/auth.json is there but can't be read: nobody can log in or set up until it is fixed or deleted. */
let broken = false;
let now = () => Date.now();
const fails = new Map<string, { count: number; since: number }>();

/** Tests only: a fake clock, and the file and failed tries forgotten. Call with nothing to undo. */
export function setAuthTestHooks(hooks?: { now?: () => number }): void {
  now = hooks?.now ?? (() => Date.now());
  current = null;
  broken = false;
  fails.clear();
}

// ---------- the file ----------

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Reads a hand-edited file. A bad user makes the whole file bad (null), so nobody gets in on half an account;
 * a bad session is only dropped, which at worst means logging in again. Exported for tests.
 */
export function parseAuthFile(raw: unknown): AuthFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.users) || !Array.isArray(r.sessions)) return null;
  const users: AuthUser[] = [];
  for (const u of r.users) {
    const x = (u && typeof u === 'object' ? u : {}) as Partial<Record<keyof AuthUser, unknown>>;
    if (!isText(x.id, 64) || !isText(x.name, NAME_MAX) || !isText(x.hash, 500) || !isTime(x.createdAt)) return null;
    users.push({ id: x.id, name: x.name, hash: x.hash, createdAt: x.createdAt });
  }
  const sessions: StoredSession[] = [];
  for (const s of r.sessions) {
    const x = (s && typeof s === 'object' ? s : {}) as Partial<Record<keyof StoredSession, unknown>>;
    if (typeof x.id === 'string' && /^[0-9a-f]{64}$/.test(x.id) && users.some((u) => u.id === x.userId) && isTime(x.createdAt) && isTime(x.seenAt)) {
      sessions.push({ id: x.id, userId: x.userId as string, createdAt: x.createdAt, seenAt: x.seenAt });
    }
  }
  return { users, sessions };
}

const expired = (s: StoredSession) => now() - Date.parse(s.seenAt) >= SESSION_DAYS * DAY;

/** Drops ended sessions, and keeps only the MAX_SESSIONS used last. */
function trim(sessions: StoredSession[]): StoredSession[] {
  return sessions
    .filter((s) => !expired(s))
    .sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt))
    .slice(0, MAX_SESSIONS);
}

function file(): AuthFile {
  if (!current) {
    try {
      const parsed = parseAuthFile(JSON.parse(fs.readFileSync(FILE, 'utf8')));
      if (!parsed) throw new Error('not an auth file');
      current = { users: parsed.users, sessions: trim(parsed.sessions) };
    } catch (e) {
      broken = (e as NodeJS.ErrnoException).code !== 'ENOENT';
      if (broken) console.warn('[hq] data/auth.json could not be read, so nobody can log in. Fix it, or delete it and restart HQ to set up the account again.');
      current = { users: [], sessions: [] };
    }
  }
  return current;
}

/** Never called while the file is broken: that would overwrite the file you are meant to fix. */
function save(next: AuthFile): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  current = next;
}

/** For writes that only tidy up (a refresh, an ended session): a failed write must not fail the request. */
function trySave(next: AuthFile): boolean {
  try {
    save(next);
    return true;
  } catch (e) {
    console.error('[hq] auth: could not save data/auth.json:', e instanceof Error ? e.name : 'error');
    return false;
  }
}

// ---------- passwords ----------

function derive(password: string, salt: Buffer, cost: { N: number; r: number; p: number }, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, len, { ...cost, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST, KEY_LEN);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** The cost is read from the hash, so a later change of COST leaves old passwords working. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // A hand-edited cost could make one login take minutes: only sane ones are tried (maxmem caps the rest).
  if (!Number.isInteger(N) || N < 2 ** 10 || N > 2 ** 17 || (N & (N - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 16) return false;
  const want = Buffer.from(parts[5], 'base64url');
  if (want.length < 16 || want.length > 64) return false;
  try {
    const got = await derive(password, Buffer.from(parts[4], 'base64url'), { N, r, p }, want.length);
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

export function nameProblem(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return 'Enter a name.';
  if (v.trim().length > NAME_MAX) return `Keep the name to ${NAME_MAX} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(v)) return 'The name has a character HQ cannot use.';
  return null;
}

/** Counted in characters, not UTF-16 units, so an emoji counts once. */
export function passwordProblem(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return 'Enter a password.';
  const n = [...v].length;
  if (n < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (n > PASSWORD_MAX) return `Keep the password to ${PASSWORD_MAX} characters.`;
  return null;
}

// ---------- users ----------

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** data/auth.json can't be read. Nobody gets in until you fix it, or delete it and restart HQ. */
export function authBroken(): boolean {
  file();
  return broken;
}

/** True while the file is broken too, so the setup screen never offers to replace an account it can't read. */
export function hasUser(): boolean {
  const f = file();
  return broken || f.users.length > 0;
}

/** Makes the first account. Null when one exists, including one made by another setup while this one hashed. */
export async function createOwner(name: string, password: string): Promise<AuthUser | null> {
  if (hasUser()) return null;
  const hash = await hashPassword(password);
  if (hasUser()) return null;
  const user: AuthUser = { id: `usr_${randomBytes(6).toString('hex')}`, name: name.trim(), hash, createdAt: new Date(now()).toISOString() };
  save({ users: [user], sessions: [] });
  return user;
}

/**
 * What an unknown name is checked against, so it costs the same one scrypt as a known one. Made up at start
 * without hashing: a lazy hash would make the first unknown name after a start cost two, and tell it apart.
 */
const DUMMY = ['scrypt', COST.N, COST.r, COST.p, randomBytes(16).toString('base64url'), randomBytes(KEY_LEN).toString('base64url')].join('$');

/**
 * The user, when the name and password match. An unknown name still costs one scrypt, so timing can't tell names
 * apart. A password change that lands while this checks wins: the password checked here no longer counts.
 */
export async function checkLogin(name: string, password: string): Promise<AuthUser | null> {
  const f = file();
  const user = broken ? undefined : f.users.find((u) => sameName(u.name, name));
  const hash = user?.hash ?? DUMMY;
  if (!(await verifyPassword(password, hash)) || !user) return null;
  const still = file().users.find((u) => u.id === user.id);
  return still && still.hash === hash ? still : null;
}

/**
 * How a password change went. `wrong`: the current password is wrong. `raced`: the password changed while this
 * one was checked and hashed (another browser changed it), so nothing was saved.
 */
export type PasswordChange = 'changed' | 'wrong' | 'raced';

/** Every other session of this user ends; the one sending this stays. */
export async function changePassword(userId: string, keepCode: string, currentPassword: string, next: string): Promise<PasswordChange> {
  const user = file().users.find((u) => u.id === userId);
  if (!user || broken || !(await verifyPassword(currentPassword, user.hash))) return 'wrong';
  const hash = await hashPassword(next);
  const f = file();
  // Saving now would undo a change that landed meanwhile, on the strength of the password it replaced.
  if (f.users.find((u) => u.id === userId)?.hash !== user.hash) return 'raced';
  const keep = digest(keepCode);
  save({ users: f.users.map((u) => (u.id === userId ? { ...u, hash } : u)), sessions: f.sessions.filter((s) => s.userId !== userId || s.id === keep) });
  return 'changed';
}

// ---------- sessions ----------

const digest = (code: string) => createHash('sha256').update(code).digest('hex');
/** 32 random bytes in base64url. Anything else is never looked up. */
const CODE = /^[A-Za-z0-9_-]{43}$/;

/** A new session for this user. The code goes in the cookie and is never stored. */
export function startSession(userId: string): string {
  const code = randomBytes(32).toString('base64url');
  const at = new Date(now()).toISOString();
  const f = file();
  save({ ...f, sessions: trim([{ id: digest(code), userId, createdAt: at, seenAt: at }, ...f.sessions]) });
  return code;
}

export function endSession(code: string | null): void {
  if (!code || !CODE.test(code) || broken) return;
  const f = file();
  const id = digest(code);
  if (f.sessions.some((s) => s.id === id)) trySave({ ...f, sessions: f.sessions.filter((s) => s.id !== id) });
}

/** The session's user, without changing anything. */
function lookup(code: string | null): { user: AuthUser; session: StoredSession } | null {
  if (!code || !CODE.test(code) || broken) return null;
  const id = digest(code);
  const f = file();
  const session = f.sessions.find((s) => s.id === id);
  if (!session || expired(session)) return null;
  const user = f.users.find((u) => u.id === session.userId);
  return user ? { user, session } : null;
}

/**
 * The session's user, refreshed when its last refresh was a day ago or more. `refreshed` says to send the cookie
 * again, so the browser's 30 days start over too. Only HQ's own page carries the cookie (SameSite=Strict), so a
 * GET from another site never refreshes anything.
 */
export function sessionFor(code: string | null): { user: AuthUser; refreshed: boolean } | null {
  const found = lookup(code);
  if (!found) return null;
  if (now() - Date.parse(found.session.seenAt) < REFRESH_MS) return { user: found.user, refreshed: false };
  const seenAt = new Date(now()).toISOString();
  const f = file();
  const refreshed = trySave({ ...f, sessions: f.sessions.map((s) => (s === found.session ? { ...s, seenAt } : s)) });
  return { user: found.user, refreshed };
}

// ---------- cookies ----------

/** One cookie's value from a Cookie header, or null. */
export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/** Secure only over HTTPS: HQ on this PC is plain HTTP, and a Secure cookie would never come back. */
export function sessionCookie(code: string, secure: boolean): string {
  return [`${COOKIE}=${code}`, 'Path=/', `Max-Age=${SESSION_DAYS * 86_400}`, 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])].join('; ');
}

export function clearedCookie(secure: boolean): string {
  return [`${COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])].join('; ');
}

export const sessionCode = (req: AuthRequest) => readCookie(req.get('cookie'), COOKIE);

// ---------- who may do what ----------

const LOOPBACK_IP = /^(127(\.\d{1,3}){3}|::1|::ffff:127(\.\d{1,3}){3})$/;

/**
 * The request comes from the PC HQ runs on: a loopback socket, a loopback Host (not an HQ_ALLOWED_HOSTS name), and
 * no proxy header. A reverse proxy on the same PC also connects from loopback; its forwarding headers give it away.
 */
export function setupAllowed(req: AuthRequest): boolean {
  return (
    LOOPBACK_IP.test(req.socket?.remoteAddress ?? '') &&
    hostAllowed(req.get('host'), new Set()) &&
    !req.get('x-forwarded-for') &&
    !req.get('forwarded') &&
    !req.get('x-real-ip')
  );
}

export function authStatus(req: AuthRequest): AuthStatus {
  const found = lookup(sessionCode(req));
  const has = hasUser();
  return { hasUser: has, signedIn: !!found, ...(found ? { name: found.user.name } : {}), canSetup: !has && setupAllowed(req) };
}

/** The address a request came from. Without trust proxy (Phase 5) this is the socket's, which is always loopback. */
export const clientAddress = (req: AuthRequest) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * Who a request's failed tries count against: this PC (setupAllowed), or apart from it, the address the request
 * came from. So guessing from elsewhere never locks you out on the PC itself. HQ listens on 127.0.0.1, so until it
 * runs behind HTTPS with real client addresses (Phase 5), every try from elsewhere shares one count. Exported for tests.
 */
export const tryKey = (req: AuthRequest) => (setupAllowed(req) ? 'local' : `remote:${clientAddress(req)}`);

/** Ms until this key (tryKey) may try again; 0 when it may now. */
export function loginWait(key: string): number {
  const f = fails.get(key);
  if (!f) return 0;
  const left = f.since + FAIL_WINDOW - now();
  if (left <= 0) {
    fails.delete(key);
    return 0;
  }
  return f.count >= FAIL_MAX ? left : 0;
}

/** Counted before the password is checked, so tries sent at once can't all slip in under the limit. */
export function noteTry(key: string): void {
  const f = fails.get(key);
  if (!f || now() - f.since >= FAIL_WINDOW) fails.set(key, { count: 1, since: now() });
  else f.count++;
  if (fails.size > 1000) for (const [k, v] of fails) if (now() - v.since >= FAIL_WINDOW) fails.delete(k);
}

export function clearTries(key: string): void {
  fails.delete(key);
}

/** Every /api call but /api/auth needs a good session. 401 means exactly that: no other route answers 401. */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const code = sessionCode(req);
  const found = sessionFor(code);
  if (!found || !code) {
    res.status(401).json({ error: 'Log in to HQ first.' });
    return;
  }
  if (found.refreshed) res.setHeader('Set-Cookie', sessionCookie(code, req.secure === true));
  res.locals.user = { id: found.user.id, name: found.user.name };
  next();
}
