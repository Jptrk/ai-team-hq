/**
 * HQ's own login: the account, sessions, the cookie, failed tries, and who may set up.
 * Runs in a scratch folder: data/auth.json is written there, never in your real data/.
 *   npm run test:auth
 */
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthStatus } from '../shared/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-auth-'));
process.chdir(root);
delete process.env.HQ_ALLOWED_HOSTS;
// A scratch copy's API port (README): its cookie must not be the real HQ's (4747).
process.env.PORT = '4757';

const auth = await import('./auth');
const { authRouter } = await import('./authRoutes');

const FILE = path.join(root, 'data', 'auth.json');
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'staple and a long new one';
const THIRD_PASSWORD = 'a third one, longer still';
const DAY = 86_400_000;

let clock = Date.parse('2026-10-10T08:00:00.000Z');
auth.setAuthTestHooks({ now: () => clock });

const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);

interface From {
  addr?: string;
  host?: string;
  cookie?: string;
  type?: string;
  headers?: Record<string, string>;
}

function reqOf(method: string, url: string, body: unknown, from: From = {}) {
  const headers: Record<string, string> = {
    'content-type': from.type ?? 'application/json',
    host: from.host ?? 'localhost:5174',
    ...(from.cookie ? { cookie: from.cookie } : {}),
    ...(from.headers ?? {}),
  };
  const addr = from.addr ?? '127.0.0.1';
  return { method, url, body, headers, query: {}, get: (h: string) => headers[h.toLowerCase()], socket: { remoteAddress: addr }, ip: addr, secure: false };
}

interface Answer {
  status: number;
  body: unknown;
  setCookie?: string;
}

/** Call /api/auth in-process, as the server does once it has parsed the JSON body. */
function call(method: string, url: string, body?: unknown, from?: From): Promise<Answer> {
  return new Promise((resolve, reject) => {
    let status = 200;
    let setCookie: string | undefined;
    const res = {
      locals: {},
      status(code: number) {
        status = code;
        return res;
      },
      json(out: unknown) {
        resolve({ status, body: out, setCookie });
        return res;
      },
      setHeader(name: string, value: unknown) {
        if (name.toLowerCase() === 'set-cookie') setCookie = String(value);
        return res;
      },
    };
    const handle = authRouter as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
    handle(reqOf(method, url, body, from), res, (err) => reject(err ?? new Error(`no route for ${method} ${url}`)));
  });
}

/** What requireSession does with this Cookie header. */
function guard(cookie?: string) {
  let status = 200;
  let passed = false;
  let setCookie: string | undefined;
  const res = {
    locals: {} as Record<string, unknown>,
    status(code: number) {
      status = code;
      return res;
    },
    json() {
      return res;
    },
    setHeader(_name: string, value: unknown) {
      setCookie = String(value);
      return res;
    },
  };
  auth.requireSession(reqOf('GET', '/projects', undefined, { cookie }) as never, res as never, () => {
    passed = true;
  });
  return { status, passed, setCookie, user: res.locals.user as { name: string } | undefined };
}

/** The Cookie header a browser sends back for a Set-Cookie. */
const cookieOf = (setCookie: string | undefined) => {
  assert.ok(setCookie, 'a cookie was set');
  return setCookie.split(';')[0];
};
const codeOf = (cookie: string) => cookie.split('=')[1];
const stored = () => JSON.parse(fs.readFileSync(FILE, 'utf8')) as { users: { name: string; hash: string }[]; sessions: { id: string; seenAt: string }[] };

/** A hash of `password` at another cost, as a hand edit or an older HQ might have left it. verifyPassword reads the cost from it. */
function hashAt(password: string, N: number, r: number, p: number): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Puts this hash in data/auth.json by hand, sessions and all, and has HQ read the file again. */
function storeHash(hash: string): void {
  const f = stored();
  f.users[0].hash = hash;
  fs.writeFileSync(FILE, JSON.stringify(f, null, 2));
  auth.setAuthTestHooks({ now: () => clock });
}

let setupCookie = '';
let loginCookie = '';

test('cookie: one value out of several, spaces and all; none is null', () => {
  assert.equal(auth.readCookie('a=1; hq_session=abc ;b=2', 'hq_session'), 'abc');
  assert.equal(auth.readCookie('hq_session=abc', 'hq_session'), 'abc');
  assert.equal(auth.readCookie('xhq_session=abc', 'hq_session'), null, 'the whole name must match');
  for (const h of [undefined, '', 'a=1', 'hq_session=', 'hq_session']) assert.equal(auth.readCookie(h, 'hq_session'), null, String(h));
});

