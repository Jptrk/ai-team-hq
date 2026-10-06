/**
 * Signing in to your Claude account from HQ (a Claude subscription, not an API key).
 * Claude Code is faked: a stand-in session for the SDK's sign-in calls and a stand-in for `claude auth`.
 * Runs in a scratch folder with its own CLAUDE_CONFIG_DIR: your real login and data/ are never touched.
 *   npm run test:account
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AccountResponse, Meta } from '../shared/types';
import type { CliResult } from './mcpCli';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-account-'));
const configDir = path.join(root, 'claude-config');
fs.mkdirSync(configDir, { recursive: true });
process.chdir(root);
process.env.CLAUDE_CONFIG_DIR = configDir;
delete process.env.HQ_RUNNER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const acct = await import('./claudeAuth');
const { settings } = await import('./settings');
const { router } = await import('./routes');
const runner = await import('./runner/index');
const { safeClaudeUrl, planLabel } = await import('../shared/account');
// As at boot: no key, no login and no yes, so HQ picks sim, and keeps it while it runs.
assert.equal(runner.runnerName(), 'sim');

const CREDS = path.join(configDir, '.credentials.json');
const TOKEN = 'sk-ant-oat01-secret-access-token-value';
const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = <T>() => new Promise<T>(() => undefined);
const until = async (what: string, cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
};

/** Call the API in-process, as the server does once it has parsed the JSON body. HQ's own page always sends JSON. */
function api(method: string, url: string, body?: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      locals: {},
      status(code: number) {
        status = code;
        return res;
      },
      json(out: unknown) {
        resolve({ status, body: out });
        return res;
      },
    };
    const [pathPart, qs = ''] = url.split('?');
    const req = { method, url: pathPart, body: body ?? {}, headers, query: Object.fromEntries(new URLSearchParams(qs)), get: (h: string) => headers[h.toLowerCase()] };
    const handle = router as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
    handle(req, res, (err) => reject(err ?? new Error(`no route for ${method} ${url}`)));
  });
}

// ---------- fakes ----------

const AUTO = 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback&state=abc';
const MANUAL = 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=abc';

/** Claude Code's `claude auth`: who is signed in follows `cliState`. While `hold` is set, `auth status` waits for it. */
const cliState = { loggedIn: false, logoutCode: 0 as number | null, calls: [] as string[][], hold: null as Promise<void> | null };
const statusCalls = () => cliState.calls.filter((a) => a.join(' ') === 'auth status --json').length;
/** Keep `auth status` from answering until the function this returns is called. */
function holdStatus(): () => void {
  let release: () => void = () => undefined;
  cliState.hold = new Promise<void>((r) => (release = r));
  return () => {
    cliState.hold = null;
    release();
  };
}
const signedInJson = () =>
  JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'you@example.com', orgId: 'org-uuid', orgName: 'Your Org', subscriptionType: 'max', accessToken: TOKEN });
const fakeCli = async (args: string[]): Promise<CliResult> => {
  cliState.calls.push(args);
  if (args[0] === 'auth' && args[1] === 'status' && cliState.hold) await cliState.hold;
  if (args[0] === 'auth' && args[1] === 'status') return { code: 0, out: cliState.loggedIn ? signedInJson() : JSON.stringify({ loggedIn: false, authMethod: 'none' }), err: '', timedOut: false };
  if (args[0] === 'auth' && args[1] === 'logout') {
    if (cliState.logoutCode === 0) cliState.loggedIn = false;
    return { code: cliState.logoutCode, out: '', err: cliState.logoutCode === 0 ? '' : 'Failed to log out.', timedOut: false };
  }
  return { code: 1, out: '', err: 'unknown', timedOut: false };
};

