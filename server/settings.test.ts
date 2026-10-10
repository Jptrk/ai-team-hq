/**
 * HQ-wide settings: the effort level for every desk run, and HQ's limits.
 * Runs in a scratch folder: data/settings.json is written there, never in your real data/.
 *   npm run test:settings
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LimitsResponse } from '../shared/limits';
import type { Meta } from '../shared/types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-settings-'));
process.chdir(root);
process.env.HQ_RUNNER = 'sim';

const { parseSettings, settings, setEffort, setLimits } = await import('./settings');
const { router, readSettingsPatch } = await import('./routes');
const { limit, limitsView, readLimitsPatch } = await import('./limits');
const { envLimitWarnings, limitText } = await import('../shared/limits');
const { runLimitsFor } = await import('./runner/claude');
const { defaultLimits } = await import('./chat');
const { meta } = await import('./runner/index');
const { EFFORT_LEVELS, isEffortLevel } = await import('../shared/types');

const FILE = path.join(root, 'data', 'settings.json');
const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);

/** Call the API in-process, as the server does once it has parsed the JSON body. */
function api(method: string, url: string, body: unknown, type = 'application/json'): Promise<{ status: number; body: unknown }> {
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
    const headers: Record<string, string> = { 'content-type': type };
    const req = { method, url, body, headers, query: {}, get: (h: string) => headers[h.toLowerCase()] };
    const handle = router as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
    handle(req, res, (err) => reject(err ?? new Error(`no route for ${method} ${url}`)));
  });
}

test('levels: the five the Agent SDK takes, and nothing else', () => {
  assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const bad of ['', 'High', 'adaptive', 'none', null, undefined, 3, ['low']]) assert.equal(isEffortLevel(bad), false, String(bad));
});

test('file: none yet means the model default, and nothing is written by reading', () => {
  assert.deepEqual(settings(), {});
  assert.equal(meta().effort, null);
  assert.equal(fs.existsSync(FILE), false);
});

test('file: a hand-edited file keeps only a valid effort', () => {
  assert.deepEqual(parseSettings({ effort: 'medium' }), { effort: 'medium' });
  assert.deepEqual(parseSettings({ effort: 'turbo', extra: 1 }), {});
  assert.deepEqual(parseSettings({ effort: 'HIGH' }), {});
  for (const raw of [null, 'high', 42, []]) assert.deepEqual(parseSettings(raw), {});
});

test('file: Pause and a usage hold survive a hand edit only when well formed', () => {
  const at = '2026-10-06T08:00:00.000Z';
  assert.deepEqual(parseSettings({ paused: { at } }), { paused: { at } });
  assert.deepEqual(parseSettings({ paused: true }), {}, 'paused needs a time');
  assert.deepEqual(parseSettings({ paused: { at: 'soon' } }), {});
  const hold = { kind: 'usage', at, text: "Claude's 5-hour limit reached.", until: '2026-10-06T09:00:00.000Z' };
  assert.deepEqual(parseSettings({ usageHolds: { claude: hold } }), { usageHolds: { claude: hold } });
  assert.deepEqual(parseSettings({ usageHolds: { claude: { ...hold, until: 'later' } } }), { usageHolds: { claude: { kind: 'usage', at, text: hold.text } } }, 'a bad reset time is dropped, the hold kept');
  assert.deepEqual(parseSettings({ usageHolds: { gpt: hold, mistral: hold } }), { usageHolds: { gpt: hold } }, 'only known models');
  for (const bad of [{ ...hold, kind: 'quota' }, { ...hold, text: 3 }, { ...hold, at: undefined }, 'usage']) assert.deepEqual(parseSettings({ usageHolds: { claude: bad } }), {}, JSON.stringify(bad));
  // A file from before holds were per model: its one hold goes to the model its words name.
  assert.deepEqual(parseSettings({ usageHold: hold }), { usageHolds: { claude: hold } });
  const gpt = { ...hold, text: "ChatGPT's usage limit reached." };
  assert.deepEqual(parseSettings({ usageHold: gpt }), { usageHolds: { gpt } });
  assert.deepEqual(parseSettings({ usageHold: gpt, usageHolds: { gpt: hold } }), { usageHolds: { gpt: hold } }, 'the per-model one wins');
});

test('file: the Claude login yes survives a hand edit only with a time', () => {
  const at = '2026-10-06T08:00:00.000Z';
  assert.deepEqual(parseSettings({ claudeLogin: { at } }), { claudeLogin: { at } });
  assert.deepEqual(parseSettings({ claudeLogin: { at, token: 'x' } }), { claudeLogin: { at } }, 'nothing else is kept');
  for (const bad of [true, 'yes', { at: 'soon' }, {}, null]) assert.deepEqual(parseSettings({ claudeLogin: bad }), {}, JSON.stringify(bad));
});