test('cookie: named after the API port, so a scratch copy on another port keeps its own login', () => {
  assert.equal(auth.COOKIE, 'hq_session_4757');
  assert.ok(auth.sessionCookie('x'.repeat(43), false).startsWith('hq_session_4757=x'));
  assert.ok(auth.clearedCookie(false).startsWith('hq_session_4757=;'));
});

test('cookie: HttpOnly, SameSite=Strict, 30 days, the whole site; Secure only over HTTPS', () => {
  const c = auth.sessionCookie('x'.repeat(43), false);
  for (const part of ['HttpOnly', 'SameSite=Strict', `Max-Age=${30 * 86_400}`, 'Path=/']) assert.ok(c.includes(part), part);
  assert.ok(!c.includes('Secure'));
  assert.ok(auth.sessionCookie('x', true).endsWith('; Secure'));
  assert.ok(auth.clearedCookie(false).includes('Max-Age=0'));
});

test('password: the right one passes; a wrong one, a changed hash or a silly cost fails', async () => {
  const hash = await auth.hashPassword(PASSWORD);
  assert.match(hash, /^scrypt\$32768\$8\$3\$[\w-]{22}\$[\w-]{43}$/);
  assert.ok(!hash.includes(PASSWORD));
  assert.equal(await auth.verifyPassword(PASSWORD, hash), true);
  assert.equal(await auth.verifyPassword(`${PASSWORD} `, hash), false);
  const flipped = hash.slice(0, -2) + (hash.at(-2) === 'A' ? 'B' : 'A') + hash.at(-1);
  assert.equal(await auth.verifyPassword(PASSWORD, flipped), false, 'a changed key');
  assert.equal(await auth.verifyPassword(PASSWORD, hash.replace('$32768$', '$1048576$')), false, 'a cost that would take minutes');
  assert.equal(await auth.verifyPassword(PASSWORD, hash.replace('$32768$', '$30000$')), false, 'N must be a power of 2');
  for (const bad of ['', PASSWORD, 'scrypt$', `bcrypt${hash.slice(6)}`]) assert.equal(await auth.verifyPassword(PASSWORD, bad), false, bad);
  assert.notEqual(await auth.hashPassword(PASSWORD), hash, 'a new salt each time');
});

test('rules: a name and a password of 12 to 200 characters', () => {
  assert.equal(auth.nameProblem('Patrick'), null);
  for (const bad of ['', '   ', 3, null, 'x'.repeat(41), 'a\nb']) assert.ok(auth.nameProblem(bad), JSON.stringify(bad));
  assert.equal(auth.passwordProblem('x'.repeat(12)), null);
  assert.equal(auth.passwordProblem('x'.repeat(200)), null);
  assert.match(String(auth.passwordProblem('x'.repeat(11))), /at least 12/);
  assert.match(String(auth.passwordProblem('x'.repeat(201))), /200/);
  assert.match(String(auth.passwordProblem('🔑'.repeat(11))), /at least 12/, 'counted in characters');
  for (const bad of ['', undefined, 12345678901234]) assert.ok(auth.passwordProblem(bad), String(bad));
});

test('setupAllowed: only from this PC, by its own name, with no proxy in between', () => {
  const r = (from: From) => auth.setupAllowed(reqOf('POST', '/setup', {}, from));
  assert.equal(r({}), true);
  assert.equal(r({ addr: '::1', host: '[::1]:4747' }), true);
  assert.equal(r({ addr: '::ffff:127.0.0.1', host: '127.0.0.1:4747' }), true);
  assert.equal(r({ addr: '10.0.0.5' }), false, 'another PC');
  assert.equal(r({ addr: '::ffff:192.168.1.9' }), false);
  process.env.HQ_ALLOWED_HOSTS = 'hq.example.com';
  try {
    assert.equal(r({ host: 'hq.example.com' }), false, 'an allowed name is still not this PC');
  } finally {
    delete process.env.HQ_ALLOWED_HOSTS;
  }
  assert.equal(r({ headers: { 'x-forwarded-for': '203.0.113.7' } }), false, 'a proxy on this PC');
  assert.equal(r({ headers: { forwarded: 'for=203.0.113.7' } }), false);
  assert.equal(r({ headers: { 'x-real-ip': '203.0.113.7' } }), false);
});