/** The SDK session's three sign-in calls. finish() ends the wait the way Claude Code does once the browser came back. */
function fakeSession(script: { urls?: () => Promise<unknown>; callback?: (code: string, state: string) => Promise<unknown>; noSignIn?: boolean } = {}) {
  const seen = { closed: 0, asked: 0, codes: [] as [string, string][] };
  let finish: (v?: unknown) => void = () => undefined;
  let refuse: (e: Error) => void = () => undefined;
  const done = new Promise((resolve, reject) => {
    finish = resolve;
    refuse = reject;
  });
  done.catch(() => undefined);
  const q = script.noSignIn
    ? {}
    : {
        claudeAuthenticate: (claudeAi: boolean) => {
          seen.asked++;
          assert.equal(claudeAi, true, 'always the Claude subscription sign-in, never the Console (API) one');
          return script.urls ? script.urls() : Promise.resolve({ manualUrl: MANUAL, automaticUrl: AUTO });
        },
        claudeOAuthWaitForCompletion: () => done,
        claudeOAuthCallback: (code: string, state: string) => {
          seen.codes.push([code, state]);
          if (script.callback) return script.callback(code, state);
          cliState.loggedIn = true;
          finish({ account: { email: 'you@example.com' } });
          return done;
        },
      };
  const session = { q: q as unknown as Query, close: async () => void seen.closed++ };
  return {
    open: () => session,
    seen,
    finish: () => {
      cliState.loggedIn = true;
      finish({ account: { email: 'you@example.com' } });
    },
    /** The wait ends, but Claude Code saved no login. */
    endWithoutLogin: () => finish({}),
    refuse,
  };
}

function reset(): void {
  acct.cancelAccountLogin();
  cliState.loggedIn = false;
  cliState.logoutCode = 0;
  cliState.calls = [];
  cliState.hold = null;
  fs.rmSync(CREDS, { force: true });
  acct.useClaudeLogin(false);
}

// ---------- rules ----------

test('status: keeps the email, organization and plan, never a token or ids', () => {
  assert.deepEqual(acct.parseAuthStatus(signedInJson()), { loggedIn: true, method: 'claude.ai', email: 'you@example.com', org: 'Your Org', plan: 'max' });
  assert.deepEqual(acct.parseAuthStatus(JSON.stringify({ loggedIn: false, email: 'old@example.com' })), { loggedIn: false });
  for (const junk of ['', 'not json', '[]', 'null', '{"email":"x"}', '{"loggedIn":"yes"}']) assert.equal(acct.parseAuthStatus(junk), null, junk);
  assert.equal(acct.parseAuthStatus(JSON.stringify({ loggedIn: true, email: 'x'.repeat(500) }))?.email?.length, 200);
});

test('credentials: only a Claude login counts, not a file holding just MCP sign-ins', () => {
  assert.equal(acct.credentialsHaveLogin(CREDS), false, 'no file');
  fs.writeFileSync(CREDS, JSON.stringify({ mcpOAuth: { server: { accessToken: 'x' } } }));
  assert.equal(acct.credentialsHaveLogin(CREDS), false, 'MCP sign-ins only');
  fs.writeFileSync(CREDS, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } }));
  assert.equal(acct.credentialsHaveLogin(CREDS), false, 'empty tokens');
  fs.writeFileSync(CREDS, '{ broken');
  assert.equal(acct.credentialsHaveLogin(CREDS), false, 'bad JSON');
  fs.writeFileSync(CREDS, JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }));
  assert.equal(acct.credentialsHaveLogin(CREDS), true);
  fs.rmSync(CREDS);
});

test('pages: only https pages on claude.com, claude.ai or anthropic.com are shown', () => {
  for (const ok of [AUTO, 'https://claude.ai/oauth/authorize', 'https://platform.claude.com/x', 'https://console.anthropic.com/x']) assert.equal(safeClaudeUrl(ok), new URL(ok).href, ok);
  for (const bad of ['http://claude.com/x', 'https://claude.com.evil.example/x', 'https://evilclaude.com/x', 'https://evil.example/?u=claude.com', 'javascript:alert(1)', 'https://user:pw@claude.com/', '', 42, null])
    assert.equal(safeClaudeUrl(bad), null, String(bad));
  assert.equal(planLabel('max'), 'Max');
  assert.equal(planLabel('team'), 'Team');
  assert.equal(planLabel(undefined), null);
});

test('code: the sign-in page shows code#state; anything else gets a sentence', () => {
  assert.deepEqual(acct.parseAuthCode('  abc-DEF_123.x~#st4te  '), { code: 'abc-DEF_123.x~', state: 'st4te' });
  for (const bad of ['', '   ', 'abc', 'abc#', '#state', 'a#b#c', 'a b#c', 'a#<script>', 'x'.repeat(4001), 42, undefined]) assert.equal(typeof acct.parseAuthCode(bad), 'string', String(bad));
});

// ---------- signing in ----------