test('save: a level is written, read back and shown in meta; null goes back to the default', () => {
  setEffort('low');
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), { effort: 'low' });
  assert.equal(settings().effort, 'low');
  assert.equal(meta().effort, 'low');
  setEffort(null);
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), {});
  assert.equal(meta().effort, null);
  assert.equal(fs.existsSync(`${FILE}.tmp`), false, 'no temp file left behind');
});

test('body: effort must be a level or null', () => {
  assert.deepEqual(readSettingsPatch({ effort: 'xhigh' }), { effort: 'xhigh' });
  assert.deepEqual(readSettingsPatch({ effort: null }), { effort: null });
  assert.match(String(readSettingsPatch({}).error), /Nothing to change/);
  for (const bad of ['', 'turbo', 'High', 1, true, undefined]) assert.match(String(readSettingsPatch({ effort: bad }).error), /effort must be low, medium, high, xhigh or max, or null/, String(bad));
});

test('route: PATCH /settings saves and answers with the new meta; a bad value changes nothing', async () => {
  const ok = await api('PATCH', '/settings', { effort: 'medium' });
  assert.equal(ok.status, 200);
  assert.equal((ok.body as Meta).effort, 'medium');
  assert.equal(settings().effort, 'medium');

  const bad = await api('PATCH', '/settings', { effort: 'turbo' });
  assert.equal(bad.status, 400);
  assert.equal(settings().effort, 'medium');

  for (const body of [[], 'medium', null]) assert.equal((await api('PATCH', '/settings', body)).status, 400, JSON.stringify(body));

  const notJson = await api('PATCH', '/settings', { effort: 'low' }, 'text/plain');
  assert.equal(notJson.status, 415, 'only JSON bodies');
  assert.equal(settings().effort, 'medium');

  const back = await api('PATCH', '/settings', { effort: null });
  assert.equal(back.status, 200);
  assert.equal((back.body as Meta).effort, null);

  const got = await api('GET', '/meta', undefined);
  assert.equal((got.body as Meta).effort, null);
});

test('limits: nothing set is the default, then .env; yours wins over both and null goes back', () => {
  delete process.env.HQ_CHAT_HOP_LIMIT;
  assert.equal(limit('chatHops'), 6);
  assert.deepEqual(limitsView().chatHops, { value: 6, source: 'default', fallback: 6, fallbackSource: 'default' });
  process.env.HQ_CHAT_HOP_LIMIT = '12';
  try {
    assert.deepEqual(limitsView().chatHops, { value: 12, source: 'env', fallback: 12, fallbackSource: 'env' });
    setLimits({ chatHops: 20 });
    assert.deepEqual(limitsView().chatHops, { value: 20, source: 'you', fallback: 12, fallbackSource: 'env' });
    assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).limits, { chatHops: 20 });
    setLimits({ chatHops: null });
    assert.equal(limit('chatHops'), 12);
    assert.equal(settings().limits, undefined, 'no empty limits left in the file');
  } finally {
    delete process.env.HQ_CHAT_HOP_LIMIT;
  }
});

test('limits: a hand-edited file keeps only known limits in range', () => {
  assert.deepEqual(parseSettings({ limits: { chatHops: 9, concurrency: 0, nope: 3, claudeTicketUsd: 2.5, runIdleMs: 'soon' } }), { limits: { chatHops: 9, claudeTicketUsd: 2.5 } });
  for (const bad of ['x', 5, null, {}, [], { chatHops: 101 }]) assert.deepEqual(parseSettings({ limits: bad }), {}, JSON.stringify(bad));
});

test('limits: the body takes values in range or null, and names the limit that is out', () => {
  assert.deepEqual(readLimitsPatch({ chatHops: 10, runIdleMs: null }), { patch: { chatHops: 10, runIdleMs: null } });
  assert.match(String(readLimitsPatch({}).error), /Nothing to change/);
  assert.match(String(readLimitsPatch({ bogus: 1 }).error), /Unknown limit "bogus"/);
  assert.match(String(readLimitsPatch({ chatHops: 0 }).error), /^Desk-to-desk messages per thread must be a whole number from 1 to 100$/);
  assert.match(String(readLimitsPatch({ runTimeoutMs: 60_000 }).error), /from 5 minutes to 1440 minutes/);
  assert.match(String(readLimitsPatch({ runIdleMs: 1 }).error), /^Quiet limit must be a number from 1 minute to 240 minutes$/, 'one minute, not "1 minutes"');
  assert.match(String(readLimitsPatch({ claudeTicketUsd: 0 }).error), /from \$0.1 to \$1000/);
  for (const bad of ['10', true, NaN, Infinity]) assert.ok(readLimitsPatch({ chatHops: bad }).error, String(bad));
});

