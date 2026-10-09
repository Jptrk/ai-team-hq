import { Router, type Request, type Response } from 'express';
import type { AuthStatus } from '../shared/types';
import {
  authBroken,
  authStatus,
  changePassword,
  checkLogin,
  clearedCookie,
  clearTries,
  createOwner,
  endSession,
  hasUser,
  loginWait,
  nameProblem,
  noteTry,
  passwordProblem,
  sessionCode,
  sessionCookie,
  sessionFor,
  setupAllowed,
  startSession,
  tryKey,
  type AuthUser,
} from './auth';
import { jsonOnly } from './http';

/**
 * HQ's own login, at /api/auth. Mounted before the session check (server/index.ts), so these answer without one.
 * requestGuard still runs first: only this PC's names, and changes only from HQ's own page. See server/auth.ts.
 */
export const authRouter = Router();

const BROKEN = 'data/auth.json could not be read. Fix it, or delete it and restart HQ to set up the account again.';
const TAKEN = 'HQ already has an account. Log in instead.';

const bodyOf = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

function waitText(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  return `Too many tries. Try again in ${min} minute${min === 1 ? '' : 's'}.`;
}

/** Logged in from here on: a new session, and the answer carries its cookie. An older one in this browser ends. */
function signIn(req: Request, res: Response, user: AuthUser, status = 200): void {
  endSession(sessionCode(req));
  res.setHeader('Set-Cookie', sessionCookie(startSession(user.id), req.secure === true));
  const out: AuthStatus = { hasUser: true, signedIn: true, name: user.name, canSetup: false };
  res.status(status).json(out);
}

/** Is there an account, and is this browser logged in. Changes nothing. */
authRouter.get('/status', (req, res) => {
  res.json(authStatus(req));
});

/** The first account: `{ name, password }`. Only while there is none, and only from the PC HQ runs on. */
authRouter.post('/setup', jsonOnly, async (req, res) => {
  if (authBroken()) return res.status(503).json({ error: BROKEN });
  if (hasUser()) return res.status(409).json({ error: TAKEN });
  if (!setupAllowed(req)) return res.status(403).json({ error: 'Set up HQ from the PC it runs on.' });
  const b = bodyOf(req);
  const problem = nameProblem(b.name) ?? passwordProblem(b.password);
  if (problem) return res.status(400).json({ error: problem });
  const user = await createOwner(b.name as string, b.password as string);
  if (!user) return res.status(409).json({ error: TAKEN });
  signIn(req, res, user, 201);
});

/** `{ name, password }`. A wrong name and a wrong password get the same answer. */
authRouter.post('/login', jsonOnly, async (req, res) => {
  if (authBroken()) return res.status(503).json({ error: BROKEN });
  const key = tryKey(req);
  const wait = loginWait(key);
  if (wait > 0) return res.status(429).json({ error: waitText(wait) });
  const b = bodyOf(req);
  if (typeof b.name !== 'string' || typeof b.password !== 'string' || !b.name.trim() || !b.password) {
    return res.status(400).json({ error: 'Enter your name and password.' });
  }
  noteTry(key);
  const user = await checkLogin(b.name, b.password);
  if (!user) return res.status(401).json({ error: 'Wrong name or password.' });
  clearTries(key);
  signIn(req, res, user);
});

/** Ends this browser's session, if it has one. Always answers 200. */
authRouter.post('/logout', jsonOnly, (req, res) => {
  endSession(sessionCode(req));
  res.setHeader('Set-Cookie', clearedCookie(req.secure === true));
  res.json(authStatus(req));
});

/**
 * `{ current, next }`. A wrong current password is a 400, not a 401, so the page doesn't log you out over it.
 * A change from another browser that lands while this one is checked is a 409, and nothing is saved.
 * Your other sessions end; this one stays. Wrong tries count toward the same limit as logins.
 */
authRouter.post('/password', jsonOnly, async (req, res) => {
  const code = sessionCode(req);
  const found = sessionFor(code);
  if (!found || !code) return res.status(401).json({ error: 'Log in to HQ first.' });
  const key = tryKey(req);
  const wait = loginWait(key);
  if (wait > 0) return res.status(429).json({ error: waitText(wait) });
  const b = bodyOf(req);
  if (typeof b.current !== 'string' || !b.current) return res.status(400).json({ error: 'Enter your current password.' });
  const problem = passwordProblem(b.next);
  if (problem) return res.status(400).json({ error: problem });
  noteTry(key);
  const done = await changePassword(found.user.id, code, b.current, b.next as string);
  if (done === 'wrong') return res.status(400).json({ error: 'Your current password is wrong.' });
  if (done === 'raced') return res.status(409).json({ error: 'Your password changed meanwhile. Try again.' });
  clearTries(key);
  res.json({ ok: true });
});