test('sign-in: starting, then the two pages, then signed in: desks may run on it and the session closes', async () => {
  reset();
  const f = fakeSession();
  acct.setAccountTestHooks({ open: f.open, cli: fakeCli, loginMs: 5000 });
  acct.startAccountLogin();
  assert.equal(acct.accountLogin()?.state, 'starting');
  await until('waiting', () => acct.accountLogin()?.state === 'waiting');
  assert.equal(acct.accountLogin()?.authUrl, AUTO);
  assert.equal(acct.accountLogin()?.manualUrl, MANUAL);
  assert.equal(settings().claudeLogin, undefined, 'nothing saved before the sign-in finishes');
  f.finish();
  await until('signed in', () => acct.accountLogin() === undefined);
  await until('closed', () => f.seen.closed > 0);
  assert.ok(settings().claudeLogin, 'signing in from HQ says desks may run on the login');
  assert.equal(acct.accountCached().account?.email, 'you@example.com');
  assert.equal(acct.hasClaudeLogin(), true);
  assert.ok(cliState.calls.some((a) => a.join(' ') === 'auth status --json'));
  const body = (await api('GET', '/account')).body as AccountResponse;
  assert.ok(body.signedInAt && body.signedInAt === acct.lastSignIn(), 'the page learns a sign-in just worked');
  assert.equal(body.envToken, false);
});

test('sign-in: a poll during the check after it never sees the sign-in gone and no login', async () => {
  reset();
  const f = fakeSession();
  acct.setAccountTestHooks({ open: f.open, cli: fakeCli, loginMs: 5000 });
  // A fresh answer from before says signed out: the cache the poll must not trust.
  assert.equal(((await api('GET', '/account')).body as AccountResponse).account?.loggedIn, false);
  acct.startAccountLogin();
  await until('waiting', () => acct.accountLogin()?.state === 'waiting');
  const release = holdStatus();
  const before = statusCalls();
  f.finish();
  await until('the check after signing in', () => statusCalls() > before);
  const seen: AccountResponse[] = [];
  const polls = Promise.all([0, 1, 2, 3].map(async () => seen.push((await api('GET', '/account')).body as AccountResponse)));
  await sleep(50);
  assert.equal(seen.length, 0, 'polls wait for the check running now instead of the cached answer');
  release();
  await polls;
  await until('signed in', () => acct.accountLogin() === undefined);
  seen.push((await api('GET', '/account')).body as AccountResponse);
  for (const b of seen) assert.ok(b.login || b.account?.loggedIn, `a poll saw ${JSON.stringify(b)}`);
  assert.equal(seen.at(-1)?.account?.loggedIn, true);
  assert.ok(seen.at(-1)?.signedInAt);
  assert.equal(statusCalls(), before + 1, 'the polls shared the check');
});

test('sign-in: a wait that ends with no login saved fails, and saves no yes', async () => {
  reset();
  const f = fakeSession();
  acct.setAccountTestHooks({ open: f.open, cli: fakeCli, loginMs: 5000 });
  acct.startAccountLogin();
  await until('waiting', () => acct.accountLogin()?.state === 'waiting');
  f.endWithoutLogin();
  await until('failed', () => acct.accountLogin()?.state === 'failed');
  assert.match(acct.accountLogin()?.error ?? '', /saved no login/);
  assert.equal(settings().claudeLogin, undefined);
  assert.equal(acct.lastSignIn(), undefined, 'no "Signed in as" for it');
  await until('closed', () => f.seen.closed > 0);
  // Dismiss: the failed box goes away.
  assert.equal((await api('DELETE', '/account/login')).status, 200);
  assert.equal(acct.accountLogin(), undefined);
});