test('limits: the API refuses a count that is not whole, where .env and a hand-edited file round it down', () => {
  assert.match(String(readLimitsPatch({ huddlesPerDay: 0.9 }).error), /^Huddles per project per day must be a whole number from 0 to 50$/, '0.9 would save as 0: huddles off');
  assert.match(String(readLimitsPatch({ chatHops: 6.5 }).error), /whole number/);
  assert.match(String(readLimitsPatch({ chatHops: 10, concurrency: 2.5 }).error), /^Desks running at once must be a whole number/, 'one bad value and nothing is saved');
  assert.deepEqual(readLimitsPatch({ huddlesPerDay: 3, claudeTicketUsd: 2.5, runIdleMs: 450_000 }), { patch: { huddlesPerDay: 3, claudeTicketUsd: 2.5, runIdleMs: 450_000 } }, 'dollars and times may have a fraction');
  assert.deepEqual(readLimitsPatch({ claudeTicketUsd: 2.555 }), { patch: { claudeTicketUsd: 2.56 } }, 'to the cent');
  assert.deepEqual(parseSettings({ limits: { huddlesPerDay: 0.9 } }), { limits: { huddlesPerDay: 0 } }, 'a hand-edited file is rounded down, as before');
});

test('limits: .env values HQ ignores or pulls into range are said once, with the value that counts', () => {
  assert.deepEqual(envLimitWarnings({}), []);
  assert.deepEqual(envLimitWarnings({ HQ_CONCURRENCY: '4', HQ_RUN_IDLE_MS: '450000', HQ_MAX_BUDGET_USD: '2.5', HQ_CHAT_HOP_LIMIT: '  ', HQ_OTHER: 'x' }), [], 'good, empty or not a limit: nothing to say');
  assert.deepEqual(envLimitWarnings({ HQ_CONCURRENCY: 'lots' }), ["HQ_CONCURRENCY=lots in .env is not a number, so HQ ignores it. Desks running at once: 2, HQ's default."]);
  assert.deepEqual(envLimitWarnings({ HQ_RUN_IDLE_MS: '0' }), ["HQ_RUN_IDLE_MS=0 in .env is 0 or less, so HQ ignores it. Quiet limit: 8 minutes, HQ's default."]);
  assert.deepEqual(envLimitWarnings({ HQ_CONCURRENCY: '40' }), ['HQ_CONCURRENCY=40 in .env is over 16, so HQ takes it as 16. Desks running at once: 16.']);
  assert.deepEqual(envLimitWarnings({ HQ_CHAT_HOP_LIMIT: '0' }), ['HQ_CHAT_HOP_LIMIT=0 in .env is under 1, so HQ takes it as 1. Desk-to-desk messages per thread: 1.']);
  assert.deepEqual(envLimitWarnings({ HQ_HUDDLES_PER_DAY: '0.9' }), ['HQ_HUDDLES_PER_DAY=0.9 in .env is not a whole number, so HQ takes it as 0. Huddles per project per day: 0.']);
  assert.deepEqual(envLimitWarnings({ HQ_RUN_TIMEOUT_MS: '60000' }), ['HQ_RUN_TIMEOUT_MS=60000 in .env is under 5 minutes, so HQ takes it as 5 minutes. Whole run: 5 minutes.']);
  assert.deepEqual(envLimitWarnings({ HQ_MAX_BUDGET_USD: '0' }), ['HQ_MAX_BUDGET_USD=0 in .env is under $0.1, so HQ takes it as $0.1. Budget per ticket run: $0.1.']);
  assert.deepEqual(
    envLimitWarnings({ HQ_CONCURRENCY: 'lots', HQ_QA_MAX_FIXES: '-1' }, { concurrency: 4, qaMaxFixes: 3 }),
    [
      'HQ_CONCURRENCY=lots in .env is not a number, so HQ ignores it. Desks running at once: 4, set on the Accounts page.',
      'HQ_QA_MAX_FIXES=-1 in .env is under 0, so HQ takes it as 0. Fixes after a failed QA check: 3, set on the Accounts page.',
    ],
    'yours wins: it says so',
  );
  assert.equal(limitText('runIdleMs', 60_000), '1 minute');
  assert.equal(limitText('runIdleMs', 450_000), '7.5 minutes');
});