test('status: no account yet; setup is offered on this PC only; reading writes nothing', async () => {
  const local = await call('GET', '/status');
  assert.equal(local.status, 200);
  assert.deepEqual(local.body, { hasUser: false, signedIn: false, canSetup: true } satisfies AuthStatus);
  const away = await call('GET', '/status', undefined, { addr: '10.0.0.5' });
  assert.equal((away.body as AuthStatus).canSetup, false);
  assert.equal(fs.existsSync(FILE), false);
});

test('setup: refused from another PC, with a short password, a bad name or not as JSON; nothing written', async () => {
  assert.equal((await call('POST', '/setup', { name: 'Patrick', password: PASSWORD }, { addr: '10.0.0.5' })).status, 403);
  assert.equal((await call('POST', '/setup', { name: 'Patrick', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/setup', { name: '', password: PASSWORD })).status, 400);
  assert.equal((await call('POST', '/setup', [])).status, 400);
  assert.equal((await call('POST', '/setup', { name: 'Patrick', password: PASSWORD }, { type: 'text/plain' })).status, 415);
  assert.equal(fs.existsSync(FILE), false);
});

test('setup: two at once make one account; it is logged in; then setup is closed', async () => {
  const [a, b] = await Promise.all([
    call('POST', '/setup', { name: 'Patrick', password: PASSWORD }),
    call('POST', '/setup', { name: 'Mallory', password: 'another long password' }),
  ]);
  const won = a.status === 201 ? a : b;
  const lost = won === a ? b : a;
  assert.equal(won.status, 201);
  assert.equal(lost.status, 409);
  assert.match(String((lost.body as { error: string }).error), /already has an account/);
  assert.equal(lost.setCookie, undefined);
  assert.equal((won.body as AuthStatus).signedIn, true);
  setupCookie = cookieOf(won.setCookie);

  const f = stored();
  assert.equal(f.users.length, 1);
  assert.equal(f.users[0].name, (won.body as AuthStatus).name);
  assert.equal(f.sessions.length, 1);
  assert.equal(fs.existsSync(`${FILE}.tmp`), false, 'no temp file left behind');

  const again = await call('POST', '/setup', { name: 'Patrick', password: PASSWORD });
  assert.equal(again.status, 409);
  const status = (await call('GET', '/status', undefined, { cookie: setupCookie })).body as AuthStatus;
  assert.equal(status.hasUser, true);
  assert.equal(status.signedIn, true);
  assert.equal(status.canSetup, false);
  // Whoever won, log in as Patrick from here on.
  if (status.name !== 'Patrick') {
    fs.rmSync(FILE);
    auth.setAuthTestHooks({ now: () => clock });
    const mine = await call('POST', '/setup', { name: 'Patrick', password: PASSWORD });
    assert.equal(mine.status, 201);
    setupCookie = cookieOf(mine.setCookie);
  }
});

test('file: only hashes are kept, never a password or a session code', () => {
  const raw = fs.readFileSync(FILE, 'utf8');
  assert.ok(!raw.includes(PASSWORD));
  assert.ok(!raw.includes(codeOf(setupCookie)));
  assert.match(stored().sessions[0].id, /^[0-9a-f]{64}$/);
});

test('session: the cookie lets a request through; none, junk or a made-up code gets 401', () => {
  const ok = guard(setupCookie);
  assert.equal(ok.passed, true);
  assert.equal(ok.user?.name, 'Patrick');
  assert.equal(ok.setCookie, undefined, 'nothing to refresh yet');
  for (const bad of [undefined, `${auth.COOKIE}=junk`, `${auth.COOKIE}=${'A'.repeat(43)}`, 'other=1']) {
    const g = guard(bad);
    assert.equal(g.passed, false, String(bad));
    assert.equal(g.status, 401);
  }
  // The same code under the real HQ's cookie, or the old unported name, is another HQ's business.
  for (const other of ['hq_session_4747', 'hq_session']) assert.equal(guard(`${other}=${codeOf(setupCookie)}`).status, 401, other);
  assert.equal(guard(`hq_session_4747=junk; ${setupCookie}`).passed, true, 'both cookies sent: this port reads its own');
});

test('login: a wrong password and an unknown name get the same answer; a good one is a new session', async () => {
  const from = { addr: '127.0.0.2' };
  const wrong = await call('POST', '/login', { name: 'Patrick', password: 'not the password' }, from);
  const nobody = await call('POST', '/login', { name: 'Nobody', password: PASSWORD }, from);
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, nobody.body);
  assert.equal(nobody.status, 401);
  assert.equal(wrong.setCookie, undefined);

  const good = await call('POST', '/login', { name: '  patrick ', password: PASSWORD }, from);
  assert.equal(good.status, 200, 'the name is matched without case or spaces');
  assert.deepEqual(good.body, { hasUser: true, signedIn: true, name: 'Patrick', canSetup: false } satisfies AuthStatus);
  loginCookie = cookieOf(good.setCookie);
  assert.notEqual(loginCookie, setupCookie);
  assert.equal(guard(loginCookie).passed, true);
  assert.equal(guard(setupCookie).passed, true, 'the other browser stays logged in');
});

test('login: a bad body is a 400 and is not counted as a try', async () => {
  const from = { addr: '127.0.0.3' };
  for (const body of [{}, { name: 'Patrick' }, { password: PASSWORD }, { name: ' ', password: PASSWORD }, [], { name: 1, password: 2 }]) {
    assert.equal((await call('POST', '/login', body, from)).status, 400, JSON.stringify(body));
  }
  assert.equal(auth.loginWait('local'), 0);
  assert.equal((await call('POST', '/login', { name: 'Patrick', password: PASSWORD }, { ...from, type: 'text/plain' })).status, 415);
});

test('login: after 5 tries in 15 minutes the 6th waits, even with the right password; then it works', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/login', { name: 'Patrick', password: `wrong guess ${i}` })).status, 401);
  const blocked = await call('POST', '/login', { name: 'Patrick', password: PASSWORD });
  assert.equal(blocked.status, 429);
  assert.match(String((blocked.body as { error: string }).error), /Try again in 15 minutes/);
  assert.equal(blocked.setCookie, undefined);
  assert.ok(auth.loginWait('local') > 0);
  clock += 15 * 60_000;
  const after = await call('POST', '/login', { name: 'Patrick', password: PASSWORD });
  assert.equal(after.status, 200);
  assert.equal(auth.loginWait('local'), 0, 'a good login clears the count');
});

test('login: tries from this PC and from elsewhere are counted apart; all tries from elsewhere share one count', async () => {
  const wrong = (i: number, from?: From) => call('POST', '/login', { name: 'Patrick', password: `wrong guess ${i}` }, from);
  const right = (from?: From) => call('POST', '/login', { name: 'Patrick', password: PASSWORD }, from);
  // From elsewhere: through a reverse proxy on this PC, or by a name from HQ_ALLOWED_HOSTS. Both reach HQ from loopback.
  const proxied: From = { headers: { 'x-forwarded-for': '203.0.113.7' } };
  const named: From = { host: 'hq.example.com:4747' };
  assert.equal(auth.tryKey(reqOf('POST', '/login', {})), 'local');
  assert.equal(auth.tryKey(reqOf('POST', '/login', {}, proxied)), 'remote:127.0.0.1');
  assert.equal(auth.tryKey(reqOf('POST', '/login', {}, named)), 'remote:127.0.0.1');
  assert.equal(auth.tryKey(reqOf('POST', '/login', {}, { addr: '10.0.0.5' })), 'remote:10.0.0.5');

  for (let i = 0; i < 3; i++) assert.equal((await wrong(i, proxied)).status, 401);
  for (let i = 3; i < 5; i++) assert.equal((await wrong(i, named)).status, 401);
  assert.equal((await right(proxied)).status, 429, 'elsewhere waits');
  assert.equal((await right(named)).status, 429, 'one count for every try from elsewhere');
  assert.equal((await right()).status, 200, 'guessing from elsewhere does not lock you out on this PC');

  clock += 15 * 60_000;
  for (let i = 0; i < 5; i++) assert.equal((await wrong(i)).status, 401);
  assert.equal((await right()).status, 429, 'this PC waits');
  assert.equal((await right(named)).status, 200, 'elsewhere does not');
  clock += 15 * 60_000;
  assert.equal((await right()).status, 200);
});

test('session: refreshed at most once a day, cookie and all; it ends 30 days after its last use', () => {
  const login = stored().sessions.length;
  clock += 2 * 60 * 60_000;
  assert.equal(guard(loginCookie).setCookie, undefined, 'two hours on: no write');
  const before = fs.readFileSync(FILE, 'utf8');
  guard(loginCookie);
  assert.equal(fs.readFileSync(FILE, 'utf8'), before, 'polling writes nothing');

  clock += DAY;
  const refreshed = guard(loginCookie);
  assert.equal(refreshed.passed, true);
  assert.ok(refreshed.setCookie?.includes(`Max-Age=${30 * 86_400}`), 'the browser gets 30 more days too');
  assert.notEqual(fs.readFileSync(FILE, 'utf8'), before);
  assert.equal(stored().sessions.length, login);

  clock += 29 * DAY;
  assert.equal(guard(loginCookie).passed, true, '29 days after the last use: still good');
  clock += 30 * DAY;
  assert.equal(guard(loginCookie).status, 401, '30 days unused: ended');
  assert.equal(guard(setupCookie).status, 401);
});

test('session: at most 20 are kept, the ones used last', async () => {
  loginCookie = cookieOf((await call('POST', '/login', { name: 'Patrick', password: PASSWORD }, { addr: '127.0.0.6' })).setCookie);
  const userId = (JSON.parse(fs.readFileSync(FILE, 'utf8')) as { users: { id: string }[] }).users[0].id;
  for (let i = 0; i < 25; i++) {
    clock += 1000;
    auth.startSession(userId);
  }
  assert.equal(stored().sessions.length, 20);
  assert.equal(guard(loginCookie).status, 401, 'the oldest went first');
  loginCookie = cookieOf((await call('POST', '/login', { name: 'Patrick', password: PASSWORD }, { addr: '127.0.0.6' })).setCookie);
  setupCookie = cookieOf((await call('POST', '/login', { name: 'Patrick', password: PASSWORD }, { addr: '127.0.0.6' })).setCookie);
});

test('file: sessions survive a restart (the file read again)', () => {
  auth.setAuthTestHooks({ now: () => clock });
  assert.equal(guard(loginCookie).passed, true);
  assert.equal(guard(setupCookie).passed, true);
});

test('logout: ends this session only, and clears the cookie', async () => {
  const out = await call('POST', '/logout', {}, { cookie: setupCookie });
  assert.equal(out.status, 200);
  assert.equal((out.body as AuthStatus).signedIn, false);
  assert.ok(out.setCookie?.includes('Max-Age=0'));
  assert.equal(guard(setupCookie).status, 401);
  assert.equal(guard(loginCookie).passed, true);
  assert.equal((await call('POST', '/logout', {})).status, 200, 'no session is fine too');
});

test('password: needs a session; a wrong current one is a 400; a change ends the other sessions', async () => {
  const from = { addr: '127.0.0.7' };
  assert.equal((await call('POST', '/password', { current: PASSWORD, next: NEW_PASSWORD }, from)).status, 401);
  const wrong = await call('POST', '/password', { current: 'not the password', next: NEW_PASSWORD }, { ...from, cookie: loginCookie });
  assert.equal(wrong.status, 400, 'not 401: the page must not log you out over it');
  assert.match(String((wrong.body as { error: string }).error), /current password is wrong/);
  assert.equal((await call('POST', '/password', { current: PASSWORD, next: 'short' }, { ...from, cookie: loginCookie })).status, 400);
  assert.equal((await call('POST', '/password', { next: NEW_PASSWORD }, { ...from, cookie: loginCookie })).status, 400);

  const other = cookieOf((await call('POST', '/login', { name: 'Patrick', password: PASSWORD }, { addr: '127.0.0.8' })).setCookie);
  const changed = await call('POST', '/password', { current: PASSWORD, next: NEW_PASSWORD }, { ...from, cookie: loginCookie });
  assert.equal(changed.status, 200);
  assert.equal(guard(loginCookie).passed, true, 'the browser that changed it stays in');
  assert.equal(guard(other).status, 401, 'every other session ends');
  assert.equal((await call('POST', '/login', { name: 'Patrick', password: PASSWORD }, { addr: '127.0.0.8' })).status, 401);
  assert.equal((await call('POST', '/login', { name: 'Patrick', password: NEW_PASSWORD }, { addr: '127.0.0.8' })).status, 200);
});

test('login: the old password, still being checked when a password change lands, does not get in', async () => {
  // The login reads a slow hash of the current password (p=16, about 5 times HQ's own cost)...
  storeHash(hashAt(NEW_PASSWORD, 2 ** 15, 8, 16));
  const order: string[] = [];
  const login = call('POST', '/login', { name: 'Patrick', password: NEW_PASSWORD }).then((a) => (order.push('login'), a));
  // ...then the same password is stored as a quick hash, so the change below is through its own check at once and
  // lands while the login is still checking the old one.
  storeHash(hashAt(NEW_PASSWORD, 2 ** 10, 1, 1));
  const change = call('POST', '/password', { current: NEW_PASSWORD, next: THIRD_PASSWORD }, { cookie: loginCookie }).then((a) => (order.push('change'), a));
  assert.equal((await change).status, 200);
  const late = await login;
  assert.deepEqual(order, ['change', 'login'], 'the change landed while the login was still checking');
  assert.equal(late.status, 401, 'the old password no longer counts');
  assert.equal(late.setCookie, undefined, 'no session came of it');
  assert.equal(stored().sessions.length, 1, 'only the browser that changed it');
  assert.equal(guard(loginCookie).passed, true);
  assert.equal((await call('POST', '/login', { name: 'Patrick', password: THIRD_PASSWORD })).status, 200);
});

test('password: two changes at once from two browsers: one is saved, the other is a 409 and saves nothing', async () => {
  const other = cookieOf((await call('POST', '/login', { name: 'Patrick', password: THIRD_PASSWORD })).setCookie);
  const nexts = ['the first of two at once', 'the second of two at once'];
  const [a, b] = await Promise.all([
    call('POST', '/password', { current: THIRD_PASSWORD, next: nexts[0] }, { cookie: loginCookie }),
    call('POST', '/password', { current: THIRD_PASSWORD, next: nexts[1] }, { cookie: other }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const lost = a.status === 409 ? a : b;
  assert.match(String((lost.body as { error: string }).error), /changed meanwhile/);
  const [won, lostNext, wonCookie] = a.status === 200 ? [nexts[0], nexts[1], loginCookie] : [nexts[1], nexts[0], other];
  assert.equal(guard(wonCookie).passed, true, 'the browser whose change was saved stays in');
  assert.equal((await call('POST', '/login', { name: 'Patrick', password: lostNext })).status, 401, 'the other change was not saved');
  loginCookie = cookieOf((await call('POST', '/login', { name: 'Patrick', password: won })).setCookie);
});

test('file: a hand edit keeps good users; a bad user spoils the file; a bad session is dropped', () => {
  const user = { id: 'usr_1', name: 'Patrick', hash: 'scrypt$x', createdAt: '2026-10-10T08:00:00.000Z' };
  const session = { id: 'a'.repeat(64), userId: 'usr_1', createdAt: user.createdAt, seenAt: user.createdAt };
  assert.deepEqual(auth.parseAuthFile({ users: [user], sessions: [session] }), { users: [user], sessions: [session] });
  for (const bad of [null, [], 'x', { users: [] }, { users: [{ ...user, name: '' }], sessions: [] }, { users: [{ ...user, hash: 3 }], sessions: [] }]) {
    assert.equal(auth.parseAuthFile(bad), null, JSON.stringify(bad));
  }
  for (const s of [{ ...session, id: 'short' }, { ...session, userId: 'usr_2' }, { ...session, seenAt: 'soon' }, null]) {
    assert.deepEqual(auth.parseAuthFile({ users: [user], sessions: [s] })?.sessions, [], JSON.stringify(s));
  }
});

test('file: a broken file lets nobody in, offers no setup, and is left as it is', async () => {
  fs.writeFileSync(FILE, '{ not json');
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    auth.setAuthTestHooks({ now: () => clock });
    assert.deepEqual((await call('GET', '/status', undefined, { cookie: loginCookie })).body, { hasUser: true, signedIn: false, canSetup: false } satisfies AuthStatus);
    assert.equal(guard(loginCookie).status, 401);
    assert.equal((await call('POST', '/setup', { name: 'Mallory', password: PASSWORD })).status, 503);
    assert.equal((await call('POST', '/login', { name: 'Patrick', password: NEW_PASSWORD })).status, 503);
    await call('POST', '/logout', {}, { cookie: loginCookie });
    assert.equal(fs.readFileSync(FILE, 'utf8'), '{ not json');
  } finally {
    console.warn = warn;
  }
});

test('routes: only the login answers 401, so the page can read every 401 as "log in"', () => {
  for (const rel of fs.readdirSync(here, { recursive: true, encoding: 'utf8' })) {
    const name = path.basename(rel);
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || rel === 'auth.ts' || rel === 'authRoutes.ts') continue;
    assert.ok(!/status\(\s*401\s*\)/.test(fs.readFileSync(path.join(here, rel), 'utf8')), `${rel} answers 401`);
  }
});

let passed = 0;
let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
}
process.chdir(os.tmpdir());
try {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
} catch (e) {
  console.warn(`could not remove ${root}: ${e instanceof Error ? e.message : String(e)}`);
}
assert.equal(failed, 0, `${failed} auth case(s) failed`);
console.log(`\nall ${passed} auth cases pass`);