test('sign-in: no page within a minute ends the sign-in, long before the ten minutes', async () => {
  reset();
  const f = fakeSession({ urls: never });
  acct.setAccountTestHooks({ open: f.open, cli: fakeCli, loginMs: 5000, pageMs: 100 });
  acct.startAccountLogin();
  await until('failed', () => acct.accountLogin()?.state === 'failed', 1500);
  assert.match(acct.accountLogin()?.error ?? '', /didn't give a sign-in page in time/);
  await until('closed', () => f.seen.closed > 0);
});

test('sign-in: one at a time', async () => {
  reset();
  const f = fakeSession();
  acct.setAccountTestHooks({ open: f.open, cli: fakeCli, loginMs: 5000 });
  acct.startAccountLogin();
  assert.throws(() => acct.startAccountLogin(), (e: unknown) => e instanceof acct.AccountError && e.status === 409);
  const r = await api('POST', '/account/login');
  assert.equal(r.status, 409);
  acct.cancelAccountLogin();
  await until('closed', () => f.seen.closed > 0);
});

test('sign-in: cancel while asking for the page and while waiting saves nothing', async () => {
  for (const phase of ['asking', 'waiting'] as const) {
    reset();
    const f = fakeSession(phase === 'asking' ? { urls: never } : {});
    acct.setAccountTestHooks({ open: f.open, cli: fakeCli, loginMs: 5000 });
    acct.startAccountLogin();
    if (phase === 'asking') await until('asked', () => f.seen.asked > 0);
    else await until('waiting', () => acct.accountLogin()?.state === 'waiting');
    assert.equal(acct.cancelAccountLogin(), true, phase);
    assert.equal(acct.accountLogin(), undefined, phase);
    await until(`${phase} closed`, () => f.seen.closed > 0);
    f.finish();
    await sleep(50);
    assert.equal(settings().claudeLogin, undefined, `${phase}: a cancelled sign-in saves nothing`);
  }
  assert.equal(acct.cancelAccountLogin(), false, 'nothing left to cancel');
});

test('sign-in: no session, no sign-in call, bad pages, a refusal and a silent wait all end, and the next one can start', async () => {
  const end = async (label: string, open: () => ReturnType<ReturnType<typeof fakeSession>['open']>, ms = 3000) => {
    reset();
    acct.setAccountTestHooks({ open, cli: fakeCli, loginMs: 600 });
    acct.startAccountLogin();
    await until(label, () => acct.accountLogin()?.state === 'failed', ms);
    assert.equal(settings().claudeLogin, undefined, label);
    return acct.accountLogin()!;
  };
  const threw = await end('session fails to start', () => {
    throw new Error('spawn failed C:\\secret\\path');
  });
  assert.match(threw.error ?? '', /Could not start/);
  assert.ok(!threw.error?.includes('secret'));
  const old = await end('an SDK without the sign-in call', fakeSession({ noSignIn: true }).open);
  assert.match(old.error ?? '', /claude auth login/);
  const evil = await end('pages that are not Claude', fakeSession({ urls: async () => ({ automaticUrl: 'https://evil.example/login', manualUrl: 'javascript:alert(1)' }) }).open);
  assert.match(evil.error ?? '', /didn't get a Claude sign-in page/);
  assert.equal(evil.authUrl, undefined);
  const refusing = fakeSession();
  const refused = (async () => {
    await until('waiting', () => acct.accountLogin()?.state === 'waiting');
    refusing.refuse(new Error(`Token exchange failed: Bearer ${TOKEN}`));
  })();
  const r = await end('Claude refuses the sign-in', refusing.open);
  await refused;
  assert.ok(!r.error?.includes(TOKEN), r.error);
  const silent = await end('the wait never ends', fakeSession().open);
  assert.match(silent.error ?? '', /timed out/);
  // Not wedged: the next one starts.
  const f = fakeSession();
  acct.setAccountTestHooks({ open: f.open, cli: fakeCli, loginMs: 5000 });
  acct.startAccountLogin();
  assert.equal(acct.accountLogin()?.state, 'starting');
  acct.cancelAccountLogin();
});

test('code: the pasted code reaches Claude Code split in two, and the answer comes once signed in', async () => {
  reset();
  const f = fakeSession();
  acct.setAccountTestHooks({ open: f.open, cli: fakeCli, loginMs: 5000 });
  const none = await api('POST', '/account/login/code', { code: 'a#b' });
  assert.equal(none.status, 409, 'no sign-in waiting');
  acct.startAccountLogin();
  await until('waiting', () => acct.accountLogin()?.state === 'waiting');
  const bad = await api('POST', '/account/login/code', { code: 'no-hash' });
  assert.equal(bad.status, 400);
  assert.equal(acct.accountLogin()?.state, 'waiting', 'a code that is not one leaves the sign-in waiting');
  const ok = await api('POST', '/account/login/code', { code: ' the-code#the-state ' });
  assert.equal(ok.status, 200);
  assert.deepEqual(f.seen.codes, [['the-code', 'the-state']]);
  const body = ok.body as AccountResponse;
  assert.equal(body.login, undefined);
  assert.equal(body.account?.loggedIn, true);
  assert.equal(body.optedIn, true);
});

test('code: one Claude refuses comes back as a 400 without the code in it', async () => {
  reset();
  let f!: ReturnType<typeof fakeSession>;
  f = fakeSession({
    callback: async (code) => {
      const e = new Error(`Invalid code ${code}`);
      f.refuse(e);
      throw e;
    },
  });
  acct.setAccountTestHooks({ open: f.open, cli: fakeCli, loginMs: 5000 });
  acct.startAccountLogin();
  await until('waiting', () => acct.accountLogin()?.state === 'waiting');
  const r = await api('POST', '/account/login/code', { code: 'leakycode123#state' });
  assert.equal(r.status, 400);
  assert.ok(!(r.body as { error: string }).error.includes('leakycode123'), (r.body as { error: string }).error);
  await until('failed', () => acct.accountLogin()?.state === 'failed');
  assert.ok(!acct.accountLogin()?.error?.includes('leakycode123'), `the failed sign-in shows no code either: ${acct.accountLogin()?.error}`);
  assert.equal(settings().claudeLogin, undefined);
});

test('code: the browser finished first, so Claude Code has no sign-in for the code: that is a success', async () => {
  reset();
  let f!: ReturnType<typeof fakeSession>;
  f = fakeSession({
    callback: async () => {
      f.finish();
      throw new Error('No active claude_authenticate flow');
    },
  });
  acct.setAccountTestHooks({ open: f.open, cli: fakeCli, loginMs: 5000 });
  acct.startAccountLogin();
  await until('waiting', () => acct.accountLogin()?.state === 'waiting');
  const r = await api('POST', '/account/login/code', { code: 'late-code#state' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const body = r.body as AccountResponse;
  assert.equal(body.login, undefined);
  assert.equal(body.account?.loggedIn, true);
  assert.equal(body.optedIn, true);
});

// ---------- what HQ runs on ----------

test('runner: HQ_RUNNER=sim always sim, a key is live, the Claude login only with a yes and a login', () => {
  const rows: [Parameters<typeof runner.pickRunner>[0], 'sim' | 'claude'][] = [
    [{ explicit: 'sim', hasKey: true, optIn: true, auth: 'api-key' }, 'sim'],
    [{ explicit: 'sim', hasKey: false, optIn: true, auth: 'claude-login' }, 'sim'],
    [{ hasKey: true, optIn: false, auth: 'api-key' }, 'claude'],
    [{ explicit: 'claude', hasKey: true, optIn: true, auth: 'api-key' }, 'claude'],
    [{ explicit: 'claude', hasKey: false, optIn: true, auth: 'claude-login' }, 'claude'],
    [{ explicit: 'claude', hasKey: false, optIn: false, auth: 'claude-login' }, 'claude'],
    [{ hasKey: false, optIn: true, auth: 'claude-login' }, 'claude'],
    [{ explicit: 'claude', hasKey: false, optIn: true, auth: 'none' }, 'sim'],
    [{ hasKey: false, optIn: true, auth: 'none' }, 'sim'],
    [{ hasKey: false, optIn: false, auth: 'claude-login' }, 'sim'],
    [{ hasKey: false, optIn: false, auth: 'none' }, 'sim'],
  ];
  for (const [input, want] of rows) assert.equal(runner.pickRunner(input), want, JSON.stringify(input));
});

test('opt-in: needs a login; then the next start is live, and the meta says restart', async () => {
  reset();
  acct.setAccountTestHooks({ cli: fakeCli });
  const no = await api('PUT', '/account/use', { on: true });
  assert.equal(no.status, 409, 'no login yet');
  assert.equal((await api('PUT', '/account/use', { on: 'yes' })).status, 400);
  fs.writeFileSync(CREDS, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: TOKEN } }));
  assert.equal(runner.authSource(), 'claude-login', 'a login made while HQ runs counts at once');
  assert.equal((runner.meta() as Meta).restartToGoLive, false, 'a login alone is no yes');
  const yes = await api('PUT', '/account/use', { on: true });
  assert.equal(yes.status, 200);
  assert.equal((yes.body as AccountResponse).restartToGoLive, true);
  assert.equal(runner.meta().restartToGoLive, true);
  assert.equal(runner.runnerName(), 'sim', 'the mode never changes while HQ runs');
  assert.ok(!JSON.stringify(yes.body).includes(TOKEN), 'no token in what HQ answers');
  const off = await api('PUT', '/account/use', { on: false });
  assert.equal((off.body as AccountResponse).optedIn, false);
  assert.equal(runner.meta().restartToGoLive, false);
});

test('account: GET answers with who is signed in and never a token; ?check=1 asks again', async () => {
  reset();
  acct.setAccountTestHooks({ cli: fakeCli });
  cliState.loggedIn = true;
  const r = await api('GET', '/account');
  const body = r.body as AccountResponse;
  assert.equal(body.account?.email, 'you@example.com');
  assert.equal(body.account?.plan, 'max');
  assert.equal(body.apiKey, false);
  assert.equal(body.runner, 'sim');
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  const asked = cliState.calls.length;
  await api('GET', '/account');
  assert.equal(cliState.calls.length, asked, 'a fresh answer is reused');
  await api('GET', '/account?check=1');
  assert.equal(cliState.calls.length, asked + 1);
  assert.equal((await api('DELETE', '/account/login')).status, 404, 'no sign-in to cancel');
});

test('account: only HQ own page may make ?check=1 ask again; another site gets the usual answer', async () => {
  reset();
  acct.setAccountTestHooks({ cli: fakeCli });
  await api('GET', '/account');
  const asked = statusCalls();
  // What an <img src="http://127.0.0.1:4747/api/account?check=1"> on another site sends: no JSON type.
  for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'image/png' }] as Record<string, string>[]) {
    const r = await api('GET', '/account?check=1', undefined, headers);
    assert.equal(r.status, 200);
    assert.equal(statusCalls(), asked, JSON.stringify(headers));
  }
  await api('GET', '/account?check=1');
  assert.equal(statusCalls(), asked + 1, 'HQ own page sends JSON, so it asks again');
});