test('runs: a run reads its limits once at its start, for its kind of run', () => {
  setLimits({ claudeTicketTurns: 50, claudeTicketUsd: 4, claudeReplyTurns: 9, claudeReplyUsd: 0.5, claudePlanTurns: 15, claudePlanUsd: 2, runIdleMs: 300_000, toolIdleMs: 600_000, runTimeoutMs: 900_000 });
  try {
    const watch = { idleMs: 300_000, toolIdleMs: 600_000, capMs: 900_000 };
    for (const mode of ['ticket', 'qa'] as const) assert.deepEqual(runLimitsFor(mode, 1000), { deadline: 901_000, watch, maxTurns: 50, maxBudgetUsd: 4 }, mode);
    for (const mode of ['message', 'huddle'] as const) assert.deepEqual(runLimitsFor(mode, 1000), { deadline: 901_000, watch, maxTurns: 9, maxBudgetUsd: 0.5 }, mode);
    assert.deepEqual(runLimitsFor('plan', 1000), { deadline: 901_000, watch, maxTurns: 15, maxBudgetUsd: 2 });
    const started = runLimitsFor('ticket', 1000);
    setLimits({ runTimeoutMs: 1_800_000, claudeTicketTurns: 80 });
    assert.deepEqual(started, { deadline: 901_000, watch, maxTurns: 50, maxBudgetUsd: 4 }, 'a change meanwhile leaves a started run alone');
    assert.equal(runLimitsFor('ticket', 1000).deadline, 1_801_000, 'the next run takes it');
  } finally {
    setLimits({ claudeTicketTurns: null, claudeTicketUsd: null, claudeReplyTurns: null, claudeReplyUsd: null, claudePlanTurns: null, claudePlanUsd: null, runIdleMs: null, toolIdleMs: null, runTimeoutMs: null });
  }
});

test('route: PATCH /limits saves and chat follows at once; GET says where each comes from; a bad body changes nothing', async () => {
  const ok = await api('PATCH', '/limits', { chatHops: 15, chatDailyWakes: 200 });
  assert.equal(ok.status, 200);
  assert.deepEqual((ok.body as LimitsResponse).chatHops, { value: 15, source: 'you', fallback: 6, fallbackSource: 'default' });
  assert.deepEqual({ ...defaultLimits(), today: '' }, { hopLimit: 15, dailyCap: 200, today: '' });

  assert.equal((await api('PATCH', '/limits', { chatHops: 0 })).status, 400);
  assert.equal((await api('PATCH', '/limits', { chatHops: 3, bogus: 1 })).status, 400, 'one bad key and nothing is saved');
  assert.equal((await api('PATCH', '/limits', { chatHops: 3 }, 'text/plain')).status, 415);
  for (const body of [[], 'x', null]) assert.equal((await api('PATCH', '/limits', body)).status, 400, JSON.stringify(body));
  assert.equal(limit('chatHops'), 15);

  const back = await api('PATCH', '/limits', { chatHops: null, chatDailyWakes: null });
  assert.equal(back.status, 200);
  const got = await api('GET', '/limits', undefined);
  assert.equal((got.body as LimitsResponse).chatHops.source, 'default');
  assert.equal((got.body as LimitsResponse).chatDailyWakes.value, 30);
});

test('queue: a raised limit starts waiting runs at once; a lowered one closes slots as runs end', async () => {
  const { enqueue, fillSlots } = await import('./runner/queue');
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const started: string[] = [];
  const gates: (() => void)[] = [];
  const hold = (name: string) => () => new Promise<void>((r) => (started.push(name), gates.push(r)));
  setLimits({ concurrency: 1 });
  try {
    const jobs = ['a', 'b', 'c'].map((n) => enqueue(`lim:${n}`, hold(n)));
    await tick();
    assert.deepEqual(started, ['a']);
    setLimits({ concurrency: 3 });
    fillSlots();
    await tick();
    assert.deepEqual(started, ['a', 'b', 'c'], 'raised: the waiting ones start without a release');

    setLimits({ concurrency: 1 });
    jobs.push(enqueue('lim:d', hold('d')), enqueue('lim:e', hold('e')));
    await tick();
    gates.shift()!();
    gates.shift()!();
    await tick();
    assert.deepEqual(started, ['a', 'b', 'c'], 'lowered: two runs end and their slots close');
    gates.shift()!();
    await tick();
    assert.deepEqual(started, ['a', 'b', 'c', 'd'], 'one at a time from here');
    gates.shift()!();
    await tick();
    gates.shift()!();
    await Promise.all(jobs);
    assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
  } finally {
    setLimits({ concurrency: null });
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
assert.equal(failed, 0, `${failed} settings case(s) failed`);
console.log(`\nall ${passed} settings cases pass`);
