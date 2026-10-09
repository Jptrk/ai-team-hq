/**
 * GPT desks on a ChatGPT login: HQ's Codex (codexServer.ts), the ChatGPT sign-in (codexAuth.ts), the GPT runner
 * (runner/codex.ts) and its file tools (runner/codexTools.ts). Codex itself is a fake here: every app-server HQ
 * starts is scripted by the test, so nothing signs in and no model runs.
 * Run: npm run test:codex. Works in throwaway folders under the OS temp dir.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkItem } from '../shared/types';
import type { AppServer, NotificationHandler, OpenOptions, RequestHandler } from './codexServer';

// The store, settings and HQ's Codex home live under the working directory, so move into a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-codex-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-codex-proj-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-codex-out-'));
process.chdir(root);
delete process.env.HQ_RUNNER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
// No Claude login: HQ goes live on the ChatGPT login alone.
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-config');
// Web search on, as with HQ_WEB=1 in .env: ticket runs and chat replies get Codex's web tool.
process.env.HQ_WEB = '1';
// Connections, as Claude Code keeps them: a program on this PC with a variable, a server you sign in to in a
// browser, one with a token header, and an SSE one GPT desks can't use.
fs.mkdirSync(path.join(root, 'claude-config'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'claude-config', '.claude.json'),
  JSON.stringify({
    mcpServers: {
      tester: { type: 'stdio', command: 'node', args: ['C:\\tools\\tester.js', '--fast'], env: { TESTER_TOKEN: 'abc123' } },
      webby: { type: 'http', url: 'https://mcp.example.test/mcp' },
      tokened: { type: 'http', url: 'https://api.example.test/mcp/', headers: { Authorization: 'Bearer secret-xyz' } },
      oldsse: { type: 'sse', url: 'https://sse.example.test/sse' },
    },
  }),
);
fs.mkdirSync(path.join(root, 'data', '.codex'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({ chatgptLogin: { at: new Date().toISOString() } }));
fs.writeFileSync(path.join(root, 'data', '.codex', 'auth.json'), '{"auth_mode":"chatgpt"}');
fs.writeFileSync(path.join(projectDir, 'app.ts'), 'export const a = 1;\nexport const b = 2;\nexport const a2 = 1;\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');

const codexServer = await import('./codexServer');
const auth = await import('./codexAuth');
const store = await import('./store');
const settings = await import('./settings');
const runner = await import('./runner/index');
const claude = await import('./runner/claude');
const codex = await import('./runner/codex');
const tools = await import('./runner/codexTools');
const { codexMcp, gptUnsupported } = await import('./codexMcp');
const mcpAuth = await import('./codexMcpAuth');
const conns = await import('./connections');
const { readGptPatch, router } = await import('./routes');
const autopilot = await import('./autopilot');
const chat = await import('./chat');
const { safeOpenAiUrl, chatGptPlanLabel } = await import('../shared/account');

// ---------- a fake Codex: each app-server HQ starts follows the scenario the test set ----------

type Scenario = (f: Fake, method: string, params: any) => unknown;

class Fake implements AppServer {
  calls: { method: string; params: any }[] = [];
  private req: RequestHandler = () => undefined;
  private note: NotificationHandler = () => undefined;
  private end!: () => void;
  readonly exited = new Promise<void>((r) => (this.end = r));
  closed = false;
  constructor(
    readonly opts: OpenOptions,
    private readonly scenario: Scenario,
  ) {}
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const r = await this.scenario(this, method, params);
    if (r instanceof Error) throw r;
    return r as T;
  }
  onRequest(h: RequestHandler) {
    this.req = h;
  }
  onNotification(h: NotificationHandler) {
    this.note = h;
  }
  /** Codex asks HQ something, as during a turn. */
  ask(method: string, params: unknown): Promise<any> {
    return Promise.resolve(this.req(method, params));
  }
  emit(method: string, params: unknown): void {
    this.note(method, params);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.end();
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

let scenario: Scenario = () => ({});
const servers: Fake[] = [];
codexServer.setAppServerForTests(async (opts) => {
  const f = new Fake(opts, scenario);
  servers.push(f);
  return f;
});

type TurnEnd = { status: string; error?: unknown };
let threadN = 0;

/** A desk turn: thread/start (or resume) answers with a thread, turn/start runs `steps`, then the turn completes as they say. */
function deskTurn(steps: (f: Fake) => Promise<TurnEnd>): Scenario {
  return (f, method, params) => {
    if (method === 'thread/start') return { thread: { id: `th-${++threadN}` } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') {
      setTimeout(() => {
        void steps(f).then((end) => f.emit('turn/completed', { threadId: params.threadId, turn: { id: 'tu-1', items: [], ...end } }));
      }, 1);
      return { turn: { id: 'tu-1' } };
    }
    if (method === 'turn/interrupt') {
      setTimeout(() => f.emit('turn/completed', { threadId: params.threadId, turn: { id: 'tu-1', items: [], status: 'interrupted', error: null } }), 1);
      return {};
    }
    return {};
  };
}

const call = (f: Fake, tool: string, args: unknown, callId = `c-${Math.random().toString(36).slice(2, 8)}`) =>
  f.ask('item/tool/call', { threadId: 'th', turnId: 'tu-1', callId, namespace: null, tool, arguments: args });
const say = (f: Fake, text: string) => f.emit('item/completed', { threadId: 'th', turnId: 'tu-1', item: { type: 'agentMessage', id: `m-${Math.random()}`, text } });

// ---------- a project with a GPT desk ----------

store.initStore({ emptySeed: true });
const p = store.createProject({ name: 'Shop', key: 'SH', path: projectDir, access: 'write', template: 'business', provider: 'gpt' });
const desk = p.state.agents.find((a) => !a.isHuman)!;
// A second project, on Claude: its desks can't run while HQ is live on ChatGPT alone.
const pc = store.createProject({ name: 'Docs', key: 'DC', path: null, access: 'read', template: 'business' });
const claudeDesk = pc.state.agents.find((a) => !a.isHuman)!;
const workspace = claude.workspaceFor(p.id, desk.id);

let n = 0;
function ticket(assignee: string, extra: Partial<WorkItem> = {}, project = p): WorkItem {
  const item: WorkItem = { id: `wi_c${++n}`, number: 200 + n, kind: 'fyi', status: 'todo', title: `Ticket ${n}`, summary: 'Do the thing', from: 'you', assignee, dated: '2026-10-08', links: [], history: [], ...extra };
  project.state.items.unshift(item);
  return item;
}

const busy = () => [p, pc].some((x) => x.state.runs.some((r) => r.status === 'queued' || r.status === 'running'));

async function idle(): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (!busy()) {
      await new Promise((r) => setTimeout(r, 5));
      if (!busy()) return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('runs never finished');
}

const runOf = (item: WorkItem) => [...p.state.runs, ...pc.state.runs].find((r) => r.itemId === item.id)!;

/** Call the API in-process, as the server does once it has parsed the JSON body. */
function api(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The app-server a run opened after `before` servers, once it has been asked `method`. */
async function serverAsked(before: number, method: string): Promise<Fake> {
  for (let i = 0; i < 400 && !servers[before]?.methods().includes(method); i++) await sleep(5);
  const f = servers[before];
  assert.ok(f?.methods().includes(method), `Codex was never asked ${method}`);
  return f;
}

const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);

// ---------- pure pieces ----------

test('sign-in pages: only https on auth.openai.com', () => {
  assert.equal(safeOpenAiUrl('https://auth.openai.com/oauth/authorize?x=1'), 'https://auth.openai.com/oauth/authorize?x=1');
  assert.equal(safeOpenAiUrl('https://auth.openai.com/codex/device'), 'https://auth.openai.com/codex/device');
  for (const bad of ['http://auth.openai.com/x', 'https://auth.openai.com.evil.test/x', 'https://evil.test/auth.openai.com', 'https://u:p@auth.openai.com/', 'javascript:alert(1)', 42, null]) {
    assert.equal(safeOpenAiUrl(bad), null, String(bad));
  }
  assert.equal(chatGptPlanLabel('plus'), 'Plus');
  assert.equal(chatGptPlanLabel(undefined), null);
});

test('account/read: a ChatGPT login shows email and plan; signed out or an API key is no ChatGPT login', () => {
  assert.deepEqual(auth.parseAccount({ account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' } }), { loggedIn: true, email: 'a@b.c', plan: 'plus' });
  assert.deepEqual(auth.parseAccount({ account: { type: 'chatgpt', email: null, planType: 'unknown' } }), { loggedIn: true });
  assert.deepEqual(auth.parseAccount({ account: null, requiresOpenaiAuth: true }), { loggedIn: false });
  assert.deepEqual(auth.parseAccount({ account: { type: 'apiKey' } }), { loggedIn: false });
  assert.equal(auth.parseAccount('nope'), null);
});

test('usage windows: 5-hour and weekly, percent clamped, reset as a time', () => {
  const w = auth.windowsOf({ primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: { usedPercent: 140, windowDurationMins: 10080, resetsAt: null }, credits: {} });
  assert.deepEqual(w, [
    { label: '5-hour', usedPercent: 12, resetsAt: new Date(1_900_000_000_000).toISOString() },
    { label: 'weekly', usedPercent: 100 },
  ]);
  assert.deepEqual(auth.windowsOf({ primary: null }), []);
  // A run's update can carry one window: it merges into what was known.
  auth.noteRateLimits({ primary: { usedPercent: 5, windowDurationMins: 300 }, secondary: { usedPercent: 1, windowDurationMins: 10080 } });
  auth.noteRateLimits({ primary: { usedPercent: 9, windowDurationMins: 300 } });
  assert.deepEqual(auth.chatGptUsage()?.map((x) => `${x.label}:${x.usedPercent}`), ['5-hour:9', 'weekly:1']);
});

test('model list: hidden models out, sub-agent efforts out, default kept', () => {
  const list = auth.parseModels({
    data: [
      { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }] },
      { id: 'gpt-reserve', displayName: 'Hidden', hidden: true, supportedReasoningEfforts: [] },
      { id: 'Bad Id!', displayName: 'x' },
    ],
  });
  assert.deepEqual(list, [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'max'], defaultEffort: 'low', isDefault: true }]);
});