test('account: forced checks at once run Claude Code at most twice, and share the answer', async () => {
  reset();
  acct.setAccountTestHooks({ cli: fakeCli });
  const release = holdStatus();
  const checks = [0, 1, 2, 3, 4].map(() => acct.checkAccount(true));
  const plain = acct.checkAccount();
  cliState.loggedIn = true;
  release();
  const answers = await Promise.all(checks);
  assert.ok(statusCalls() <= 2, `${statusCalls()} runs`);
  assert.deepEqual(new Set(answers.slice(1).map((a) => a?.loggedIn)), new Set([true]), 'the queued check ran after the change');
  assert.equal((await plain)?.loggedIn, true, 'a plain check while forced ones wait gets the newest answer');
  assert.equal(statusCalls(), 2);
});

test('sign-out: through claude auth logout, and desks stop running on it; a failure says so', async () => {
  reset();
  acct.setAccountTestHooks({ cli: fakeCli });
  cliState.loggedIn = true;
  fs.writeFileSync(CREDS, JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }));
  acct.useClaudeLogin(true);
  cliState.logoutCode = 1;
  const failed = await api('POST', '/account/logout');
  assert.equal(failed.status, 502);
  assert.ok(settings().claudeLogin, 'a sign-out that failed keeps the yes');
  cliState.logoutCode = 0;
  fs.writeFileSync(CREDS, JSON.stringify({ mcpOAuth: {} }));
  const ok = await api('POST', '/account/logout');
  assert.equal(ok.status, 200);
  assert.ok(cliState.calls.some((a) => a.join(' ') === 'auth logout'));
  assert.equal((ok.body as AccountResponse).account?.loggedIn, false);
  assert.equal((ok.body as AccountResponse).optedIn, false);
  assert.equal(acct.hasClaudeLogin(), false, 'MCP sign-ins left in the file are not a Claude login');
  // Not while signing in.
  const f = fakeSession();
  acct.setAccountTestHooks({ open: f.open, cli: fakeCli, loginMs: 5000 });
  acct.startAccountLogin();
  assert.equal((await api('POST', '/account/logout')).status, 409);
  acct.cancelAccountLogin();
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
acct.cancelAccountLogin();
acct.setAccountTestHooks();
process.chdir(os.tmpdir());
try {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
} catch (e) {
  console.warn(`could not remove ${root}: ${e instanceof Error ? e.message : String(e)}`);
}
assert.equal(failed, 0, `${failed} account case(s) failed`);
console.log(`\nall ${passed} account cases pass`);
process.exit(0);