test('model and effort patch: names only, checked against the model list when HQ has one', () => {
  const models = [{ id: 'gpt-6.1-sol', name: 'Sol', efforts: ['low', 'high'], isDefault: true }];
  assert.deepEqual(readGptPatch({ model: 'gpt-6.1-sol', effort: 'high' }, models), { model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(readGptPatch({ model: null, effort: null }, models), { model: null, effort: null });
  assert.match(readGptPatch({ model: 'gpt-9' }, models).error ?? '', /not a model/);
  assert.match(readGptPatch({ effort: 'ultra' }, models).error ?? '', /no ultra effort/);
  assert.match(readGptPatch({ model: 'x" ; rm -rf' }, models).error ?? '', /model name/);
  assert.match(readGptPatch({}, models).error ?? '', /Nothing/);
  // No list yet: any well-formed name.
  assert.deepEqual(readGptPatch({ model: 'gpt-7' }, []), { model: 'gpt-7' });
});

test('settings keep GPT names only when they are names', () => {
  const s = settings.parseSettings({ chatgptLogin: { at: '2026-10-08T00:00:00Z' }, gptModel: 'gpt-6.1-sol', gptEffort: 'BAD EFFORT' });
  assert.deepEqual(s, { chatgptLogin: { at: '2026-10-08T00:00:00Z' }, gptModel: 'gpt-6.1-sol' });
});

test('limits: a used-up window holds automatic work until it resets; throttling and other errors do not', () => {
  const now = Date.parse('2026-10-08T10:00:00Z');
  const rates = { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: (now + 3_600_000) / 1000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: (now + 86_400_000 * 3) / 1000 } };
  const limit = codex.gptLimitOf({ codexErrorInfo: 'usageLimitExceeded' }, rates, now)!;
  assert.equal(limit.kind, 'usage');
  assert.equal(limit.until, new Date(now + 3_600_000).toISOString());
  assert.match(limit.text, /^ChatGPT's 5-hour limit reached\. It resets at /);
  assert.equal(codex.gptLimitOf({ codexErrorInfo: 'usageLimitExceeded' }, null, now)?.text, "ChatGPT's usage limit reached.");
  assert.equal(codex.gptLimitOf({ codexErrorInfo: 'unauthorized' }, null, now)?.kind, 'account');
  assert.equal(codex.gptLimitOf({ codexErrorInfo: 'rateLimitExceeded' }, rates, now), null);
  assert.equal(codex.gptLimitOf(null, rates, now), null);
});

test('desk config: Codex extras off, the code-mode host on, no AGENTS.md, the login in a file', () => {
  const c = codexServer.DESK_CONFIG;
  for (const off of [
    'features.shell_tool=false',
    'features.unified_exec=false',
    'features.apps=false',
    'features.plugins=false',
    'features.multi_agent=false',
    'features.image_generation=false',
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
  ]) {
    assert.ok(c.includes(off), off);
  }
  assert.ok(!c.some((x) => x.startsWith('features.code_mode_host')), 'current models call every tool from the code-mode host');
  assert.ok(c.includes('cli_auth_credentials_store="file"'));
  const env = codexServer.codexEnv({ PATH: 'x', OPENAI_API_KEY: 'sk-1', CODEX_API_KEY: 'k', OPENAI_BASE_URL: 'u', HOME: 'h' });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.CODEX_HOME, path.join(root, 'data', '.codex'));
});

test('desk config against the pinned Codex: every feature HQ switches off reads false', () => {
  // Codex ignores a features.* key it doesn't know without a word, so only its own list shows the switches took.
  let bin: string;
  try {
    bin = codexServer.codexBin();
  } catch (e) {
    console.log(`     skip: no Codex program (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  if (!fs.existsSync(bin)) {
    console.log(`     skip: no Codex program at ${bin}`);
    return;
  }
  // A Codex home of its own: `features list` reads settings only, offline, and signs nothing in.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-codex-home-'));
  try {
    const env = { ...codexServer.codexEnv(), CODEX_HOME: home };
    const r = spawnSync(bin, [...codexServer.DESK_CONFIG.flatMap((c) => ['-c', c]), 'features', 'list'], { cwd: home, env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(r.status, 0, `codex features list failed: ${r.error?.message ?? r.stderr}`);
    // Rows read "name   stage   true|false"; a stage can be two words.
    const state = new Map(
      r.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter((cols) => cols.length >= 3)
        .map((cols) => [cols[0], cols.at(-1)]),
    );
    for (const f of ['shell_tool', 'apps', 'plugins', 'multi_agent', 'image_generation', 'computer_use', 'browser_use', 'goals', 'hooks', 'memories', 'in_app_browser']) {
      assert.equal(state.get(f), 'false', `${f} is ${state.get(f) ?? 'not listed by this Codex'}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('a Claude desk fails plainly only without a key, and when Claude was never said yes to or GPT desks run without a Claude login', () => {
  const blocked = (o: Partial<Parameters<typeof runner.claudeBlocked>[0]>) =>
    runner.claudeBlocked({ hasKey: false, optIn: false, atBoot: false, auth: 'claude-login', gpt: true, ...o });
  // A key always runs.
  assert.equal(blocked({ hasKey: true, auth: 'api-key' }), false);
  assert.equal(blocked({ hasKey: true, auth: 'api-key', gpt: false }), false);
  // Never said yes to Claude, not now and not at start: a Claude login on this PC is never used.
  assert.equal(blocked({}), true);
  assert.equal(blocked({ gpt: false }), true);
  // Said yes at start, switched off since: desks keep running on the login until HQ restarts.
  assert.equal(blocked({ atBoot: true }), false);
  // Said yes now (HQ went live on ChatGPT, then you turned the Claude login on): Claude desks run on it.
  assert.equal(blocked({ optIn: true }), false);
  // No Claude login while GPT desks run: fails plainly, so no account hold stops the GPT desks.
  assert.equal(blocked({ optIn: true, atBoot: true, auth: 'none' }), true);
  // No Claude login and no GPT: the Claude runner runs, and a lost login is the usual account hold.
  assert.equal(blocked({ optIn: true, atBoot: true, auth: 'none', gpt: false }), false);
  assert.equal(blocked({ atBoot: true, auth: 'none', gpt: false }), false);
});

test('globs: **, *, ?, braces and classes over relative paths', () => {
  const g = (pattern: string, p: string) => tools.globToRegExp(pattern, false).test(p);
  assert.ok(g('**/*.ts', 'a.ts') && g('**/*.ts', 'src/x/a.ts') && !g('**/*.ts', 'a.tsx'));
  assert.ok(g('*.ts', 'a.ts') && !g('*.ts', 'src/a.ts'));
  assert.ok(g('src/**/index.*', 'src/index.ts') && g('src/**/index.*', 'src/a/b/index.js'));
  assert.ok(g('*.{ts,tsx}', 'a.tsx') && !g('*.{ts,tsx}', 'a.js'));
  assert.ok(g('file?.md', 'file1.md') && !g('file?.md', 'file10.md'));
  assert.ok(g('[ab].txt', 'a.txt') && !g('[ab].txt', 'c.txt'));
});

test('session keys: GPT threads carry gpt: keys, so a desk never resumes the other model', () => {
  const hq = { instructions: 'x', tools: [] };
  const a = codex.gptSessionKey({ tools: codex.toolSpecs(['Read'], hq), model: 'gpt-6.1-sol' });
  assert.match(a, /^gpt:[0-9a-f]{16}$/);
  assert.notEqual(a, codex.gptSessionKey({ tools: codex.toolSpecs(['Read', 'Write'], hq), model: 'gpt-6.1-sol' }));
  assert.notEqual(a, codex.gptSessionKey({ tools: codex.toolSpecs(['Read'], hq), model: 'gpt-6-astra' }));
  assert.equal(codex.isGptSession({ sessionKey: a }), true);
  assert.equal(codex.isGptSession({ sessionKey: 'abcdef0123456789' }), false);
  assert.equal(codex.isGptSession({}), false);
});

// ---------- file tools through HQ's fence ----------

function toolCtx(mode: 'ticket' | 'huddle' = 'ticket') {
  const ctx = { project: p, dir: workspace, agent: desk, mode, pendingWrites: new Map<string, string[]>(), changed: new Set<string>() };
  fs.mkdirSync(workspace, { recursive: true });
  return { dir: workspace, guard: claude.guard(ctx), pendingWrites: ctx.pendingWrites, changed: ctx.changed };
}

test('file tools: read inside the fence, refuse outside it', async () => {
  const c = toolCtx();
  fs.writeFileSync(path.join(workspace, 'notes.md'), 'one\ntwo\nthree\n');
  const r = await tools.runFileTool('Read', { file_path: 'notes.md' }, c, 'r1');
  assert.ok(r.ok);
  assert.match(r.text, /^\s+1\tone\n\s+2\ttwo\n\s+3\tthree$/);
  const part = await tools.runFileTool('Read', { file_path: 'notes.md', offset: 2, limit: 1 }, c, 'r2');
  assert.match(part.text, /2\ttwo\n\(lines 2-2 of 3; pass offset 3 to read on\)/);
  assert.ok((await tools.runFileTool('Read', { file_path: path.join(projectDir, 'app.ts') }, c, 'r3')).ok, 'the project folder reads');
  const out = await tools.runFileTool('Read', { file_path: path.join(outside, 'secret.txt') }, c, 'r4');
  assert.equal(out.ok, false);
  assert.match(out.text, /Stay inside/);
  const hq = await tools.runFileTool('Read', { file_path: path.join(root, 'data', 'settings.json') }, c, 'r5');
  assert.equal(hq.ok, false, "HQ's own data is off limits");
  const glob = await tools.runFileTool('Glob', { pattern: path.join(outside, '*') }, c, 'r6');
  assert.equal(glob.ok, false);
  const grep = await tools.runFileTool('Grep', { pattern: 'nope', path: outside }, c, 'r7');
  assert.equal(grep.ok, false);
});

test('file tools: writes count project files as changed; edits need a unique match', async () => {
  const c = toolCtx();
  const w = await tools.runFileTool('Write', { file_path: 'reports/out.md', content: '# Done\n' }, c, 'w1');
  assert.ok(w.ok, w.text);
  assert.equal(fs.readFileSync(path.join(workspace, 'reports', 'out.md'), 'utf8'), '# Done\n');
  assert.equal(c.changed.size, 0, 'the workspace is not the project');
  const app = path.join(projectDir, 'app.ts');
  const twice = await tools.runFileTool('Edit', { file_path: app, old_string: '= 1;', new_string: '= 9;' }, c, 'e1');
  assert.equal(twice.ok, false);
  assert.match(twice.text, /appears 2 times/);
  const once = await tools.runFileTool('Edit', { file_path: app, old_string: 'export const b = 2;', new_string: 'export const b = 3;' }, c, 'e2');
  assert.ok(once.ok, once.text);
  assert.match(fs.readFileSync(app, 'utf8'), /b = 3/);
  assert.deepEqual([...c.changed], ['app.ts']);
  assert.equal(c.pendingWrites.size, 0);
  const missing = await tools.runFileTool('Edit', { file_path: app, old_string: 'zzz', new_string: 'y' }, c, 'e3');
  assert.match(missing.text, /not found/);
  const blocked = await tools.runFileTool('Write', { file_path: path.join(projectDir, '.env'), content: 'X=1' }, c, 'w2');
  assert.equal(blocked.ok, false, '.env files are protected');
  assert.ok(!fs.existsSync(path.join(projectDir, '.env')));
  const huddle = toolCtx('huddle');
  assert.equal((await tools.runFileTool('Write', { file_path: 'x.md', content: 'x' }, huddle, 'w3')).ok, false, 'a huddle writes nothing');
});

test('file tools: glob and grep find files under the folder, newest first', async () => {
  const c = toolCtx();
  const g = await tools.runFileTool('Glob', { pattern: '**/*.ts', path: projectDir }, c, 'g1');
  assert.ok(g.ok);
  assert.equal(g.text, path.join(projectDir, 'app.ts'));
  const content = await tools.runFileTool('Grep', { pattern: 'const b', path: projectDir, output_mode: 'content' }, c, 'g2');
  assert.match(content.text, /app\.ts:2:export const b = 3;/);
  const files = await tools.runFileTool('Grep', { pattern: 'EXPORT', path: projectDir, '-i': true }, c, 'g3');
  assert.equal(files.text, path.join(projectDir, 'app.ts'));
  assert.match((await tools.runFileTool('Grep', { pattern: '(' }, c, 'g4')).text, /not a valid regular expression/);
});

test('file tools: a runaway grep pattern stops within its time, and HQ keeps ticking meanwhile', async () => {
  const c = toolCtx();
  const slow = path.join(workspace, 'slow.txt');
  // ^(a+)+$ against many a's and a b backtracks for hours.
  fs.writeFileSync(slow, `${'a'.repeat(40)}b\n`);
  tools.setGrepBudgetForTests(400);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const t0 = Date.now();
  try {
    const r = await tools.runFileTool('Grep', { pattern: '^(a+)+$', path: 'slow.txt' }, c, 'slow1');
    const ms = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.text, 'That search took too long; simplify the pattern or narrow the path.');
    assert.ok(ms < 5000, `it took ${ms} ms to give up`);
    assert.ok(ticks >= 10, `HQ's own timers ticked only ${ticks} times while it searched`);
  } finally {
    clearInterval(timer);
    tools.setGrepBudgetForTests();
    fs.rmSync(slow, { force: true });
  }
  // The same tool answers a normal search as before.
  const count = await tools.runFileTool('Grep', { pattern: 'const a', path: projectDir, output_mode: 'count' }, c, 'slow2');
  assert.equal(count.text, `${path.join(projectDir, 'app.ts')}:2`);
});

// ---------- the runner, on a fake Codex ----------

test('a GPT ticket run: HQ tools work, the ticket closes, no dollar cost, the thread is kept', async () => {
  const item = ticket(desk.id);
  scenario = deskTurn(async (f) => {
    const update = await call(f, 'post_update', { text: 'Writing the report' });
    assert.equal(update.success, true);
    const write = await call(f, 'Write', { file_path: 'reports/r.md', content: 'hi' });
    assert.equal(write.success, true, JSON.stringify(write));
    const bad = await call(f, 'report_done', { summary: 'short' });
    assert.equal(bad.success, false, 'zod still checks the input');
    const done = await call(f, 'report_done', { summary: 'Wrote the report in reports/r.md for you.' });
    assert.equal(done.success, true, JSON.stringify(done));
    say(f, 'Done: the report is in reports/r.md.');
    return { status: 'completed', error: null };
  });
  assert.ok(runner.kickoff(p, item.id, 'manual'));
  await idle();
  const run = runOf(item);
  assert.equal(run.status, 'done', run.error);
  assert.equal(run.provider, 'gpt');
  assert.equal(run.costUsd, 0);
  assert.equal(run.summary, 'Done: the report is in reports/r.md.');
  assert.notEqual(item.status, 'in-progress', 'report_done closed it');
  const f = servers.at(-1)!;
  assert.deepEqual(f.opts.config?.slice(0, codexServer.DESK_CONFIG.length), codexServer.DESK_CONFIG);
  assert.ok(f.opts.config?.includes('web_search="live"'), 'HQ_WEB=1 turns on web search for a ticket run');
  assert.equal(f.opts.cwd, workspace);
  const start = f.calls.find((c) => c.method === 'thread/start')!.params;
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'on-request');
  assert.match(start.developerInstructions, /## Your tools/);
  const names = start.dynamicTools.map((t: { name: string }) => t.name);
  for (const t of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'post_update', 'report_done', 'delete_file']) assert.ok(names.includes(t), t);
  assert.equal(start.dynamicTools.find((t: { name: string }) => t.name === 'report_done').inputSchema.type, 'object');
  assert.ok(f.closed, 'the app-server is closed after the run');
  assert.match(desk.sessionId ?? '', /^th-/);
  assert.match(desk.sessionKey ?? '', /^gpt:/);
});

test('the next run resumes the desk thread with this run instructions', async () => {
  const thread = desk.sessionId;
  const item = ticket(desk.id);
  scenario = deskTurn(async (f) => {
    await call(f, 'report_done', { summary: 'Finished the second ticket for you.' });
    return { status: 'completed' };
  });
  runner.kickoff(p, item.id, 'manual');
  await idle();
  assert.equal(runOf(item).status, 'done', runOf(item).error);
  const f = servers.at(-1)!;
  assert.ok(!f.methods().includes('thread/start'), 'no new thread');
  const resume = f.calls.find((c) => c.method === 'thread/resume')!.params;
  assert.equal(resume.threadId, thread);
  assert.match(resume.developerInstructions, /## Your tools/);
  assert.ok(!('allowProviderModelFallback' in resume), 'thread/resume has no allowProviderModelFallback');
  const turn = f.calls.find((c) => c.method === 'turn/start')!.params;
  assert.doesNotMatch(turn.input[0].text, /fresh session/, 'a resumed thread is not told it is fresh');
});

test('patches ask first: inside the fence accepted, outside or a delete declined', async () => {
  const item = ticket(desk.id);
  const decisions: string[] = [];
  const patch = async (f: Fake, id: string, changes: unknown[], status: string) => {
    f.emit('item/started', { threadId: 'th', turnId: 'tu-1', item: { type: 'fileChange', id, changes, status: 'inProgress' } });
    const { decision } = await f.ask('item/fileChange/requestApproval', { threadId: 'th', turnId: 'tu-1', itemId: id, startedAtMs: Date.now() });
    decisions.push(decision);
    f.emit('item/completed', { threadId: 'th', turnId: 'tu-1', item: { type: 'fileChange', id, changes, status: decision === 'accept' ? status : 'declined' } });
  };
  scenario = deskTurn(async (f) => {
    await patch(f, 'p1', [{ path: path.join(projectDir, 'new.ts'), kind: { type: 'add' }, diff: 'x' }], 'completed');
    await patch(f, 'p2', [{ path: path.join(outside, 'x.ts'), kind: { type: 'add' }, diff: 'x' }], 'completed');
    await patch(f, 'p3', [{ path: path.join(projectDir, 'app.ts'), kind: { type: 'delete' }, diff: '' }], 'completed');
    await patch(f, 'p4', [{ path: path.join(projectDir, 'app.ts'), kind: { type: 'update', move_path: path.join(outside, 'moved.ts') }, diff: '' }], 'completed');
    const cmd = await f.ask('item/commandExecution/requestApproval', { itemId: 'c1' });
    decisions.push(cmd.decision);
    await call(f, 'report_done', { summary: 'Added new.ts to the project for you.' });
    return { status: 'completed' };
  });
  runner.kickoff(p, item.id, 'manual');
  await idle();
  assert.equal(runOf(item).status, 'done', runOf(item).error);
  assert.deepEqual(decisions, ['accept', 'decline', 'decline', 'decline', 'decline']);
  assert.deepEqual(item.changedFiles, ['new.ts'], 'only the accepted, completed patch counts');
});

test('a used-up ChatGPT plan fails the run and holds automatic work until it resets', async () => {
  const item = ticket(desk.id);
  const resets = Math.floor(Date.now() / 1000) + 3600;
  scenario = deskTurn(async (f) => {
    f.emit('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resets } } });
    return { status: 'failed', error: { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' } };
  });
  runner.kickoff(p, item.id, 'manual');
  await idle();
  const run = runOf(item);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /ChatGPT's 5-hour limit reached/);
  const hold = settings.settings().usageHold;
  assert.equal(hold?.kind, 'usage');
  assert.equal(hold?.until, new Date(resets * 1000).toISOString());
  settings.setUsageHold(null);
});

test('Stop interrupts the turn; the run says you stopped it', async () => {
  const item = ticket(desk.id);
  let release!: () => void;
  const waiting = new Promise<void>((r) => (release = r));
  scenario = deskTurn(async () => {
    await waiting;
    return { status: 'completed' };
  });
  runner.kickoff(p, item.id, 'manual');
  for (let i = 0; i < 200 && runOf(item).status !== 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 200 && !servers.at(-1)?.methods().includes('turn/start'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(runner.cancelRun(runOf(item).id));
  await idle();
  release();
  const run = runOf(item);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'Stopped by you');
  assert.ok(servers.at(-1)!.methods().includes('turn/interrupt'));
});

test('a tool-call cap stops a run that loops; one that closed out first still counts as done', async () => {
  const item = ticket(desk.id);
  scenario = deskTurn(async (f) => {
    await call(f, 'report_done', { summary: 'Closed it out before looping.' });
    for (let i = 0; i < 90; i++) {
      const r = await call(f, 'post_update', { text: `Loop ${i}` });
      if (!r.success) break;
    }
    return { status: 'interrupted' };
  });
  runner.kickoff(p, item.id, 'manual');
  await idle();
  const run = runOf(item);
  assert.equal(run.status, 'done', run.error);
  assert.match(run.summary ?? '', /^Closed out, then stopped: Stopped after 80 tool calls/);
});

/** A patch the model starts, and HQ's answer to its approval request. */
async function askPatch(f: Fake, id: string, changes: unknown[]): Promise<string> {
  f.emit('item/started', { threadId: 'th', turnId: 'tu-1', item: { type: 'fileChange', id, changes, status: 'inProgress' } });
  const { decision } = await f.ask('item/fileChange/requestApproval', { threadId: 'th', turnId: 'tu-1', itemId: id, startedAtMs: Date.now() });
  f.emit('item/completed', { threadId: 'th', turnId: 'tu-1', item: { type: 'fileChange', id, changes, status: decision === 'accept' ? 'completed' : 'declined' } });
  return decision;
}

test('Stop before Codex answers turn/start: the interrupt goes as soon as the turn has an id, and nothing is written after', async () => {
  const item = ticket(desk.id);
  let answerTurn!: () => void;
  const turnHeld = new Promise<void>((r) => (answerTurn = r));
  let stepsDone!: () => void;
  const steps = new Promise<void>((r) => (stepsDone = r));
  const after: { write?: { success: boolean; contentItems: { text?: string }[] }; patch?: string } = {};
  const late = path.join(workspace, 'after-stop.md');
  scenario = async (f, method, params) => {
    if (method === 'thread/start') return { thread: { id: `th-${++threadN}` } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') {
      await turnHeld;
      // The turn gets under way anyway: the model writes, then patches, then Codex reports the turn interrupted.
      setTimeout(() => {
        void (async () => {
          after.write = await call(f, 'Write', { file_path: 'after-stop.md', content: 'too late' });
          after.patch = await askPatch(f, 'p-late', [{ path: path.join(workspace, 'patched-late.md'), kind: { type: 'add' }, diff: 'x' }]);
          f.emit('turn/completed', { threadId: params.threadId, turn: { id: 'tu-1', items: [], status: 'interrupted', error: null } });
          stepsDone();
        })();
      }, 1);
      return { turn: { id: 'tu-1' } };
    }
    return {};
  };
  const before = servers.length;
  runner.kickoff(p, item.id, 'manual');
  const f = await serverAsked(before, 'turn/start');
  assert.ok(runner.cancelRun(runOf(item).id));
  await sleep(30);
  assert.ok(!f.methods().includes('turn/interrupt'), 'no turn id yet: nothing to interrupt');
  answerTurn();
  await steps;
  await idle();
  const m = f.methods();
  assert.ok(m.indexOf('turn/interrupt') > m.indexOf('turn/start'), 'the interrupt went once Codex gave the turn id');
  assert.equal(after.write?.success, false);
  assert.match(after.write?.contentItems[0]?.text ?? '', /stopped/);
  assert.ok(!fs.existsSync(late), 'nothing written after Stop');
  assert.equal(after.patch, 'decline');
  assert.equal(runOf(item).status, 'failed');
  assert.equal(runOf(item).error, 'Stopped by you');
});

test('a Write after Stop is refused, mid-turn', async () => {
  const item = ticket(desk.id);
  let inTurn!: () => void;
  const started = new Promise<void>((r) => (inTurn = r));
  let pressed!: () => void;
  const stopped = new Promise<void>((r) => (pressed = r));
  let stepsDone!: () => void;
  const steps = new Promise<void>((r) => (stepsDone = r));
  let write: { success: boolean; contentItems: { text?: string }[] } | undefined;
  const late = path.join(workspace, 'late.md');
  scenario = deskTurn(async (f) => {
    inTurn();
    await stopped;
    write = await call(f, 'Write', { file_path: 'late.md', content: 'too late' });
    stepsDone();
    return { status: 'interrupted' };
  });
  const before = servers.length;
  runner.kickoff(p, item.id, 'manual');
  await started;
  assert.ok(runner.cancelRun(runOf(item).id));
  pressed();
  await steps;
  await idle();
  assert.equal(write?.success, false);
  assert.match(write?.contentItems[0]?.text ?? '', /stopped/);
  assert.ok(!fs.existsSync(late), 'nothing written after Stop');
  assert.ok(servers[before].methods().includes('turn/interrupt'));
  assert.equal(runOf(item).error, 'Stopped by you');
});

test('patches count toward the tool-call cap, like tool calls', async () => {
  const item = ticket(desk.id);
  const decisions: string[] = [];
  let after: { success: boolean } | undefined;
  let stepsDone!: () => void;
  const steps = new Promise<void>((r) => (stepsDone = r));
  scenario = deskTurn(async (f) => {
    for (let i = 0; i < 81; i++) {
      decisions.push(await askPatch(f, `cap-${i}`, [{ path: path.join(workspace, 'drafts', `cap-${i}.md`), kind: { type: 'add' }, diff: 'x' }]));
    }
    after = await call(f, 'post_update', { text: 'One more' });
    stepsDone();
    return { status: 'interrupted' };
  });
  runner.kickoff(p, item.id, 'manual');
  await steps;
  await idle();
  assert.equal(decisions.filter((d) => d === 'accept').length, 80, 'the cap is 80 for patches and tool calls together');
  assert.equal(decisions.at(-1), 'decline');
  assert.equal(after?.success, false, 'nothing runs past the cap');
  assert.equal(runOf(item).status, 'failed');
  assert.match(runOf(item).error ?? '', /^Stopped after 80 tool calls/);
});

test('a patch to a Windows form of a protected name is declined', async () => {
  const item = ticket(desk.id);
  const decisions: string[] = [];
  scenario = deskTurn(async (f) => {
    decisions.push(await askPatch(f, 'w1', [{ path: path.join(projectDir, '.git.', 'hooks', 'post-checkout'), kind: { type: 'add' }, diff: 'x' }]));
    decisions.push(await askPatch(f, 'w2', [{ path: path.join(projectDir, 'server.key.'), kind: { type: 'add' }, diff: 'x' }]));
    decisions.push(await askPatch(f, 'w3', [{ path: path.join(projectDir, 'app.ts'), kind: { type: 'update', move_path: path.join(projectDir, 'node_modules.', 'x.js') }, diff: '' }]));
    decisions.push(await askPatch(f, 'w4', [{ path: path.join(projectDir, 'app.ts::$DATA'), kind: { type: 'update', move_path: null }, diff: '' }]));
    decisions.push(await askPatch(f, 'w5', [{ path: path.join(projectDir, 'plain.ts'), kind: { type: 'add' }, diff: 'x' }]));
    await call(f, 'report_done', { summary: 'Tried the odd names; only plain.ts went in.' });
    return { status: 'completed' };
  });
  runner.kickoff(p, item.id, 'manual');
  await idle();
  assert.equal(runOf(item).status, 'done', runOf(item).error);
  assert.deepEqual(decisions, ['decline', 'decline', 'decline', 'decline', 'accept']);
});

test("a turn's end counts only with its own id, also when it comes before turn/start answers", async () => {
  const item = ticket(desk.id);
  scenario = async (f, method, params) => {
    if (method === 'thread/start') return { thread: { id: `th-${++threadN}` } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') {
      await call(f, 'report_done', { summary: 'Finished it before Codex answered turn/start.' });
      say(f, 'Done early.');
      // Another turn's end first, then this one's, both before the answer gives HQ the id.
      f.emit('turn/completed', { threadId: params.threadId, turn: { id: 'tu-old', items: [], status: 'failed', error: { message: 'An older turn failed.' } } });
      f.emit('turn/completed', { threadId: params.threadId, turn: { id: 'tu-7', items: [], status: 'completed', error: null } });
      return { turn: { id: 'tu-7' } };
    }
    return {};
  };
  runner.kickoff(p, item.id, 'manual');
  await idle();
  const run = runOf(item);
  assert.equal(run.status, 'done', run.error);
  assert.equal(run.summary, 'Done early.');
});

test('the turn id from turn/started lets Stop interrupt before turn/start answers', async () => {
  const item = ticket(desk.id);
  let answerTurn!: () => void;
  const turnHeld = new Promise<void>((r) => (answerTurn = r));
  scenario = async (f, method, params) => {
    if (method === 'thread/start') return { thread: { id: `th-${++threadN}` } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') {
      f.emit('turn/started', { threadId: params.threadId, turn: { id: 'tu-s', items: [], status: 'inProgress', error: null } });
      await turnHeld;
      return { turn: { id: 'tu-s' } };
    }
    if (method === 'turn/interrupt') {
      setTimeout(() => f.emit('turn/completed', { threadId: params.threadId, turn: { id: 'tu-s', items: [], status: 'interrupted', error: null } }), 1);
      // Codex answers turn/start late; the interrupt itself went first.
      setTimeout(answerTurn, 5);
      return {};
    }
    return {};
  };
  const before = servers.length;
  runner.kickoff(p, item.id, 'manual');
  const f = await serverAsked(before, 'turn/start');
  assert.ok(runner.cancelRun(runOf(item).id));
  await idle();
  assert.ok(f.methods().includes('turn/interrupt'), 'interrupted with the id turn/started gave');
  assert.equal(runOf(item).error, 'Stopped by you');
});

test('older approval requests and permission requests get a no, each in its own answer shape', async () => {
  const item = ticket(desk.id);
  const answers: any[] = [];
  scenario = deskTurn(async (f) => {
    answers.push(await f.ask('applyPatchApproval', { conversationId: 'th', callId: 'a1', fileChanges: {}, reason: null, grantRoot: null }));
    answers.push(await f.ask('execCommandApproval', { conversationId: 'th', callId: 'a2', command: ['git', 'push'], cwd: workspace, reason: null, parsedCmd: [] }));
    answers.push(
      await f.ask('item/permissions/requestApproval', {
        threadId: 'th',
        turnId: 'tu-1',
        itemId: 'perm',
        environmentId: null,
        startedAtMs: Date.now(),
        cwd: workspace,
        reason: 'more room',
        permissions: { network: { enabled: true }, fileSystem: { read: null, write: [outside] } },
      }),
    );
    await call(f, 'report_done', { summary: 'Asked for more access and was told no.' });
    return { status: 'completed' };
  });
  runner.kickoff(p, item.id, 'manual');
  await idle();
  assert.equal(runOf(item).status, 'done', runOf(item).error);
  for (const legacy of answers.slice(0, 2)) {
    assert.deepEqual(Object.keys(legacy.decision), ['denied'], JSON.stringify(legacy));
    assert.equal(typeof legacy.decision.denied.rejection, 'string');
  }
  assert.deepEqual(answers[2], { permissions: {}, scope: 'turn' }, 'nothing granted');
});

test('a thread too long for the model fails its run and is dropped: the next run starts a new thread', async () => {
  const item = ticket(desk.id);
  scenario = deskTurn(async () => ({ status: 'failed', error: { message: 'Codex ran out of room in the context window.', codexErrorInfo: 'contextWindowExceeded' } }));
  runner.kickoff(p, item.id, 'manual');
  await idle();
  const run = runOf(item);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /too long for the model: the desk's next run starts a new one/);
  assert.equal(desk.sessionId, undefined, 'the thread is forgotten');
  assert.equal(desk.sessionKey, undefined);
  const next = ticket(desk.id);
  scenario = deskTurn(async (f) => {
    await call(f, 'report_done', { summary: 'Finished it on a new thread for you.' });
    return { status: 'completed' };
  });
  const before = servers.length;
  runner.kickoff(p, next.id, 'manual');
  await idle();
  assert.equal(runOf(next).status, 'done', runOf(next).error);
  assert.ok(servers[before].methods().includes('thread/start'), 'a new thread');
  assert.ok(!servers[before].methods().includes('thread/resume'));
  assert.equal(servers[before].calls.find((c) => c.method === 'thread/start')?.params.allowProviderModelFallback, true, 'a new thread may fall back to the default model');
  assert.match(desk.sessionId ?? '', /^th-/);
});

test('a Claude project waits while HQ is live on ChatGPT alone and Claude was never said yes to: no run, no hold elsewhere', async () => {
  assert.equal(runner.claudeAtStart(), false, 'HQ started with no yes to Claude');
  assert.match(runner.modelProblem(pc) ?? '', /runs on Claude, but HQ has no Claude login/);
  assert.equal(runner.modelProblem(p), null, 'the GPT project can run');
  const item = ticket(claudeDesk.id, {}, pc);
  assert.equal(runner.kickoff(pc, item.id, 'manual'), null);
  assert.equal(pc.state.runs.length, 0, 'nothing started');
  assert.deepEqual({ why: item.autoHold?.why, mine: item.autoHold?.mine }, { why: 'model', mine: true });
  assert.match(item.history.at(-1)!.text, /runs on Claude and HQ has no Claude login/);
  assert.equal(autopilot.autoGate(pc)?.kind, 'model', "the team's own starts wait at the same gate");
  assert.equal(autopilot.autoGate(p), null);
  assert.equal(settings.settings().usageHold, undefined);
  const state = await api('GET', `/projects/${pc.id}/state`);
  assert.match(state.body.modelProblem ?? '', /runs on Claude/, 'the page says why');
  delete item.autoHold;
});

test('a Claude project with Claude turned on but no Claude login also waits while GPT desks run', async () => {
  settings.setClaudeLogin(true);
  try {
    assert.match(runner.modelProblem(pc) ?? '', /no Claude login/);
    const item = ticket(claudeDesk.id, {}, pc);
    assert.equal(runner.kickoff(pc, item.id, 'manual'), null);
    assert.equal(item.autoHold?.why, 'model');
    assert.equal(settings.settings().usageHold, undefined, 'no account hold, so GPT desks keep working');
    delete item.autoHold;
  } finally {
    settings.setClaudeLogin(false);
  }
});

test('no ChatGPT login: work in a GPT project waits, then starts by itself once the login is back', async () => {
  const file = auth.chatGptAuthFile();
  fs.renameSync(file, `${file}.bak`);
  auth.setChatGptTestHooks();
  const item = ticket(desk.id);
  try {
    assert.match(runner.modelProblem(p) ?? '', /runs on GPT, but HQ has no ChatGPT login/);
    assert.equal(runner.kickoff(p, item.id, 'instruct', 'Use the new numbers'), null);
    assert.deepEqual({ why: item.autoHold?.why, mine: item.autoHold?.mine, note: item.autoHold?.note }, { why: 'model', mine: true, note: 'Use the new numbers' });
    runner.autoTick(p);
    assert.equal(item.autoHold?.why, 'model', 'still waiting: nothing to run on');
  } finally {
    fs.renameSync(`${file}.bak`, file);
  }
  scenario = deskTurn(async (f) => {
    await call(f, 'report_done', { summary: 'Did the held ticket with the new numbers.' });
    return { status: 'completed' };
  });
  runner.autoTick(p);
  await idle();
  assert.equal(item.autoHold, undefined);
  assert.equal(runOf(item)?.status, 'done', runOf(item)?.error);
  const prompt = servers.at(-1)!.calls.find((c) => c.method === 'turn/start')!.params.input[0].text;
  assert.match(prompt, /Use the new numbers/, 'your note went with it');
});

test('the reason names the real cause: a login whose switch is off is not a missing login', async () => {
  // A Claude login on this PC that HQ was never told to use, now or at start.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
  try {
    assert.equal(runner.authSource(), 'claude-login');
    assert.match(runner.modelProblem(pc) ?? '', /runs on Claude, but Run desks on my Claude login is off/);
    assert.equal(runner.meta().claudeReady, false, 'the header names no Claude model');
    const item = ticket(claudeDesk.id, {}, pc);
    assert.equal(runner.kickoff(pc, item.id, 'manual'), null);
    assert.match(item.history.at(-1)!.text, /runs on Claude and Run desks on my Claude login is off/);
    item.status = 'done';
    delete item.autoHold;
    // Turning it on is enough: Claude projects can run at once, with no restart.
    settings.setClaudeLogin(true);
    assert.equal(runner.modelProblem(pc), null);
    assert.equal(runner.meta().claudeReady, true);
  } finally {
    settings.setClaudeLogin(false);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  assert.match(runner.modelProblem(pc) ?? '', /HQ has no Claude login/, 'no login again: the login wording');
  assert.equal(runner.meta().claudeReady, false);
  // HQ's ChatGPT login is there, but Run GPT desks on my ChatGPT login is off.
  settings.setChatGptLogin(false);
  try {
    assert.match(runner.modelProblem(p) ?? '', /runs on GPT, but Run GPT desks on my ChatGPT login is off/);
    const item = ticket(desk.id);
    assert.equal(runner.kickoff(p, item.id, 'manual'), null);
    assert.match(item.history.at(-1)!.text, /runs on GPT and Run GPT desks on my ChatGPT login is off/);
    item.status = 'done';
    delete item.autoHold;
  } finally {
    settings.setChatGptLogin(true);
  }
});

test('"Put … on it" where the model can\'t run: refused with the reason, nothing held', async () => {
  const item = ticket(claudeDesk.id, { status: 'in-progress' }, pc);
  const res = await api('POST', `/projects/${pc.id}/items/${item.id}/run`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, runner.modelProblem(pc), 'the toast says why');
  assert.equal(item.autoHold, undefined, 'nothing held');
  assert.ok(!pc.state.runs.some((r) => r.itemId === item.id), 'nothing queued');
  item.status = 'done';
});

/** A desk turn that waits for letGo, then closes out: the desk stays busy until then. */
function busyTurn(): { scenario: Scenario; letGo: () => void } {
  let letGo!: () => void;
  const held = new Promise<void>((r) => (letGo = r));
  return {
    letGo,
    scenario: deskTurn(async (f) => {
      await held;
      await call(f, 'report_done', { summary: 'Finished the busy one.' });
      return { status: 'completed' };
    }),
  };
}

test('yours, queued behind a busy desk when the login goes away: they wait (no failed run, no paused thread), then start', async () => {
  const busyItem = ticket(desk.id);
  const queuedItem = ticket(desk.id, { status: 'in-progress' });
  const turn = busyTurn();
  scenario = turn.scenario;
  const before = servers.length;
  runner.kickoff(p, busyItem.id, 'manual');
  await serverAsked(before, 'turn/start');
  runner.kickoff(p, queuedItem.id, 'instruct', 'Use the new numbers');
  const th = chat.createThread(p.state, { title: 'Numbers', createdBy: 'you' });
  const posted = chat.postFounderMessage(p.state, th, `@${desk.name} are the numbers in?`);
  assert.deepEqual(posted.deliver, [desk.id]);
  runner.deliver(p, th.id, posted.deliver);
  assert.deepEqual(p.state.runs.filter((r) => r.status === 'queued').map((r) => r.reason).sort(), ['instruct', 'message'], 'both wait for the desk');
  const file = auth.chatGptAuthFile();
  fs.renameSync(file, `${file}.bak`);
  try {
    turn.letGo();
    await idle();
    assert.equal(runOf(busyItem).status, 'done', runOf(busyItem).error);
    assert.deepEqual(
      { why: queuedItem.autoHold?.why, mine: queuedItem.autoHold?.mine, note: queuedItem.autoHold?.note },
      { why: 'model', mine: true, note: 'Use the new numbers' },
      'the instruct waits on its ticket as your own start, with your note',
    );
    assert.match(queuedItem.history.at(-1)!.text, /runs on GPT and HQ has no ChatGPT login/);
    const wake = p.state.auto.heldWakes.find((w) => w.threadId === th.id && w.agentId === desk.id);
    assert.deepEqual({ why: wake?.why, mine: wake?.mine }, { why: 'model', mine: true }, 'the message waits as yours');
    assert.equal(chat.findThread(p.state, th.id)?.status, 'open', 'the thread is not paused');
    assert.ok(!p.state.runs.some((r) => r.status === 'failed' && (r.itemId === queuedItem.id || r.threadId === th.id)), 'no failed run');
    runner.autoTick(p);
    assert.equal(queuedItem.autoHold?.why, 'model', 'still waiting: nothing to run on');
  } finally {
    fs.renameSync(`${file}.bak`, file);
  }
  const prompts: string[] = [];
  scenario = deskTurn(async (f) => {
    const text: string = f.calls.find((c) => c.method === 'turn/start')!.params.input[0].text;
    prompts.push(text);
    if (/Use the new numbers/.test(text)) await call(f, 'report_done', { summary: 'Used the new numbers.' });
    else say(f, 'Yes, they are in.');
    return { status: 'completed' };
  });
  runner.autoTick(p);
  await idle();
  assert.equal(queuedItem.autoHold, undefined);
  assert.deepEqual({ reason: runOf(queuedItem).reason, status: runOf(queuedItem).status }, { reason: 'instruct', status: 'done' }, runOf(queuedItem).error);
  assert.ok(prompts.some((t) => /Use the new numbers/.test(t)), 'your note went with it');
  assert.equal(p.state.auto.heldWakes.filter((w) => w.threadId === th.id).length, 0);
  const reply = p.state.runs.find((r) => r.reason === 'message' && r.threadId === th.id);
  assert.equal(reply?.status, 'done', reply?.error);
  assert.doesNotMatch(reply?.summary ?? '', /^Skipped/, 'the desk answered');
});

test("the team's start for a ticket never replaces your held start there", async () => {
  const y = ticket(desk.id, { status: 'in-progress' });
  const x = ticket(desk.id, { status: 'in-progress' });
  const turn = busyTurn();
  scenario = turn.scenario;
  const before = servers.length;
  runner.kickoff(p, y.id, 'manual');
  await serverAsked(before, 'turn/start');
  assert.ok(runner.kickoff(p, x.id, 'handoff', undefined, [], { auto: true }), "the team's hand-off waits behind it");
  const file = auth.chatGptAuthFile();
  fs.renameSync(file, `${file}.bak`);
  try {
    assert.equal(runner.kickoff(p, x.id, 'instruct', 'Use the new numbers'), null);
    const yours = structuredClone(x.autoHold);
    assert.deepEqual({ reason: yours?.reason, mine: yours?.mine, note: yours?.note }, { reason: 'instruct', mine: true, note: 'Use the new numbers' });
    const lines = x.history.length;
    turn.letGo();
    await idle();
    assert.deepEqual(x.autoHold, yours, 'your held start, note and all, is as it was');
    assert.equal(x.history.length, lines, 'no hold line for the hand-off');
    assert.ok(!p.state.runs.some((r) => r.itemId === x.id && r.status === 'failed'));
  } finally {
    fs.renameSync(`${file}.bak`, file);
  }
  scenario = deskTurn(async (f) => {
    await call(f, 'report_done', { summary: 'Used the new numbers.' });
    return { status: 'completed' };
  });
  runner.autoTick(p);
  await idle();
  assert.equal(x.autoHold, undefined);
  assert.deepEqual({ reason: runOf(x).reason, status: runOf(x).status }, { reason: 'instruct', status: 'done' }, runOf(x).error);
});

test('switching the project model: refused while a run goes; then every desk starts a new conversation', async () => {
  desk.sessionId = 'th-old';
  desk.sessionKey = 'gpt:0123456789abcdef';
  const busyRun = { id: 'run_busy', agentId: desk.id, reason: 'manual' as const, status: 'running' as const, startedAt: new Date().toISOString() };
  p.state.runs.unshift(busyRun);
  const refused = await api('PATCH', `/projects/${p.id}`, { provider: 'claude' });
  assert.equal(refused.status, 409);
  assert.equal(p.meta.provider, 'gpt');
  p.state.runs = p.state.runs.filter((r) => r.id !== busyRun.id);
  const ok = await api('PATCH', `/projects/${p.id}`, { provider: 'claude' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(p.meta.provider, undefined, 'Claude is the default: nothing written down');
  assert.equal(desk.sessionId, undefined);
  assert.equal(desk.sessionKey, undefined);
  assert.match(p.state.activity[0]?.text ?? '', /now runs on Claude/);
  assert.equal((await api('PATCH', `/projects/${p.id}`, { provider: 'gpt' })).status, 200);
  assert.equal(p.meta.provider, 'gpt');
  assert.equal((await api('PATCH', `/projects/${p.id}`, { provider: 'gemini' })).status, 400);
  // The same answer again changes nothing, so it never waits for runs.
  p.state.runs.unshift(busyRun);
  assert.equal((await api('PATCH', `/projects/${p.id}`, { provider: 'gpt' })).status, 200);
  p.state.runs = p.state.runs.filter((r) => r.id !== busyRun.id);
});

test('a new project takes its model; desks have none of their own', async () => {
  const made = await api('POST', '/projects', { name: 'Gpt Lab', key: 'GL', template: 'blank', provider: 'gpt' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.provider, 'gpt');
  const plain = await api('POST', '/projects', { name: 'Plain Lab', key: 'PL', template: 'blank' });
  assert.equal(plain.body.provider, undefined, 'Claude by default');
  const desks = await api('POST', `/projects/${p.id}/agents`, { name: 'Zed', role: 'Writer', provider: 'gpt' });
  assert.equal(desks.status, 201);
  assert.equal('provider' in desks.body, false, 'a desk has no model of its own');
});

test('meta: live on ChatGPT, with GPT ready and the Claude login missing', () => {
  const m = runner.meta();
  assert.equal(m.runner, 'live');
  assert.equal(m.liveReady, true);
  assert.equal(m.auth, 'none');
  assert.deepEqual({ optedIn: m.gpt.optedIn, ready: m.gpt.ready }, { optedIn: true, ready: true });
});

// ---------- connections and the web ----------

test('connections as Codex settings: programs, online servers and tokens; secrets only in variables', () => {
  const allowed = ['tester', 'tokened', 'claude.ai Docs', 'oldsse'].map((name) => ({ name, key: name.replace(/[^A-Za-z0-9_-]/g, '_'), mode: 'ask' as const, tools: {} }));
  const servers = {
    tester: { type: 'stdio' as const, command: 'C:\\Program Files\\node.exe', args: ['x.js', 'say "hi"'], env: { TESTER_TOKEN: 'abc123' } },
    tokened: { type: 'http' as const, url: 'https://api.example.test/mcp/', headers: { Authorization: 'Bearer secret-xyz', 'X-Team': 't1' } },
    'claude.ai Docs': { type: 'claudeai-proxy', url: 'https://x', id: 'y' } as never,
    oldsse: { type: 'sse' as const, url: 'https://sse.example.test/sse' },
  };
  const out = codexMcp(servers, allowed, { toolTimeoutMs: 900_000, base: { PATH: 'C:\\Windows' } });
  assert.deepEqual(out.config, [
    'mcp_servers.tester.command="C:\\\\Program Files\\\\node.exe"',
    'mcp_servers.tester.args=["x.js","say \\"hi\\""]',
    'mcp_servers.tester.env_vars=["TESTER_TOKEN"]',
    'mcp_servers.tester.default_tools_approval_mode="prompt"',
    'mcp_servers.tester.startup_timeout_sec=30',
    'mcp_servers.tester.tool_timeout_sec=900',
    'mcp_servers.tokened.url="https://api.example.test/mcp/"',
    'mcp_servers.tokened.env_http_headers={"Authorization"="HQ_MCP_TOKENED_AUTHORIZATION_98B8D9D7","X-Team"="HQ_MCP_TOKENED_X_TEAM_08DFE7B6"}',
    'mcp_servers.tokened.default_tools_approval_mode="prompt"',
    'mcp_servers.tokened.startup_timeout_sec=30',
    'mcp_servers.tokened.tool_timeout_sec=900',
  ]);
  assert.deepEqual(out.env, { TESTER_TOKEN: 'abc123', HQ_MCP_TOKENED_AUTHORIZATION_98B8D9D7: 'Bearer secret-xyz', HQ_MCP_TOKENED_X_TEAM_08DFE7B6: 't1' });
  assert.ok(!out.config.join(' ').includes('secret-xyz') && !out.config.join(' ').includes('abc123'), 'no secret on a command line');
  assert.deepEqual(out.allowed.map((a) => a.name), ['tester', 'tokened']);
  assert.deepEqual(out.skipped.map((x) => x.name), ['claude.ai Docs', 'oldsse']);
  assert.match(gptUnsupported({ type: 'claudeai-proxy' }) ?? '', /only works on Claude/);
});

test("connections that would change Codex itself, or clash, are left out with a reason", () => {
  const allowed = ['a', 'b', 'c'].map((name) => ({ name, key: name, mode: 'ask' as const, tools: {} }));
  const out = codexMcp(
    {
      a: { command: 'x', env: { SHARED: '1' } },
      b: { command: 'y', env: { SHARED: '2' } },
      c: { command: 'z', env: { OPENAI_API_KEY: 'sk-1' } },
    },
    allowed,
  );
  assert.deepEqual(out.allowed.map((x) => x.name), ['a']);
  assert.match(out.skipped.find((x) => x.name === 'b')?.why ?? '', /sets SHARED differently/);
  assert.match(out.skipped.find((x) => x.name === 'c')?.why ?? '', /OPENAI_API_KEY, which Codex reads itself/);
  assert.equal(out.env.OPENAI_API_KEY, undefined);
});

test("a connection named hq is left out: HQ's own tools carry that name", () => {
  const out = codexMcp({ hq: { command: 'node', args: ['evil.js'] }, tester: { command: 'node' } }, [
    { name: 'hq', key: 'hq', mode: 'read', tools: {} },
    { name: 'tester', key: 'tester', mode: 'ask', tools: {} },
  ]);
  assert.deepEqual(out.skipped, [{ name: 'hq', why: "hq is HQ's own name" }]);
  assert.ok(!out.config.some((c) => c.startsWith('mcp_servers.hq.')));
  assert.deepEqual(out.allowed.map((a) => a.name), ['tester']);
});

test('header variables: my-api and my_api get their own, each with its own value', () => {
  const out = codexMcp(
    {
      'my-api': { type: 'http', url: 'https://third-party.example/mcp', headers: { Authorization: 'Bearer TOKEN-FOR-MY-API' } },
      my_api: { type: 'http', url: 'https://internal.example/mcp', headers: { Authorization: 'Bearer TOKEN-FOR-INTERNAL' } },
    },
    [
      { name: 'my-api', key: 'my-api', mode: 'ask', tools: {} },
      { name: 'my_api', key: 'my_api', mode: 'ask', tools: {} },
    ],
  );
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.env, { HQ_MCP_MY_API_AUTHORIZATION_605C39F2: 'Bearer TOKEN-FOR-MY-API', HQ_MCP_MY_API_AUTHORIZATION_73D83EED: 'Bearer TOKEN-FOR-INTERNAL' });
  assert.ok(out.config.includes('mcp_servers.my-api.env_http_headers={"Authorization"="HQ_MCP_MY_API_AUTHORIZATION_605C39F2"}'));
  assert.ok(out.config.includes('mcp_servers.my_api.env_http_headers={"Authorization"="HQ_MCP_MY_API_AUTHORIZATION_73D83EED"}'));
});

test("a connection's variables only add to Codex's environment: PATH, proxies, HQ's own values and case clashes are left out", () => {
  const one = (env: Record<string, string>, base: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'win32') =>
    codexMcp({ a: { command: 'node', env } }, [{ name: 'a', key: 'a', mode: 'ask', tools: {} }], { base, platform });
  const path1 = one({ PATH: 'C:\\only-this' }, { Path: 'C:\\Windows' });
  assert.equal(path1.skipped[0]?.why, 'it sets PATH, which would change Codex itself and every other connection');
  assert.deepEqual(path1.env, {});
  assert.match(one({ https_proxy: 'http://proxy.test:8080' }).skipped[0]?.why ?? '', /it sets https_proxy, which would change Codex itself/);
  assert.match(one({ NODE_EXTRA_CA_CERTS: 'C:\\ca.pem' }).skipped[0]?.why ?? '', /NODE_EXTRA_CA_CERTS/);
  assert.match(one({ TEMP: 'C:\\t' }).skipped[0]?.why ?? '', /it sets TEMP/, "TEMP is on Codex's list for every server, set or not");
  // HQ's own value, as it is: nothing changes, so it is fine, and Codex passes it on from its own environment.
  const same = one({ GITHUB_TOKEN: 'ghp_same', PATH: 'C:\\Windows' }, { GITHUB_TOKEN: 'ghp_same', Path: 'C:\\Windows' });
  assert.deepEqual(same.skipped, []);
  assert.deepEqual(same.env, {});
  assert.ok(same.config.includes('mcp_servers.a.env_vars=["GITHUB_TOKEN","PATH"]'));
  assert.match(one({ GITHUB_TOKEN: 'ghp_other' }, { GITHUB_TOKEN: 'ghp_mine' }).skipped[0]?.why ?? '', /GITHUB_TOKEN, which HQ's own environment has with another value/);
  // Windows reads Api_Key and API_KEY as one variable.
  const two = (platform: NodeJS.Platform) =>
    codexMcp(
      { a: { command: 'x', env: { Api_Key: '1' } }, b: { command: 'y', env: { API_KEY: '2' } } },
      [
        { name: 'a', key: 'a', mode: 'ask', tools: {} },
        { name: 'b', key: 'b', mode: 'ask', tools: {} },
      ],
      { base: {}, platform },
    );
  assert.equal(two('win32').skipped[0]?.why, 'another connection sets API_KEY differently');
  assert.deepEqual(two('linux').skipped, []);
  // And the app-server's own environment never takes a connection's value over its own.
  const env = codexServer.appServerEnv({ PATH: 'C:\\x', NEW_ONE: '1' }, { Path: 'C:\\Windows' }, 'win32');
  assert.deepEqual(env, { Path: 'C:\\Windows', NEW_ONE: '1' });
});

test('which call an approval is about: by its arguments, then by the tool the message names; never a guess', () => {
  const call = (id: string, tool: string, args: unknown) => ({ id, type: 'mcpToolCall', status: 'inProgress', server: 's', tool, arguments: args });
  const read = call('A', 'get_frame', {});
  const change = call('B', 'create_thing', { title: 'Launch' });
  assert.equal(codex.mcpCallFor([read, change], {}, 'get_frame')?.id, 'A');
  assert.equal(codex.mcpCallFor([read, change], { title: 'Launch' }, 'create_thing')?.id, 'B');
  // Same arguments: the message's tool name tells them apart; a title that is no tool's name doesn't.
  const other = call('C', 'create_thing', {});
  assert.equal(codex.mcpCallFor([read, other], {}, 'create_thing')?.id, 'C');
  assert.equal(codex.mcpCallFor([read, other], {}, 'Create a thing'), null);
  // Keys in another order are the same arguments; the very same call twice answers the oldest.
  assert.equal(codex.mcpCallFor([call('D', 't', { a: 1, b: [1, { c: 2 }] })], { b: [1, { c: 2 }], a: 1 }, undefined)?.id, 'D');
  assert.equal(codex.mcpCallFor([call('E', 't', { x: 1 }), call('F', 't', { x: 1 })], { x: 1 }, 't')?.id, 'E');
  assert.equal(codex.mcpCallFor([call('G', 't', { x: 1 })], { x: 2 }, 't'), null, 'other arguments: not this call');
  assert.equal(codex.mcpCallFor([], {}, 't'), null);
});

/** Turn a connection on for the GPT desk, in this mode. */
function connect(name: string, mode: 'ask' | 'read' | 'auto') {
  p.state.connections = p.state.connections.filter((c) => c.name !== name);
  p.state.connections.push({ name, source: 'user', enabled: true, desks: [desk.id], mode });
}

/** A connection tool call as Codex runs it: started, its approval asked, then ended as HQ answered. */
async function mcpCall(f: Fake, id: string, server: string, tool: string, args: Record<string, unknown>, content: unknown[] = [{ type: 'text', text: 'ok' }]) {
  f.emit('item/started', { threadId: 'th', turnId: 'tu-1', item: { type: 'mcpToolCall', id, server, tool, status: 'inProgress', arguments: args, result: null, error: null } });
  const answer = await f.ask('mcpServer/elicitation/request', {
    threadId: 'th',
    turnId: 'tu-1',
    serverName: server,
    mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: args },
    message: `Allow the ${server} MCP server to run tool "${tool}"?`,
    requestedSchema: { type: 'object', properties: {} },
  });
  const ok = answer.action === 'accept';
  f.emit('item/completed', {
    threadId: 'th',
    turnId: 'tu-1',
    item: { type: 'mcpToolCall', id, server, tool, status: ok ? 'completed' : 'failed', arguments: args, result: ok ? { content } : null, error: ok ? null : { message: 'user rejected MCP tool call' } },
  });
  return answer.action as string;
}

// 1x1 PNG, as a connected tool's screenshot.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

test('a GPT desk uses its connections: reads run, changes wait on Ask with the reason told, pictures can be attached', async () => {
  connect('tester', 'ask');
  connect('oldsse', 'ask');
  const item = ticket(desk.id);
  const answers: string[] = [];
  let steered = '';
  scenario = (f, method, params) => {
    if (method === 'turn/steer') {
      steered = params.input?.[0]?.text ?? '';
      return {};
    }
    return deskTurn(async (ff) => {
      answers.push(await mcpCall(ff, 'm1', 'tester', 'get_frame', {}, [{ type: 'text', text: 'here' }, { type: 'image', data: PNG, mimeType: 'image/png' }]));
      answers.push(await mcpCall(ff, 'm2', 'tester', 'create_thing', { title: 'Launch' }));
      const comment = await call(ff, 'comment_on_ticket', { text: 'Here is the frame.', screenshots: 1 });
      assert.equal(comment.success, true, JSON.stringify(comment));
      await call(ff, 'report_done', { summary: 'Looked at the frame and asked before creating anything.' });
      return { status: 'completed' };
    })(f, method, params);
  };
  runner.kickoff(p, item.id, 'manual');
  await idle();
  assert.equal(runOf(item).status, 'done', runOf(item).error);
  assert.deepEqual(answers, ['accept', 'decline']);
  assert.match(steered, /^HQ refused create_thing on tester: create_thing would post or change something on tester/);
  const f = servers.at(-1)!;
  assert.ok(f.opts.config?.includes('mcp_servers.tester.command="node"'));
  assert.ok(f.opts.config?.includes('mcp_servers.tester.default_tools_approval_mode="prompt"'));
  assert.equal(f.opts.env?.TESTER_TOKEN, 'abc123', 'the variable travels in the environment');
  const dev = f.calls.find((c) => c.method === 'thread/start' || c.method === 'thread/resume')!.params.developerInstructions as string;
  assert.match(dev, /mcp__<connection>__<tool>/);
  assert.match(dev, /Not available to you here: oldsse \(an SSE server/);
  assert.match(dev, /You can search the web/);
  const attached = item.comments?.find((c) => c.text === 'Here is the frame.');
  assert.equal(attached?.attachments?.length, 1, 'the screenshot went on the comment');
  p.state.connections = [];
});

test('Auto runs a change and logs it; Read only runs a read and refuses a change', async () => {
  connect('tester', 'auto');
  // Claude's check listed tester's tools: Auto's delete check has what it needs.
  p.state.checks.tester = { state: 'connected', checkedAt: new Date().toISOString(), tools: ['create_thing', 'delete_thing', 'list_things'].map((name) => ({ name, reads: name === 'list_things' })) };
  const item = ticket(desk.id);
  const answers: string[] = [];
  scenario = deskTurn(async (f) => {
    answers.push(await mcpCall(f, 'a1', 'tester', 'create_thing', { title: 'Launch plan' }));
    answers.push(await mcpCall(f, 'a2', 'tester', 'delete_thing', { id: '7' }));
    await call(f, 'report_done', { summary: 'Created the launch plan on tester for you.' });
    return { status: 'completed' };
  });
  runner.kickoff(p, item.id, 'manual');
  await idle();
  assert.deepEqual(answers, ['accept', 'decline'], 'a delete still waits, even on Auto');
  assert.ok(p.state.activity.some((a) => /Changed something on tester with create_thing \(title: Launch plan\)/.test(a.text)), 'the auto change is in the activity feed');

  connect('tester', 'read');
  const second = ticket(desk.id);
  const more: string[] = [];
  scenario = deskTurn(async (f) => {
    more.push(await mcpCall(f, 'r1', 'tester', 'list_things', {}));
    more.push(await mcpCall(f, 'r2', 'tester', 'create_thing', { title: 'x' }));
    await call(f, 'report_done', { summary: 'Read the list of things on tester for you.' });
    return { status: 'completed' };
  });
  runner.kickoff(p, second.id, 'manual');
  await idle();
  assert.deepEqual(more, ['accept', 'decline']);
  p.state.connections = [];
  delete p.state.checks.tester;
});

/** An approval request as Codex sends it for a connection's tool call. */
const approval = (server: string, tool: string, args: unknown) => ({
  threadId: 'th',
  turnId: 'tu-1',
  serverName: server,
  mode: 'form',
  _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: args },
  message: `Allow the ${server} MCP server to run tool "${tool}"?`,
  requestedSchema: { type: 'object', properties: {} },
});
const started = (id: string, server: string, tool: string, args: unknown) => ({
  threadId: 'th',
  turnId: 'tu-1',
  item: { type: 'mcpToolCall', id, server, tool, status: 'inProgress', arguments: args, result: null, error: null },
});

test('two calls in flight on one server each get their own verdict: the read runs, the change waits', async () => {
  connect('tester', 'ask');
  const item = ticket(desk.id);
  const got: Record<string, string> = {};
  scenario = deskTurn(async (f) => {
    // Both started before either approval: the newest is the change, the first approval is the read's.
    f.emit('item/started', started('A', 'tester', 'get_frame', {}));
    f.emit('item/started', started('B', 'tester', 'create_thing', { title: 'Launch' }));
    got.A = (await f.ask('mcpServer/elicitation/request', approval('tester', 'get_frame', {}))).action;
    got.B = (await f.ask('mcpServer/elicitation/request', approval('tester', 'create_thing', { title: 'Launch' }))).action;
    // The same arguments: the tool the message names tells them apart.
    f.emit('item/started', started('C', 'tester', 'create_thing', {}));
    f.emit('item/started', started('D', 'tester', 'list_things', {}));
    got.D = (await f.ask('mcpServer/elicitation/request', approval('tester', 'list_things', {}))).action;
    got.C = (await f.ask('mcpServer/elicitation/request', approval('tester', 'create_thing', {}))).action;
    await call(f, 'report_done', { summary: 'Looked at the frame and asked before creating anything.' });
    return { status: 'completed' };
  });
  runner.kickoff(p, item.id, 'manual');
  await idle();
  assert.deepEqual(got, { A: 'accept', B: 'decline', D: 'accept', C: 'decline' });
  p.state.connections = [];
});

test("a form or page a server asks for gets no; an approval HQ can't tie to a running call gets no", async () => {
  connect('tester', 'auto');
  p.state.checks.tester = { state: 'connected', checkedAt: new Date().toISOString(), tools: [{ name: 'create_thing', reads: false }] };
  const item = ticket(desk.id);
  const answers: string[] = [];
  scenario = deskTurn(async (f) => {
    answers.push((await f.ask('mcpServer/elicitation/request', { serverName: 'tester', mode: 'url', url: 'https://x.test', message: 'Open this', _meta: null, elicitationId: 'e1' })).action);
    answers.push((await f.ask('mcpServer/elicitation/request', { serverName: 'tester', mode: 'form', message: 'Allow it?', _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: {} })).action);
    // A change Auto would run, but no call of it has started: HQ judges calls, never a message alone.
    answers.push((await f.ask('mcpServer/elicitation/request', approval('tester', 'create_thing', { title: 'Plan' }))).action);
    // Two different calls with the same arguments, and a tool title that is neither's name: no guess.
    f.emit('item/started', started('X', 'tester', 'create_thing', {}));
    f.emit('item/started', started('Y', 'tester', 'list_things', {}));
    answers.push((await f.ask('mcpServer/elicitation/request', approval('tester', 'Create a thing', {}))).action);
    await call(f, 'report_done', { summary: 'Nothing to do on tester this time.' });
    return { status: 'completed' };
  });
  runner.kickoff(p, item.id, 'manual');
  await idle();
  assert.deepEqual(answers, ['decline', 'decline', 'decline', 'decline']);
  assert.ok(!p.state.activity.some((a) => /Changed something on tester/.test(a.text) && /Plan/.test(a.text)), 'nothing was logged as changed');
  p.state.connections = [];
  delete p.state.checks.tester;
});

test('a server named hq gets no to every call: the guard lets mcp__hq__ through as HQ\'s own', async () => {
  const item = ticket(desk.id);
  let answer = '';
  scenario = deskTurn(async (f) => {
    f.emit('item/started', started('H1', 'hq', 'delete_everything', { id: '1' }));
    answer = (await f.ask('mcpServer/elicitation/request', approval('hq', 'delete_everything', { id: '1' }))).action;
    await call(f, 'report_done', { summary: 'Nothing to do on hq this time at all.' });
    return { status: 'completed' };
  });
  runner.kickoff(p, item.id, 'manual');
  await idle();
  assert.equal(answer, 'decline');
});

test('Auto with tool hints from Codex: changes run, a destructive one waits; with no hints at all, Auto acts as Ask', async () => {
  mcpAuth.setGptLoginTestHooks();
  // webby is signed in only for GPT: Claude's check has no tools for it, Codex's has them with their hints.
  scenario = (_f, method) =>
    method === 'mcpServerStatus/list'
      ? {
          data: [
            {
              name: 'webby',
              authStatus: 'oAuth',
              tools: {
                update_card: { name: 'update_card', inputSchema: {}, annotations: { destructiveHint: false } },
                sync_board: { name: 'sync_board', inputSchema: {}, annotations: { destructiveHint: true } },
              },
            },
          ],
          nextCursor: null,
        }
      : {};
  await mcpAuth.checkGptLogins(p, [{ name: 'webby', config: { type: 'http', url: 'https://mcp.example.test/mcp' } }]);
  assert.equal(mcpAuth.gptToolHints(p.id, 'webby', { type: 'http', url: 'https://mcp.example.test/mcp' })?.sync_board?.destructive, true);
  assert.equal(mcpAuth.gptToolHints(p.id, 'webby', { type: 'http', url: 'https://elsewhere.test/mcp' }), undefined, 'hints are for the URL they came from');
  connect('webby', 'auto');
  const item = ticket(desk.id);
  const answers: string[] = [];
  let steered = '';
  let dev = '';
  const turn = deskTurn(async (f) => {
    answers.push(await mcpCall(f, 'w1', 'webby', 'update_card', { id: 1, title: 'New title' }));
    answers.push(await mcpCall(f, 'w2', 'webby', 'sync_board', { board: 'b1' }));
    await call(f, 'report_done', { summary: 'Updated the card on webby for you.' });
    return { status: 'completed' };
  });
  scenario = (f, method, params) => {
    if (method === 'turn/steer') {
      steered = params.input?.[0]?.text ?? '';
      return {};
    }
    if (method === 'thread/start' || method === 'thread/resume') dev = params.developerInstructions;
    return turn(f, method, params);
  };
  runner.kickoff(p, item.id, 'manual');
  await idle();
  assert.deepEqual(answers, ['accept', 'decline']);
  assert.match(steered, /webby marks sync_board as able to overwrite or delete/);
  assert.doesNotMatch(dev, /Auto acts as Ask/);

  // tester: a program Claude never checked and Codex has no hints for. Auto can't tell its deletes, so it asks.
  p.state.connections = [];
  connect('tester', 'auto');
  const second = ticket(desk.id);
  const more: string[] = [];
  const turn2 = deskTurn(async (f) => {
    more.push(await mcpCall(f, 't1', 'tester', 'list_things', {}));
    more.push(await mcpCall(f, 't2', 'tester', 'create_thing', { title: 'x' }));
    await call(f, 'report_done', { summary: 'Read the list of things on tester for you.' });
    return { status: 'completed' };
  });
  scenario = (f, method, params) => {
    if (method === 'turn/steer') {
      steered = params.input?.[0]?.text ?? '';
      return {};
    }
    if (method === 'thread/start' || method === 'thread/resume') dev = params.developerInstructions;
    return turn2(f, method, params);
  };
  runner.kickoff(p, second.id, 'manual');
  await idle();
  assert.deepEqual(more, ['accept', 'decline']);
  assert.match(steered, /^HQ refused create_thing on tester: create_thing would post or change something on tester as the founder, so it needs approval first/);
  assert.match(dev, /- Auto acts as Ask on tester until HQ knows its tools \(press Check on the Connections page\)\./);
  assert.match(dev, /A rejected connection call that would change something needs approval: put exactly what you would do in a report under reports\//);
  assert.ok(!p.state.activity.some((a) => /Changed something on tester with create_thing \(title: x\)/.test(a.text)));
  p.state.connections = [];
  mcpAuth.setGptLoginTestHooks();
});

test("a GPT project's Connections rows: what works on GPT, what needs a sign-in for GPT, what is Claude only", async () => {
  mcpAuth.setGptLoginTestHooks();
  let rows = (await api('GET', `/projects/${p.id}/connections`)).body.rows as { name: string; gpt?: { state: string; why?: string } }[];
  const gpt = (name: string) => rows.find((r) => r.name === name)?.gpt;
  assert.equal(gpt('tester')?.state, 'ready');
  assert.equal(gpt('tokened')?.state, 'ready');
  assert.equal(gpt('webby')?.state, 'unchecked');
  assert.equal(gpt('oldsse')?.state, 'claude-only');
  // Check asks Codex which servers wait for a sign-in: only the one with nothing to sign in with.
  scenario = (_f, method) => (method === 'mcpServerStatus/list' ? { data: [{ name: 'webby', authStatus: 'notLoggedIn' }] } : {});
  const before = servers.length;
  await mcpAuth.checkGptLogins(p, [
    { name: 'webby', config: { type: 'http', url: 'https://mcp.example.test/mcp' } },
    { name: 'tokened', config: { type: 'http', url: 'https://api.example.test/mcp/', headers: { Authorization: 'Bearer secret-xyz' } } },
    { name: 'tester', config: { type: 'stdio', command: 'node' } },
  ]);
  assert.equal(servers.length, before + 1);
  const cfg = servers.at(-1)!.opts.config ?? [];
  assert.ok(cfg.some((c) => c.startsWith('mcp_servers.webby.url=')) && !cfg.some((c) => c.includes('tokened') || c.includes('tester')), 'only the browser sign-in server is asked about');
  rows = (await api('GET', `/projects/${pc.id}/connections`)).body.rows;
  assert.equal(rows.find((r) => r.name === 'webby')?.gpt, undefined, 'a Claude project shows no GPT line');
  rows = (await api('GET', `/projects/${p.id}/connections`)).body.rows;
  assert.equal(gpt('webby')?.state, 'needs-login');
  // What Codex says it can't tell is not checked; a server with no sign-in to speak of just works.
  for (const [auth, state] of [
    ['unknown', 'unchecked'],
    ['unsupported', 'ready'],
    ['bearerToken', 'ready'],
    ['oAuth', 'signed-in'],
  ]) {
    scenario = (_f, method) => (method === 'mcpServerStatus/list' ? { data: [{ name: 'webby', authStatus: auth }] } : {});
    await mcpAuth.checkGptLogins(p, [{ name: 'webby', config: { type: 'http', url: 'https://mcp.example.test/mcp' } }]);
    rows = (await api('GET', `/projects/${p.id}/connections`)).body.rows;
    assert.equal(gpt('webby')?.state, state, auth);
  }
  // A program a desk run would leave out (it sets a variable Codex reads itself) is Claude only, with the run's reason.
  const info = { name: 'withenv', source: 'user' as const, transport: 'stdio' as const, target: 'node', auth: 'none' as const };
  assert.deepEqual(mcpAuth.gptRowOf(p, info, { command: 'node', env: { OPENAI_API_KEY: 'sk-x' } }), { state: 'claude-only', why: 'it sets OPENAI_API_KEY, which Codex reads itself' });
  assert.deepEqual(mcpAuth.gptRowOf(p, { ...info, name: 'hq' }, { command: 'node' }), { state: 'claude-only', why: "hq is HQ's own name" });
  mcpAuth.setGptLoginTestHooks();
});

test('a Check that asked Codex before a sign-in landed never writes its older answer over it', async () => {
  mcpAuth.setGptLoginTestHooks();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let asked = 0;
  scenario = async (f, method, params) => {
    if (method === 'mcpServerStatus/list') {
      // The sign-in's own look at its server answers at once; the Check read "not signed in" and answers late.
      if (params?.serverName === 'webby') return { data: [{ name: 'webby', authStatus: 'oAuth', tools: {} }], nextCursor: null };
      asked++;
      await gate;
      return { data: [{ name: 'webby', authStatus: 'notLoggedIn' }], nextCursor: null };
    }
    if (method === 'mcpServer/oauth/login') {
      setTimeout(() => f.emit('mcpServer/oauthLogin/completed', { name: 'webby', success: true }), 5);
      return { authorizationUrl: 'https://auth.example.test/a' };
    }
    return {};
  };
  const config = { type: 'http' as const, url: 'https://mcp.example.test/mcp' };
  const checking = mcpAuth.checkGptLogins(p, [{ name: 'webby', config }]);
  for (let i = 0; i < 200 && !asked; i++) await sleep(2);
  mcpAuth.startGptLogin(p, 'webby', config);
  for (let i = 0; i < 200 && mcpAuth.gptLoginOf(p.id, 'webby'); i++) await sleep(5);
  const info = { name: 'webby', source: 'user' as const, transport: 'http' as const, target: config.url, auth: 'oauth' as const };
  assert.equal(mcpAuth.gptRowOf(p, info, config).state, 'signed-in');
  release();
  await checking;
  assert.equal(mcpAuth.gptRowOf(p, info, config).state, 'signed-in', 'the older answer did not land');
  mcpAuth.setGptLoginTestHooks();
});

test('sign in to a server for GPT: the page is shown, the sign-in lands, the row says signed in', async () => {
  mcpAuth.setGptLoginTestHooks();
  let finish!: () => void;
  let timeoutSecs = 0;
  scenario = (f, method, params) => {
    if (method === 'mcpServer/oauth/login') {
      assert.equal(params.name, 'webby');
      timeoutSecs = params.timeoutSecs;
      finish = () => f.emit('mcpServer/oauthLogin/completed', { name: 'webby', threadId: null, success: true });
      return { authorizationUrl: 'https://auth.example.test/authorize?client_id=x', loginId: 'o1' };
    }
    return {};
  };
  const started = await api('POST', `/projects/${p.id}/connections/webby/gpt-login`);
  assert.equal(started.status, 202);
  for (let i = 0; i < 100 && mcpAuth.gptLoginOf(p.id, 'webby')?.state !== 'waiting'; i++) await sleep(2);
  assert.equal(mcpAuth.gptLoginOf(p.id, 'webby')?.authUrl, 'https://auth.example.test/authorize?client_id=x');
  assert.ok(timeoutSecs > 590 && timeoutSecs <= 600, `Codex waits as long as HQ does (${timeoutSecs} s)`);
  assert.equal((await api('POST', `/projects/${p.id}/connections/webby/gpt-login`)).status, 409, 'one sign-in at a time');
  finish();
  for (let i = 0; i < 100 && mcpAuth.gptLoginOf(p.id, 'webby'); i++) await sleep(2);
  const rows = (await api('GET', `/projects/${p.id}/connections`)).body.rows as { name: string; gpt?: { state: string } }[];
  assert.equal(rows.find((r) => r.name === 'webby')?.gpt?.state, 'signed-in');
  for (let i = 0; i < 100 && !servers.at(-1)!.closed; i++) await sleep(2);
  assert.ok(servers.at(-1)!.closed);
  assert.equal((await api('POST', `/projects/${p.id}/connections/nothere/gpt-login`)).status, 404);
  assert.equal((await api('POST', `/projects/${p.id}/connections/tester/gpt-login`)).status, 400, 'a program on this PC has nothing to sign in to');
  assert.equal((await api('POST', `/projects/${p.id}/connections/tokened/gpt-login`)).status, 400, 'a server with a token header has nothing to sign in to');
  assert.equal((await api('POST', `/projects/${pc.id}/connections/webby/gpt-login`)).status, 400, 'a Claude project signs in for Claude');
  mcpAuth.setGptLoginTestHooks();
});

test("a sign-in for GPT that fails never shows the server's own secrets", async () => {
  mcpAuth.setGptLoginTestHooks();
  scenario = (f, method) => {
    if (method === 'mcpServer/oauth/login') {
      setTimeout(() => f.emit('mcpServer/oauthLogin/completed', { name: 'webby', success: false, error: 'refused https://mcp.example.test/mcp?key=sekrit-123 for sekrit-123' }), 5);
      return { authorizationUrl: 'https://auth.example.test/a' };
    }
    return {};
  };
  mcpAuth.startGptLogin(p, 'webby', { type: 'http', url: 'https://mcp.example.test/mcp?key=sekrit-123' });
  for (let i = 0; i < 200 && mcpAuth.gptLoginOf(p.id, 'webby')?.state !== 'failed'; i++) await sleep(2);
  const failed = mcpAuth.gptLoginOf(p.id, 'webby');
  assert.equal(failed?.state, 'failed');
  assert.match(failed?.error ?? '', /^Signing in failed: refused/);
  assert.ok(!failed?.error?.includes('sekrit-123'), failed?.error);
  mcpAuth.setGptLoginTestHooks();
});

test('sign out for GPT: Codex logs out of that server, the row needs a sign-in again; removing a server signs out too', async () => {
  mcpAuth.setGptLoginTestHooks();
  const ran: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  codexServer.setCodexRunForTests(async (args, env) => {
    ran.push({ args, env });
    return { code: 0, out: "Removed OAuth credentials for 'webby'.", err: '', timedOut: false, truncated: false };
  });
  const creds = path.join(root, 'data', '.codex', '.credentials.json');
  const config = { type: 'http' as const, url: 'https://mcp.example.test/mcp' };
  const gptOf = async (name: string) => ((await api('GET', `/projects/${p.id}/connections`)).body.rows as { name: string; gpt?: { state: string } }[]).find((r) => r.name === name)?.gpt;
  try {
    scenario = (_f, method) => (method === 'mcpServerStatus/list' ? { data: [{ name: 'webby', authStatus: 'oAuth', tools: { x: { name: 'x' } } }] } : {});
    await mcpAuth.checkGptLogins(p, [{ name: 'webby', config }]);
    assert.equal((await gptOf('webby'))?.state, 'signed-in');
    // Codex holds no sign-ins at all yet: nothing to run.
    assert.equal((await api('POST', `/projects/${p.id}/connections/webby/gpt-logout`)).status, 200);
    assert.equal(ran.length, 0);
    assert.equal((await gptOf('webby'))?.state, 'needs-login');
    // With Codex's sign-ins file: `codex mcp logout` for that server's id, with its settings, in HQ's Codex home.
    fs.writeFileSync(creds, '{}');
    await mcpAuth.checkGptLogins(p, [{ name: 'webby', config }]);
    const out = await api('POST', `/projects/${p.id}/connections/webby/gpt-logout`);
    assert.equal(out.status, 200);
    assert.equal(ran.length, 1);
    const args = ran[0].args;
    assert.deepEqual(args.slice(0, 2), ['mcp', 'logout']);
    assert.deepEqual(args.slice(-2), ['--', 'webby']);
    assert.ok(args.includes('mcp_servers.webby.url="https://mcp.example.test/mcp"') && args.includes('mcp_oauth_credentials_store="file"'));
    assert.equal(ran[0].env.CODEX_HOME, path.join(root, 'data', '.codex'));
    assert.equal((out.body.rows as { name: string; gpt?: { state: string } }[]).find((r) => r.name === 'webby')?.gpt?.state, 'needs-login');
    assert.equal(mcpAuth.gptToolHints(p.id, 'webby', config), undefined, 'its tool hints are gone too');
    assert.ok(p.state.activity.some((a) => a.text === 'Signed out of webby for GPT desks'));
    // What Codex says when it can't is shown, the server's secrets blanked.
    codexServer.setCodexRunForTests(async () => ({ code: 1, out: '', err: 'WARNING: proceeding, even though we could not create PATH aliases\nError: store locked for secret-xyz', timedOut: false, truncated: false }));
    await assert.rejects(
      mcpAuth.codexLogout('webby', { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer secret-xyz' } }),
      (e: Error) => /^Codex could not sign out of webby: store locked for /.test(e.message) && !e.message.includes('secret-xyz') && !e.message.includes('PATH aliases'),
    );
    codexServer.setCodexRunForTests(async (args, env) => {
      ran.push({ args, env });
      return { code: 0, out: '', err: '', timedOut: false, truncated: false };
    });
    // Only GPT projects, and only a server you sign in to in a browser.
    assert.equal((await api('POST', `/projects/${pc.id}/connections/webby/gpt-logout`)).status, 400);
    assert.equal((await api('POST', `/projects/${p.id}/connections/tester/gpt-logout`)).status, 400);
    // Removed: a GPT sign-in running for it stops, what Codex said goes, and Codex signs out, unless a project still has it.
    ran.length = 0;
    await mcpAuth.checkGptLogins(p, [{ name: 'webby', config }]);
    scenario = (_f, method) => (method === 'mcpServer/oauth/login' ? { authorizationUrl: 'https://auth.example.test/a' } : {});
    mcpAuth.startGptLogin(p, 'webby', config);
    for (let i = 0; i < 100 && mcpAuth.gptLoginOf(p.id, 'webby')?.state !== 'waiting'; i++) await sleep(2);
    assert.equal(await conns.dropGptSignIn(p, 'webby', config, false), null);
    assert.equal(mcpAuth.gptLoginOf(p.id, 'webby'), undefined, 'the sign-in stopped');
    assert.equal(ran.length, 0, 'webby is still set up for every project, so its sign-in stays');
    assert.equal((await gptOf('webby'))?.state, 'unchecked', 'what Codex said is forgotten');
    const gone = { type: 'http' as const, url: 'https://gone.example.test/mcp' };
    assert.equal(await conns.dropGptSignIn(p, 'gone-srv', gone, true), null);
    assert.equal(ran.length, 1);
    assert.deepEqual(ran[0].args.slice(-2), ['--', 'gone-srv']);
    codexServer.setCodexRunForTests(async () => ({ code: 1, out: '', err: 'Error: disk full', timedOut: false, truncated: false }));
    assert.match((await conns.dropGptSignIn(p, 'gone-srv', gone, true)) ?? '', /^Removed, but Codex could not sign out of gone-srv: disk full\./);
    assert.equal(await conns.dropGptSignIn(p, 'prog', { command: 'node' }, false), null, 'a program has no sign-in');
  } finally {
    codexServer.setCodexRunForTests(null);
    fs.rmSync(creds, { force: true });
    mcpAuth.setGptLoginTestHooks();
  }
});

test('a sign-in page that is not a web page is never shown; cancel ends the sign-in', async () => {
  mcpAuth.setGptLoginTestHooks();
  scenario = (_f, method) => (method === 'mcpServer/oauth/login' ? { authorizationUrl: 'javascript:alert(1)' } : {});
  mcpAuth.startGptLogin(p, 'webby', { type: 'http', url: 'https://mcp.example.test/mcp' });
  for (let i = 0; i < 100 && mcpAuth.gptLoginOf(p.id, 'webby')?.state !== 'failed'; i++) await sleep(2);
  assert.equal(mcpAuth.gptLoginOf(p.id, 'webby')?.state, 'failed');
  assert.equal(mcpAuth.gptLoginOf(p.id, 'webby')?.authUrl, undefined);
  mcpAuth.setGptLoginTestHooks();
  scenario = (_f, method) => (method === 'mcpServer/oauth/login' ? { authorizationUrl: 'https://auth.example.test/a' } : {});
  mcpAuth.startGptLogin(p, 'webby', { type: 'http', url: 'https://mcp.example.test/mcp' });
  for (let i = 0; i < 100 && mcpAuth.gptLoginOf(p.id, 'webby')?.state !== 'waiting'; i++) await sleep(2);
  const f = servers.at(-1)!;
  assert.equal((await api('DELETE', `/projects/${p.id}/connections/webby/gpt-login`)).status, 200);
  for (let i = 0; i < 100 && !f.closed; i++) await sleep(2);
  assert.ok(f.closed);
  assert.equal(mcpAuth.gptLoginOf(p.id, 'webby'), undefined);
  mcpAuth.setGptLoginTestHooks();
});

// ---------- signing in ----------

function loginScenario(start: unknown, account: unknown = { account: { type: 'chatgpt', email: 'me@x.test', planType: 'pro' } }): Scenario {
  return (f, method) => {
    if (method === 'account/login/start') {
      setTimeout(() => f.emit('account/login/completed', { loginId: 'L1', success: true, error: null }), 30);
      return start;
    }
    if (method === 'account/read') return account;
    if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300 } } };
    if (method === 'model/list') return { data: [{ id: 'gpt-6.1-sol', displayName: 'Sol', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
    return {};
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 200 && auth.chatGptLogin()?.state !== 'failed' && auth.chatGptLogin(); i++) await new Promise((r) => setTimeout(r, 5));
}

test('sign in on this PC: the page is shown, the login lands, GPT desks may run on it', async () => {
  auth.setChatGptTestHooks();
  settings.setChatGptLogin(false);
  scenario = loginScenario({ type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.openai.com/oauth/authorize?state=1' });
  auth.startChatGptLogin('browser');
  assert.throws(() => auth.startChatGptLogin('device'), /already running/);
  for (let i = 0; i < 100 && auth.chatGptLogin()?.state !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 2));
  // Waiting shows the page; it may already be done by now.
  await settle();
  assert.equal(auth.chatGptLogin(), undefined, 'done');
  assert.deepEqual(auth.chatGptCached().account, { loggedIn: true, email: 'me@x.test', plan: 'pro' });
  assert.ok(auth.gptOptIn(), 'signing in says yes');
  assert.ok(auth.lastChatGptSignIn());
  assert.equal(auth.gptModels()[0]?.id, 'gpt-6.1-sol');
  assert.ok(servers.at(-1)!.closed);
});

test('sign in from another device: the code and OpenAI device page show while it waits', async () => {
  auth.setChatGptTestHooks();
  let finish!: () => void;
  scenario = (f, method) => {
    if (method === 'account/login/start') {
      finish = () => f.emit('account/login/completed', { loginId: 'D1', success: true, error: null });
      return { type: 'chatgptDeviceCode', loginId: 'D1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' };
    }
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'me@x.test', planType: 'plus' } };
    return {};
  };
  auth.startChatGptLogin('device');
  for (let i = 0; i < 100 && auth.chatGptLogin()?.state !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 2));
  const waiting = auth.chatGptLogin()!;
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(waiting.userCode, 'ABCD-1234');
  assert.equal(waiting.authUrl, undefined);
  finish();
  await settle();
  assert.equal(auth.chatGptLogin(), undefined);
});

test('a sign-in page off OpenAI is never shown; cancel tells Codex', async () => {
  auth.setChatGptTestHooks();
  scenario = (_f, method) => (method === 'account/login/start' ? { type: 'chatgpt', loginId: 'L2', authUrl: 'https://evil.test/login' } : {});
  auth.startChatGptLogin('browser');
  for (let i = 0; i < 100 && auth.chatGptLogin()?.state !== 'failed'; i++) await new Promise((r) => setTimeout(r, 2));
  const failed = auth.chatGptLogin()!;
  assert.equal(failed.state, 'failed');
  assert.match(failed.error ?? '', /didn't get a ChatGPT sign-in page/);
  assert.equal(failed.authUrl, undefined);

  auth.setChatGptTestHooks();
  scenario = (_f, method) => (method === 'account/login/start' ? { type: 'chatgpt', loginId: 'L3', authUrl: 'https://auth.openai.com/x' } : {});
  auth.startChatGptLogin('browser');
  for (let i = 0; i < 100 && auth.chatGptLogin()?.state !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 2));
  const f = servers.at(-1)!;
  assert.ok(auth.cancelChatGptLogin());
  for (let i = 0; i < 100 && !f.closed; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(f.methods().includes('account/login/cancel'));
  assert.ok(f.closed);
  assert.equal(auth.chatGptLogin(), undefined);
});

test('sign out: HQ Codex logs out and GPT desks stop running on it', async () => {
  auth.setChatGptTestHooks();
  settings.setChatGptLogin(true);
  const file = auth.chatGptAuthFile();
  // Codex removes its login file on logout.
  scenario = (_f, method) => {
    if (method === 'account/logout') fs.rmSync(file, { force: true });
    return {};
  };
  await auth.signOutChatGpt();
  assert.ok(servers.at(-1)!.methods().includes('account/logout'));
  assert.equal(auth.gptOptIn(), false);
  assert.deepEqual(auth.chatGptCached().account, { loggedIn: false });
  assert.throws(() => auth.useChatGptLogin(true), /Sign in to ChatGPT first/);
  fs.writeFileSync(file, '{}');
  settings.setChatGptLogin(true);
  auth.setChatGptTestHooks();
});

test('a status check that read the login before a sign-out never brings it back', async () => {
  auth.setChatGptTestHooks();
  settings.setChatGptLogin(true);
  const file = auth.chatGptAuthFile();
  let answer!: () => void;
  const held = new Promise<void>((r) => (answer = r));
  let reads = 0;
  scenario = async (_f, method) => {
    if (method === 'account/read') {
      reads++;
      // Codex read the login, but its answer reaches HQ only after the sign-out.
      await held;
      return { account: { type: 'chatgpt', email: 'me@x.test', planType: 'plus' } };
    }
    if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300 } } };
    if (method === 'account/logout') fs.rmSync(file, { force: true });
    return {};
  };
  try {
    const check = auth.checkChatGpt(true);
    for (let i = 0; i < 200 && reads === 0; i++) await sleep(2);
    assert.equal(reads, 1, 'the check is waiting on Codex');
    await auth.signOutChatGpt();
    answer();
    assert.deepEqual(await check, { loggedIn: false }, 'the late answer gives what HQ knows now');
    assert.deepEqual(auth.chatGptCached().account, { loggedIn: false });
    assert.equal(auth.chatGptUsage(), undefined, 'no usage from the login that was');
    assert.equal(auth.hasChatGptLogin(), false);
    assert.equal(auth.gptReady(), false);
    assert.throws(() => auth.useChatGptLogin(true), /Sign in to ChatGPT first/);
  } finally {
    answer();
    fs.writeFileSync(file, '{}');
    settings.setChatGptLogin(true);
    auth.setChatGptTestHooks();
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
await idle().catch(() => undefined);
codexServer.setAppServerForTests(null);
p.flush();
process.chdir(os.tmpdir());
for (const dir of [root, projectDir, outside]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (e) {
    console.warn(`could not remove ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
assert.equal(failed, 0, `${failed} codex case(s) failed`);
console.log(`\nall ${passed} codex cases pass`);
process.exit(0);
