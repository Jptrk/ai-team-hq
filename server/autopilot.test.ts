/**
 * What the team starts on its own, and Pause: hand-offs, chat wakes and QA checks held while HQ is paused or Claude
 * refuses, released on Resume, kept across a restart; your own starts never held. Desks run on a fake runner here.
 * Run: npm run test:auto. Works in a throwaway folder under the OS temp dir; makes no Claude calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Meta, Run, State, WorkItem } from '../shared/types';
import type { AgentRunner, RunInput, RunOutcome } from './runner/types';

// The store and settings read data/ from the working directory, so move into a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-auto-'));
process.chdir(root);
process.env.HQ_RUNNER = 'sim';
const store = await import('./store');
const chat = await import('./chat');
const runner = await import('./runner/index');
const settings = await import('./settings');
const { autoGate, countCost, freeDesks, nextMidnight, pickStarts } = await import('./autopilot');
const claudeMod = await import('./runner/claude');
const { ticketPrompt } = claudeMod;
const goal = await import('./goal');
const { closesOnApprove } = await import('./qa');
const { localDay } = await import('../shared/types');
const { router, readSettingsPatch, readProjectPatch, goalModeProblem } = await import('./routes');

// ---------- a fake runner: records what started, and each run does what the test says ----------

type Script = (input: RunInput, signal: AbortSignal) => Promise<RunOutcome>;
const okRun: Script = async () => ({ summary: 'ok', costUsd: 0.1, turns: 1 });
let script: Script = okRun;
const started: { reason: string; agentId: string; itemId?: string; threadId?: string; auto?: boolean; restarts?: number }[] = [];
const fake: AgentRunner = {
  name: 'claude',
  run: (input, signal) => {
    started.push({ reason: input.reason, agentId: input.agent.id, itemId: input.item?.id, threadId: input.thread?.id, auto: input.run.auto, restarts: input.run.restarts });
    return script(input, signal);
  },
};
runner.useRunnerForTests(fake);

store.initStore({ emptySeed: true });
const p = store.createProject({ name: 'Shop app', key: 'SA', path: null, access: 'read', template: 'dev' });
const base = JSON.parse(JSON.stringify(p.state)) as State;

/** A clean project, nothing paused, nothing started yet. */
async function fresh(): Promise<void> {
  await idle();
  p.state = store.migrateState(JSON.parse(JSON.stringify(base)) as State, 'dev');
  settings.setPaused(false);
  settings.setUsageHold(null);
  script = okRun;
  started.length = 0;
}

/** Waits until no run is queued or running. */
async function idle(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (!p.state.runs.some((r) => r.status === 'queued' || r.status === 'running')) {
      await new Promise((r) => setTimeout(r, 5));
      if (!p.state.runs.some((r) => r.status === 'queued' || r.status === 'running')) return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('runs never finished');
}

let n = 0;
function ticket(assignee: string, extra: Partial<WorkItem> = {}): WorkItem {
  const item: WorkItem = { id: `wi_a${++n}`, number: 100 + n, kind: 'fyi', status: 'todo', title: `Ticket ${n}`, summary: '', from: 'nora', assignee, dated: '2026-10-06', links: [], history: [], ...extra };
  p.state.items.unshift(item);
  return item;
}

/** A run that waits until the test lets it finish. */
function blocking(): { script: Script; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    release: () => release(),
    // Your Stop ends it, as it ends a real run.
    script: async (_input, signal) => {
      await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped by you')), { once: true }))]);
      return { summary: 'ok', costUsd: 0.1, turns: 1 };
    },
  };
}

/** Call the API in-process, as the server does once it has parsed the JSON body. */
function api(method: string, url: string, body?: unknown): Promise<{ status: number; body: unknown }> {
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
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const req = { method, url, body, headers, query: {}, get: (h: string) => headers[h.toLowerCase()] };
    const handle = router as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
    handle(req, res, (err) => reject(err ?? new Error(`no route for ${method} ${url}`)));
  });
}

const runsFor = (itemId: string): Run[] => p.state.runs.filter((r) => r.itemId === itemId);
const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);

// ---------- Pause ----------

test('pause: a start the team makes is held on its ticket, with no run; your own start still runs', async () => {
  await fresh();
  const theirs = ticket('leo');
  const yours = ticket('sam');
  runner.pauseAll();
  assert.equal(autoGate(p)?.kind, 'paused');
  assert.equal(runner.kickoff(p, theirs.id, 'handoff', undefined, [], { auto: true }), null);
  assert.deepEqual(runsFor(theirs.id), [], 'no run at all');
  assert.equal(theirs.autoHold?.reason, 'handoff');
  assert.equal(theirs.autoHold?.why, 'paused');
  assert.match(theirs.history.at(-1)!.text, /^Held the hand-off: HQ is paused\. It starts when that clears\.$/);
  assert.equal(theirs.status, 'todo', 'it stays in To do');
  assert.ok(runner.kickoff(p, yours.id, 'manual'), 'yours queues');
  await idle();
  assert.deepEqual(
    started.map((s) => [s.reason, s.itemId]),
    [['manual', yours.id]],
  );
  // Held twice for the same start: one history line, and it keeps its place in line.
  const at = theirs.autoHold!.at;
  runner.kickoff(p, theirs.id, 'handoff', undefined, [], { auto: true });
  assert.equal(theirs.history.filter((h) => h.text.startsWith('Held')).length, 1);
  assert.equal(theirs.autoHold!.at, at);
});

test('pause: a queued team start is held at once and never blocks your next run on the same desk', async () => {
  await fresh();
  const first = ticket('leo');
  const theirs = ticket('leo');
  const next = ticket('leo');
  const b = blocking();
  script = b.script;
  runner.kickoff(p, first.id, 'manual');
  await new Promise((r) => setTimeout(r, 20));
  const queued = runner.kickoff(p, theirs.id, 'handoff', undefined, [], { auto: true })!;
  assert.equal(queued.status, 'queued');
  assert.equal(queued.auto, true);
  runner.pauseAll();
  assert.equal(queued.status, 'done', 'held now, not when its turn comes');
  assert.match(queued.summary ?? '', /^Skipped: held: HQ is paused/);
  assert.equal(theirs.autoHold?.reason, 'handoff');
  runner.kickoff(p, next.id, 'manual');
  script = okRun;
  b.release();
  await idle();
  assert.deepEqual(
    started.map((s) => s.itemId),
    [first.id, next.id],
    'the held start never ran; yours ran right after the first',
  );
});

test('resume: held starts run oldest first; one whose ticket moved on is dropped', async () => {
  await fresh();
  const a = ticket('leo');
  const b = ticket('sam');
  const c = ticket('omar');
  runner.pauseAll();
  for (const item of [a, b, c]) runner.kickoff(p, item.id, 'handoff', undefined, [], { auto: true });
  b.status = 'done';
  assert.equal(runner.meta().held, 3);
  runner.resumeAll();
  await idle();
  assert.deepEqual(
    started.map((s) => s.itemId),
    [a.id, c.id],
  );
  assert.ok(started.every((s) => s.auto), 'released starts are still the team’s own');
  assert.equal(b.autoHold, undefined);
  assert.match(b.history.at(-1)!.text, /^Dropped a held start: ticket is done$/);
  assert.equal(runner.meta().held, 0);
});

test('pause: a QA check the team asks for waits in QA, and Resume starts it', async () => {
  await fresh();
  const item = ticket('leo', { status: 'qa' });
  runner.pauseAll();
  runner.kickoff(p, item.id, 'qa', undefined, [], { auto: true });
  assert.equal(item.autoHold?.reason, 'qa');
  runner.resumeAll();
  await idle();
  assert.deepEqual(
    started.map((s) => [s.reason, s.agentId]),
    [['qa', 'ivy']],
  );
});

// ---------- chat wakes ----------

test('chat: a held wake keeps the hop and daily counts, stops "replying", says why once; Resume wakes the desk once', async () => {
  await fresh();
  const s = p.state;
  const t = chat.createThread(s, { title: 'Cart bug', createdBy: 'leo' });
  const posted = chat.postAgentMessage(s, t, 'leo', ['sam'], 'Can you check the cart API?');
  assert.deepEqual(posted.deliver, ['sam']);
  const hops = t.agentHops;
  const wakes = s.chat.wakes;
  const messages = s.messages.length;
  runner.pauseAll();
  assert.deepEqual(runner.deliver(p, t.id, ['sam'], { auto: true }), []);
  assert.deepEqual(runner.deliver(p, t.id, ['sam'], { auto: true }), []);
  assert.equal(s.auto.heldWakes.length, 1, 'one held wake per desk per thread');
  assert.equal(t.waiting.includes('sam'), false, 'Sam no longer shows as replying');
  assert.equal(s.messages.length, messages + 1, 'one note in the thread');
  assert.equal(s.messages.at(-1)!.text, 'Sam sees this once it clears: HQ is paused.');
  assert.equal(t.agentHops, hops, 'hop count unchanged');
  assert.equal(s.chat.wakes, wakes, 'daily wake count unchanged');
  assert.equal(t.status, 'open', 'the thread is not paused, so nothing extra lands in Needs you');
  runner.resumeAll();
  await idle();
  runner.releaseHolds(p);
  await idle();
  assert.deepEqual(
    started.map((x) => [x.reason, x.agentId, x.threadId]),
    [['message', 'sam', t.id]],
  );
  assert.equal(s.auto.heldWakes.length, 0);
  assert.equal(t.agentHops, hops, 'releasing it counts no extra hop');
});

test('chat: a held wake waits while you have the thread paused, and is dropped once it is closed', async () => {
  await fresh();
  const s = p.state;
  const t = chat.createThread(s, { title: 'Copy', createdBy: 'leo' });
  chat.postAgentMessage(s, t, 'leo', ['sam'], 'Draft the copy?');
  runner.pauseAll();
  runner.deliver(p, t.id, ['sam'], { auto: true });
  t.status = 'paused';
  t.pausedReason = 'hop-limit';
  runner.resumeAll();
  await idle();
  assert.equal(started.length, 0, 'not while the thread is paused');
  assert.equal(s.auto.heldWakes.length, 1);
  t.status = 'closed';
  runner.releaseHolds(p);
  await idle();
  assert.equal(started.length, 0);
  assert.equal(s.auto.heldWakes.length, 0, 'closed: dropped');
});

// ---------- Claude refuses ----------

test("usage: Claude's limit holds automatic work everywhere, re-holds the team's start, and clears at its reset", async () => {
  await fresh();
  const theirs = ticket('leo');
  const later = ticket('sam');
  const until = new Date(Date.now() + 3_600_000).toISOString();
  script = async () => {
    throw Object.assign(new Error("Claude's 5-hour limit reached. It resets at 15:00."), { usage: { kind: 'usage', until, text: "Claude's 5-hour limit reached. It resets at 15:00." } });
  };
  runner.kickoff(p, theirs.id, 'handoff', undefined, [], { auto: true });
  await idle();
  assert.equal(settings.settings().usageHold?.until, until);
  const meta = runner.meta();
  assert.equal(meta.paused?.by, 'usage');
  assert.equal(meta.paused?.until, until);
  assert.equal(theirs.autoHold?.reason, 'handoff', 'held again, not failed');
  assert.equal(theirs.autoHold?.why, 'usage');
  assert.equal(
    theirs.history.some((h) => h.text.startsWith('Run failed')),
    false,
  );
  runner.kickoff(p, later.id, 'handoff', undefined, [], { auto: true });
  assert.equal(later.autoHold?.why, 'usage', 'nothing else the team starts runs meanwhile');
  script = okRun;
  started.length = 0;
  runner.autoSweep(Date.now() + 2 * 3_600_000);
  await idle();
  assert.equal(settings.settings().usageHold, undefined, 'cleared once it reset');
  assert.deepEqual(started.map((s) => s.itemId).sort(), [theirs.id, later.id].sort());
});

test('usage: your own run fails with the reason, and still holds what the team starts', async () => {
  await fresh();
  const yours = ticket('leo');
  script = async () => {
    throw Object.assign(new Error("Claude's usage limit reached."), { usage: { kind: 'usage', text: "Claude's usage limit reached." } });
  };
  runner.kickoff(p, yours.id, 'manual');
  await idle();
  const run = runsFor(yours.id)[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.error, "Claude's usage limit reached.");
  assert.ok(yours.history.some((h) => h.text === "Run failed: Claude's usage limit reached."));
  const hold = settings.settings().usageHold!;
  assert.equal(hold.kind, 'usage');
  assert.ok(Date.parse(hold.until!) > Date.now() + 25 * 60_000, 'no reset time given: tried again in half an hour');
  assert.equal(autoGate(p)?.kind, 'usage');
});

test('account: a login or billing problem holds until you resume, not until a clock runs out', async () => {
  await fresh();
  settings.setUsageHold({ kind: 'account', at: new Date().toISOString(), text: 'Claude reported a billing problem.' });
  runner.autoSweep(Date.now() + 30 * 24 * 3_600_000);
  assert.equal(runner.meta().paused?.by, 'account');
  assert.equal(autoGate(p)?.text, 'Claude reported a billing problem.');
  runner.resumeAll();
  assert.equal(runner.meta().paused, null);
});

// ---------- restart ----------

test('restart: the team’s run starts again by itself once; a second time it is left to you; your run is as before', async () => {
  await fresh();
  const s = p.state;
  const once = ticket('leo', { status: 'in-progress' });
  const twice = ticket('sam', { status: 'qa' });
  const yours = ticket('omar', { status: 'in-progress' });
  const t1 = chat.createThread(s, { title: 'Team chat', createdBy: 'leo' });
  const t2 = chat.createThread(s, { title: 'Your chat', createdBy: 'you' });
  const at = new Date().toISOString();
  const run = (extra: Partial<Run>): Run => ({ id: `run_${Math.random().toString(36).slice(2)}`, agentId: 'leo', status: 'running', startedAt: at, reason: 'manual', ...extra });
  s.runs.unshift(
    run({ itemId: once.id, reason: 'handoff', auto: true }),
    run({ itemId: twice.id, agentId: 'ivy', reason: 'qa', auto: true, restarts: 1, status: 'queued' }),
    run({ itemId: yours.id, agentId: 'omar', reason: 'manual' }),
    run({ threadId: t1.id, agentId: 'sam', reason: 'message', auto: true }),
    run({ threadId: t2.id, agentId: 'sam', reason: 'message' }),
  );
  store.migrateState(s);
  assert.deepEqual(once.autoHold && { reason: once.autoHold.reason, why: once.autoHold.why, restarts: once.autoHold.restarts }, { reason: 'handoff', why: 'restart', restarts: 1 });
  assert.equal(once.history.at(-1)!.text, 'Run interrupted by a server restart. It starts again by itself when HQ can run it.');
  assert.equal(twice.autoHold, undefined);
  assert.equal(twice.autoSkip?.why, 'A server restart cut its run off twice.');
  assert.equal(yours.autoHold, undefined);
  assert.equal(yours.history.at(-1)!.text, 'Run interrupted by a server restart. Use "Put them on it" to retry.');
  assert.deepEqual(
    s.auto.heldWakes.map((w) => [w.threadId, w.agentId, w.why, w.restarts]),
    [[t1.id, 'sam', 'restart', 1]],
  );
  assert.equal(t1.status, 'open', 'the team chat is not paused');
  assert.equal(t2.status, 'paused', 'your chat pauses, as before');
  // Released after the restart: the start remembers it was cut off once.
  runner.releaseHolds(p);
  await idle();
  const again = started.find((x) => x.itemId === once.id)!;
  assert.equal(again.restarts, 1);
  assert.equal(again.auto, true);
});

test('restart: a team run cut off on a ticket where a start of yours waits never replaces yours', async () => {
  await fresh();
  const s = p.state;
  const item = ticket('leo', { status: 'in-progress' });
  const at = new Date().toISOString();
  item.autoHold = { reason: 'instruct', at, why: 'model', mine: true, note: 'Use the new numbers' };
  s.runs.unshift({ id: 'run_cut', agentId: 'leo', status: 'running', startedAt: at, reason: 'handoff', itemId: item.id, auto: true });
  store.migrateState(s);
  assert.deepEqual(item.autoHold, { reason: 'instruct', at, why: 'model', mine: true, note: 'Use the new numbers' }, 'yours stays exactly as it was');
  assert.equal(item.history.at(-1)!.text, 'Run interrupted by a server restart. Your waiting start goes instead.');
});

test('restart: a hand-off and the QA check its own report queued, both cut off: the ticket waits for its QA check, noted once', async () => {
  await fresh();
  const s = p.state;
  const item = ticket('leo', { status: 'qa' });
  const at = new Date().toISOString();
  // Newest first, as stored: the QA check came after the hand-off run that reported it done.
  s.runs.unshift(
    { id: 'run_qa', agentId: 'ivy', itemId: item.id, reason: 'qa', status: 'queued', startedAt: at, auto: true },
    { id: 'run_ho', agentId: 'leo', itemId: item.id, reason: 'handoff', status: 'running', startedAt: at, auto: true },
  );
  store.migrateState(s);
  assert.equal(item.autoHold?.reason, 'qa');
  assert.equal(item.history.filter((h) => h.text.startsWith('Run interrupted')).length, 1);
  runner.releaseHolds(p);
  await idle();
  assert.deepEqual(
    started.map((x) => [x.reason, x.agentId]),
    [['qa', 'ivy']],
  );
});

test('yours: writing to a desk, or asking for a QA check, that joins a waiting team run makes it yours, so Pause never holds it', async () => {
  await fresh();
  const s = p.state;
  const b = blocking();
  script = b.script;
  const t = chat.createThread(s, { title: 'Cart', createdBy: 'leo' });
  runner.kickoff(p, ticket('sam').id, 'manual');
  await new Promise((r) => setTimeout(r, 20));
  chat.postAgentMessage(s, t, 'leo', ['sam'], 'Cart API?');
  const [wake] = runner.deliver(p, t.id, ['sam'], { auto: true });
  assert.equal(wake.auto, true);
  chat.postFounderMessage(s, t, '@Sam please answer Leo');
  runner.deliver(p, t.id, ['sam']);
  assert.equal(wake.auto, undefined, 'your message made the waiting reply yours');
  const qaItem = ticket('omar', { status: 'qa' });
  runner.kickoff(p, ticket('ivy').id, 'manual');
  const check = runner.kickoff(p, qaItem.id, 'qa', undefined, [], { auto: true })!;
  assert.equal(check.auto, true);
  assert.equal(runner.kickoff(p, qaItem.id, 'qa'), check, 'your Put Ivy on it joins the waiting check');
  assert.equal(check.auto, undefined);
  runner.pauseAll();
  assert.equal(wake.status, 'queued', 'not held');
  assert.equal(check.status, 'queued', 'not held');
  script = okRun;
  b.release();
  await idle();
  assert.ok(started.some((x) => x.reason === 'message' && x.agentId === 'sam'));
  assert.ok(started.some((x) => x.reason === 'qa' && x.agentId === 'ivy'));
});

test('queue: your runs wait for a slot first come, first served, ahead of the team’s', async () => {
  const { enqueue, CONCURRENCY } = await import('./runner/queue');
  const order: string[] = [];
  const gates: (() => void)[] = [];
  const hold = (name: string) => () => new Promise<void>((r) => gates.push(() => (order.push(name), r())));
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) jobs.push(enqueue(`q:busy${i}`, hold(`busy${i}`)));
  await new Promise((r) => setTimeout(r, 10));
  jobs.push(enqueue('q:team', hold('team')));
  for (const name of ['you1', 'you2', 'you3']) jobs.push(enqueue(`q:${name}`, hold(name), { first: true }));
  for (let i = 0; i < CONCURRENCY + 4; i++) {
    await new Promise((r) => setTimeout(r, 10));
    gates.shift()?.();
  }
  await Promise.all(jobs);
  assert.deepEqual(order.slice(CONCURRENCY), ['you1', 'you2', 'you3', 'team']);
});

test('resume: lifting your Pause leaves a usage limit that is still on; Resume now on it clears it', async () => {
  await fresh();
  settings.setUsageHold({ kind: 'usage', at: new Date().toISOString(), text: "Claude's 5-hour limit reached. It resets at 15:00.", until: new Date(Date.now() + 3_600_000).toISOString() });
  runner.pauseAll();
  assert.equal(runner.meta().paused?.by, 'you');
  runner.resumeAll();
  assert.equal(runner.meta().paused?.by, 'usage', 'the limit still holds');
  const item = ticket('leo');
  runner.kickoff(p, item.id, 'handoff', undefined, [], { auto: true });
  assert.equal(item.history.at(-1)!.text, "Held the hand-off: Claude's 5-hour limit reached. It resets at 15:00. It starts when that clears.", 'one full stop, not two');
  runner.resumeAll();
  assert.equal(runner.meta().paused, null);
  await idle();
});

test('move: dragging a ticket keeps a held start that still fits, and drops one that no longer does, saying so', async () => {
  await fresh();
  const keep = ticket('leo');
  const drop = ticket('sam', { status: 'qa' });
  runner.pauseAll();
  runner.kickoff(p, keep.id, 'handoff', undefined, [], { auto: true });
  runner.kickoff(p, drop.id, 'qa', undefined, [], { auto: true });
  assert.equal((await api('PATCH', `/projects/${p.id}/items/${keep.id}`, { status: 'in-progress' })).status, 200);
  assert.equal(keep.autoHold?.reason, 'handoff', 'a hand-off still fits a ticket in progress');
  assert.equal((await api('PATCH', `/projects/${p.id}/items/${drop.id}`, { status: 'todo' })).status, 200);
  assert.equal(drop.autoHold, undefined);
  assert.match(drop.history.at(-1)!.text, /^Dropped a held start: ticket is todo, not in QA$/);
  runner.resumeAll();
  await idle();
});

// ---------- the API and your own actions ----------

test('api: PATCH /settings pauses and resumes; meta says why and how much waits', async () => {
  await fresh();
  const paused = await api('PATCH', '/settings', { paused: true });
  assert.equal(paused.status, 200);
  assert.equal((paused.body as Meta).paused?.by, 'you');
  const item = ticket('leo');
  runner.kickoff(p, item.id, 'handoff', undefined, [], { auto: true });
  assert.equal(((await api('GET', '/meta')).body as Meta).held, 1);
  const resumed = await api('PATCH', '/settings', { paused: false });
  assert.equal((resumed.body as Meta).paused, null);
  await idle();
  assert.equal(started.length, 1);
  assert.deepEqual(readSettingsPatch({ paused: true }), { paused: true });
  assert.deepEqual(readSettingsPatch({ effort: 'low', paused: false }), { effort: 'low', paused: false });
  for (const bad of ['yes', 1, null]) assert.match(String(readSettingsPatch({ paused: bad }).error), /paused must be true or false/);
  assert.match(String(readSettingsPatch({}).error), /Nothing to change/);
});

test('yours: moving a ticket by hand, or putting someone on it, clears what was held or skipped for it', async () => {
  await fresh();
  const moved = ticket('leo');
  const put = ticket('sam');
  runner.pauseAll();
  runner.kickoff(p, moved.id, 'handoff', undefined, [], { auto: true });
  put.autoSkip = { at: new Date().toISOString(), why: 'Its automatic run failed.' };
  const res = await api('PATCH', `/projects/${p.id}/items/${moved.id}`, { status: 'held' });
  assert.equal(res.status, 200);
  assert.equal(moved.autoHold, undefined);
  runner.kickoff(p, put.id, 'manual');
  assert.equal(put.autoSkip, undefined);
  // A comment answer is not taking it over.
  const commented = ticket('omar', { autoSkip: { at: new Date().toISOString(), why: 'x' } });
  runner.kickoff(p, commented.id, 'comment', 'why?');
  assert.ok(commented.autoSkip);
  runner.resumeAll();
  await idle();
});

// ---------- daily limits ----------

test('limits: only the team’s own runs count, as they start; their cost counts toward the day they started', async () => {
  await fresh();
  const s = p.state;
  runner.kickoff(p, ticket('leo').id, 'manual');
  runner.kickoff(p, ticket('sam').id, 'handoff', undefined, [], { auto: true });
  await idle();
  assert.equal(s.auto.usage.runs, 1, 'yours does not count');
  assert.equal(s.auto.usage.usd, 0.1);
  assert.equal(s.auto.usage.day, localDay());
  const yesterday = new Date(Date.now() - 36 * 3_600_000).toISOString();
  countCost(s, { startedAt: yesterday, costUsd: 5 });
  assert.equal(s.auto.usage.usd, 0.1, 'a run from before midnight adds nothing to today');
});

test('limits: past the day’s runs the team’s starts wait until midnight; queued ones count, so a burst can’t pass it', async () => {
  await fresh();
  store.updateProject(p.id, { autoLimits: { runs: 2, usd: 25 } });
  const b = blocking();
  script = b.script;
  const items = [ticket('leo'), ticket('sam'), ticket('omar')];
  for (const item of items) runner.kickoff(p, item.id, 'handoff', undefined, [], { auto: true });
  b.release();
  assert.equal(items[2].autoHold?.why, 'runs', 'one running and one queued count as started: the third waits');
  assert.match(items[2].history.at(-1)!.text, /^Held the hand-off: the 2 runs the team may start on its own today are used up\./);
  await idle();
  const hold = autoGate(p)!;
  assert.equal(hold?.kind, 'runs', 'both ran: today is used up');
  assert.equal(hold.until, nextMidnight());
  // Raising the limit in settings lets it start.
  const res = await api('PATCH', `/projects/${p.id}`, { autoLimits: { runs: 5, usd: 25 } });
  assert.equal(res.status, 200);
  await idle();
  assert.deepEqual(started.map((x) => x.itemId).sort(), items.map((i) => i.id).sort());
  store.updateProject(p.id, { autoLimits: undefined });
});

test('limits: past the day’s spend the team waits; a new day starts the count over', async () => {
  await fresh();
  const s = p.state;
  s.auto.usage = { day: localDay(), runs: 3, usd: 25 };
  assert.equal(autoGate(p)?.kind, 'usd');
  assert.match(autoGate(p)!.text, /the \$25 the team may spend on its own today is used up/);
  s.auto.usage = { day: '2026-01-01', runs: 40, usd: 25 };
  assert.equal(autoGate(p), null, 'yesterday’s count does not hold today');
  assert.deepEqual(s.auto.usage, { day: localDay(), runs: 0, usd: 0 });
  const status = (await api('GET', `/projects/${p.id}/state`)).body as { auto: { today: { maxRuns: number; maxUsd: number; resetsAt: string } } };
  assert.equal(status.auto.today.maxRuns, 40);
  assert.equal(status.auto.today.maxUsd, 25);
  assert.equal(status.auto.today.resetsAt, nextMidnight());
});

test('limits: your days are local days', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Asia/Manila';
  try {
    assert.equal(localDay(new Date('2026-10-06T17:00:00Z')), '2026-10-07', '1 AM in Manila is the next day');
    assert.equal(localDay(new Date('2026-10-06T15:59:00Z')), '2026-10-06');
    assert.equal(nextMidnight(Date.parse('2026-10-06T10:00:00Z')), '2026-10-06T16:00:00.000Z');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('settings: limits, Autopilot and Goal mode are checked before they are saved', async () => {
  await fresh();
  assert.deepEqual(readProjectPatch({ autoLimits: { runs: 10, usd: 7.255 } }).patch, { autoLimits: { runs: 10, usd: 7.26 } });
  for (const bad of [{ runs: 0, usd: 5 }, { runs: 2.5, usd: 5 }, { runs: 501, usd: 5 }, { runs: 5, usd: 0.5 }, { runs: 5, usd: 1001 }, { runs: '5', usd: 5 }, null]) {
    assert.ok(readProjectPatch({ autoLimits: bad }).error, JSON.stringify(bad));
  }
  assert.match(String(readProjectPatch({ autopilot: 'yes' }).error), /autopilot must be true or false/);
  assert.match(String(readProjectPatch({ goal: 'x'.repeat(2001) }).error), /at most 2000/);
  assert.equal(readProjectPatch({ goal: '   ' }).patch.goal, undefined, 'blank clears it');
  assert.match(String(goalModeProblem({ goalMode: true, goal: '', autopilot: true })), /needs a goal/);
  assert.match(String(goalModeProblem({ goalMode: true, goal: 'Ship it', autopilot: false })), /needs Autopilot/);
  assert.equal(goalModeProblem({ goalMode: true, goal: 'Ship it', autopilot: true }), null);
  assert.equal((await api('PATCH', `/projects/${p.id}`, { goalMode: true })).status, 400);
  assert.equal((await api('PATCH', `/projects/${p.id}`, { autopilot: true, goalMode: true, goal: 'Ship the cart' })).status, 200);
  assert.equal(p.meta.goalMode, true);
  assert.equal((await api('PATCH', `/projects/${p.id}`, { autopilot: false })).status, 200);
  assert.equal(p.meta.goalMode, false, 'Autopilot off takes Goal mode with it');
  store.updateProject(p.id, { autopilot: undefined, goalMode: undefined, goal: undefined });
});

// ---------- Autopilot ----------

/** Autopilot on for the test project, the rest of the board cleared so only the test's tickets count. */
async function autopilotOn(): Promise<void> {
  await fresh();
  p.state.items = [];
  store.updateProject(p.id, { autopilot: true });
}
const autopilotOff = () => store.updateProject(p.id, { autopilot: undefined, goalMode: undefined, goal: undefined });

test('free desks: not you, not off shift, not busy or in a huddle, not on an active ticket, fewer than 2 waiting on you', async () => {
  await autopilotOn();
  const s = p.state;
  const names = () => freeDesks(s).map((a) => a.id).sort();
  const all = s.agents.filter((a) => !a.isHuman).map((a) => a.id).sort();
  assert.deepEqual(names(), all);
  s.agents.find((a) => a.id === 'leo')!.status = 'off';
  ticket('sam', { status: 'in-progress' });
  ticket('omar', { status: 'needs-you' });
  ticket('omar', { status: 'needs-you' });
  ticket('grace', { status: 'in-progress', autoSkip: { at: '2026-10-06T00:00:00Z', why: 'x' } });
  ticket('theo', { status: 'needs-you' });
  s.runs.unshift({ id: 'run_q', agentId: 'nora', reason: 'manual', status: 'queued', startedAt: new Date().toISOString() });
  s.huddles.unshift({ id: 'h1', status: 'running', facilitator: 'ivy', participants: ['grace'] } as never);
  assert.deepEqual(names(), ['theo'], 'leo off, sam active, omar 2 waiting, nora queued, ivy and grace in a huddle; theo has only 1 waiting');
  s.huddles = [];
  assert.deepEqual(names(), ['grace', 'ivy', 'theo'], 'out of the huddle; an active ticket Autopilot left does not keep grace busy');
  s.runs = s.runs.filter((r) => r.id !== 'run_q');
  autopilotOff();
});

test('picks: each free desk’s oldest To do ticket, oldest first across desks, never more than the free slots', async () => {
  await autopilotOn();
  const s = p.state;
  const newerLeo = ticket('leo', { number: 30 });
  const olderLeo = ticket('leo', { number: 12 });
  const sam = ticket('sam', { number: 20 });
  const omar = ticket('omar', { number: 5 });
  ticket('nora', { number: 1, autoSkip: { at: '2026-10-06T00:00:00Z', why: 'x' } });
  ticket('theo', { number: 2, autoHold: { reason: 'handoff', at: '2026-10-06T00:00:00Z', why: 'paused' } });
  ticket('grace', { number: 3, status: 'in-progress' });
  const pick = (slots: number) => pickStarts(s, p.meta, slots).map((x) => x.itemId);
  assert.deepEqual(pick(9), [omar.id, olderLeo.id, sam.id]);
  assert.deepEqual(pick(2), [omar.id, olderLeo.id]);
  assert.deepEqual(pick(0), []);
  assert.deepEqual(pickStarts(s, { autopilot: false }, 9), [], 'off: nothing');
  assert.deepEqual(pickStarts(s, p.meta, 9, new Set(['omar'])).map((x) => x.itemId), [olderLeo.id, sam.id], 'a reserved desk is skipped');
  assert.ok(newerLeo);
  autopilotOff();
});

test('autopilot: a pass starts the oldest ticket for a free desk, says so, and a second pass starts nothing more', async () => {
  await autopilotOn();
  const first = ticket('leo', { number: 40 });
  const second = ticket('leo', { number: 41 });
  const b = blocking();
  script = b.script;
  runner.autoTick(p);
  runner.autoTick(p);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    started.map((x) => [x.reason, x.itemId, x.auto]),
    [['auto', first.id, true]],
  );
  assert.equal(first.status, 'in-progress');
  assert.ok(first.history.some((h) => h.text === 'Started by Autopilot: it was next in To do'));
  assert.equal(second.status, 'todo', 'Leo is busy: one at a time');
  assert.equal(p.state.auto.usage.runs, 1, 'it counts toward today');
  script = okRun;
  b.release();
  await idle();
  // Leo finished (the fake runner leaves the ticket in progress, as a desk that has not reported done would): mark it done, and Leo moves on.
  first.status = 'done';
  runner.autoTick(p);
  await idle();
  assert.deepEqual(
    started.map((x) => x.itemId),
    [first.id, second.id],
  );
  autopilotOff();
});

test('autopilot: never more than the free slots, and only while the gate is open', async () => {
  await autopilotOn();
  const a = ticket('leo');
  const b2 = ticket('sam');
  const c = ticket('omar');
  const b = blocking();
  script = b.script;
  runner.kickoff(p, ticket('nora').id, 'manual');
  runner.kickoff(p, ticket('theo').id, 'manual');
  runner.autoTick(p);
  assert.equal(
    p.state.runs.filter((r) => r.auto).length,
    0,
    'both slots taken by your runs: Autopilot waits',
  );
  script = okRun;
  b.release();
  await idle();
  // Your runs finished: their slots went to Autopilot, one desk at a time.
  assert.deepEqual(started.filter((x) => x.reason === 'auto').map((x) => x.itemId).sort(), [a.id, b2.id, c.id].sort());
  const before = p.state.runs.filter((r) => r.auto).length;
  runner.pauseAll();
  const later = ticket('grace');
  runner.autoTick(p);
  assert.equal(p.state.runs.filter((r) => r.auto).length, before, 'paused: nothing new');
  runner.resumeAll();
  await idle();
  assert.equal(started.at(-1)?.itemId, later.id, 'resumed: it picks up again');
  autopilotOff();
});

test('autopilot: a failed run leaves its ticket for you and the desk moves on; 3 in a row stop it here until you resume', async () => {
  await autopilotOn();
  const tickets = [ticket('leo', { number: 50 }), ticket('leo', { number: 51 }), ticket('leo', { number: 52 }), ticket('leo', { number: 53 })];
  script = async () => {
    throw new Error('Stopped: no progress for 8 minutes (HQ_RUN_IDLE_MS)');
  };
  runner.autoTick(p);
  await idle();
  await idle();
  assert.deepEqual(
    tickets.slice(0, 3).map((t) => t.autoSkip?.why),
    Array(3).fill('Its run failed: Stopped: no progress for 8 minutes (HQ_RUN_IDLE_MS)'),
  );
  assert.equal(p.state.auto.halted?.why, '3 automatic runs failed in a row');
  assert.equal(tickets[3].status, 'todo', 'stopped before the fourth');
  assert.equal(autoGate(p), null, 'only Autopilot stopped: hand-offs and chats still go');
  // The board's count: what Autopilot left for you shows in Needs you.
  const summary = (await api('GET', `/projects/${p.id}`)).body as { needsYou: number; autoHold: string };
  assert.equal(summary.autoHold, 'halted');
  assert.ok(summary.needsYou >= 3);
  script = okRun;
  started.length = 0;
  const resumed = await api('POST', `/projects/${p.id}/auto/resume`);
  assert.equal(resumed.status, 200);
  await idle();
  assert.equal(p.state.auto.halted, undefined);
  assert.equal(p.state.auto.failStreak, 0);
  assert.deepEqual(
    started.map((x) => x.itemId),
    [tickets[3].id],
    'resumed: it carries on with the next one',
  );
  autopilotOff();
});

test('autopilot: you stopping its run leaves the ticket for you, but is no strike; a success clears the streak', async () => {
  await autopilotOn();
  const item = ticket('leo');
  const b = blocking();
  script = b.script;
  runner.autoTick(p);
  await new Promise((r) => setTimeout(r, 20));
  const run = p.state.runs.find((r) => r.itemId === item.id)!;
  assert.equal(runner.cancelRun(run.id), true);
  script = okRun;
  await idle();
  b.release();
  assert.equal(item.autoSkip?.why, 'Stopped by you.');
  assert.equal(p.state.auto.failStreak, 0);
  p.state.auto.failStreak = 2;
  script = okRun;
  ticket('sam');
  runner.autoTick(p);
  await idle();
  assert.equal(p.state.auto.failStreak, 0, 'an Autopilot run that went fine starts the count over');
  autopilotOff();
});

test('autopilot: hand-offs, chats and QA that fail are not Autopilot’s failures, and its stop never holds them', async () => {
  await fresh();
  script = async () => {
    throw new Error('Stopped: no progress for 8 minutes (HQ_RUN_IDLE_MS)');
  };
  const items = [ticket('leo'), ticket('sam'), ticket('omar')];
  for (const item of items) runner.kickoff(p, item.id, 'handoff', undefined, [], { auto: true });
  await idle();
  assert.equal(p.state.auto.failStreak, 0);
  assert.equal(p.state.auto.halted, undefined);
  assert.ok(items.every((i) => !i.autoSkip && i.history.some((h) => h.text.startsWith('Run failed'))), 'a line on the ticket, as always');
  // Autopilot stopped itself: hand-offs still run.
  p.state.auto.halted = { at: new Date().toISOString(), why: '3 automatic runs failed in a row' };
  script = okRun;
  started.length = 0;
  runner.kickoff(p, ticket('grace').id, 'handoff', undefined, [], { auto: true });
  await idle();
  assert.equal(started.length, 1);
  assert.equal(autoGate(p), null, 'the gate is open');
  assert.equal(((await api('GET', `/projects/${p.id}/state`)).body as { auto: { hold: { kind: string } } }).auto.hold.kind, 'halted', 'the board still says Autopilot stopped');
  delete p.state.auto.halted;
});

test('autopilot: a ticket it skipped clears once a run on it goes fine; a desk whose last run failed moves on', async () => {
  await autopilotOn();
  const skipped = ticket('leo', { status: 'sent-back', autoSkip: { at: new Date().toISOString(), why: 'Its run failed.' } });
  runner.kickoff(p, skipped.id, 'send-back');
  await idle();
  assert.equal(skipped.autoSkip, undefined, 'your run took it back, and it went fine');
  const stuck = ticket('sam', { status: 'in-progress' });
  p.state.runs.unshift({ id: 'run_failed', agentId: 'sam', itemId: stuck.id, reason: 'manual', status: 'failed', startedAt: new Date().toISOString(), error: 'boom' });
  const next = ticket('sam');
  started.length = 0;
  runner.autoTick(p);
  await idle();
  assert.deepEqual(started.map((x) => x.itemId), [next.id], 'its failed ticket waits for you; Sam takes the next one');
  autopilotOff();
});

test('autopilot: a held Autopilot start waits for a free slot, and is dropped with a line when Autopilot is off', async () => {
  await autopilotOn();
  const b = blocking();
  script = b.script;
  runner.kickoff(p, ticket('nora').id, 'manual');
  runner.kickoff(p, ticket('theo').id, 'manual');
  const held = ticket('leo', { status: 'in-progress', autoHold: { reason: 'auto', at: new Date().toISOString(), why: 'restart', restarts: 1 } });
  runner.releaseHolds(p);
  assert.equal(held.autoHold?.reason, 'auto', 'no free slot: it keeps waiting');
  script = okRun;
  b.release();
  await idle();
  assert.equal(held.autoHold, undefined);
  assert.ok(started.some((x) => x.itemId === held.id && x.restarts === 1), 'started again once a slot was free');
  const off = ticket('sam', { autoHold: { reason: 'auto', at: new Date().toISOString(), why: 'paused' } });
  autopilotOff();
  runner.releaseHolds(p);
  assert.equal(off.autoHold, undefined);
  assert.equal(off.history.at(-1)!.text, "Dropped Autopilot's held start: Autopilot is off");
});

test('autopilot: turning it off drops its held starts; mootRun keeps an auto start to To do (or in progress after a restart)', async () => {
  await autopilotOn();
  const item = ticket('leo', { autoHold: { reason: 'auto', at: '2026-10-06T00:00:00Z', why: 'paused' } });
  autopilotOff();
  runner.releaseHolds(p);
  await idle();
  assert.equal(item.autoHold, undefined);
  assert.equal(started.length, 0);
  await fresh();
  assert.equal(runner.mootRun('auto', 'todo'), null);
  assert.equal(runner.mootRun('auto', 'in-progress'), null);
  for (const status of ['needs-you', 'held', 'done', 'qa', 'signoff', 'approved', 'sent-back'] as const) assert.ok(runner.mootRun('auto', status), status);
});

test('prompt: an Autopilot start says why it runs, and a goal ticket carries the goal', async () => {
  await fresh();
  const item = ticket('leo', { status: 'in-progress', origin: 'goal' });
  store.updateProject(p.id, { goal: 'Ship the new checkout' });
  const text = ticketPrompt({ project: p, item, reason: 'auto' });
  assert.match(text, /Autopilot started this: it was next in your To do\. Work it now and finish it with report_done\./);
  assert.match(text, /part of the team goal: "Ship the new checkout"/);
  assert.doesNotMatch(text, /server restart/);
  assert.match(ticketPrompt({ project: p, item, reason: 'auto' }, { restarted: true }), /A server restart cut your last run on it off/);
  autopilotOff();
});

// ---------- Goal mode ----------

/** Goal mode on with a goal, Autopilot on, a clean board. Nora is the dev team's lead. */
async function goalOn(goal = 'Ship the new checkout'): Promise<void> {
  await fresh();
  p.state.items = [];
  delete p.state.auto.goal;
  store.updateProject(p.id, { autopilot: true, goalMode: true, goal });
}

test('goal: when the lead plans, and when it does not', async () => {
  await goalOn();
  const s = p.state;
  const now = Date.now();
  assert.equal(goal.planDue(s, { goalMode: false, autopilot: true, goal: 'x' }, now), false, 'Goal mode off');
  assert.equal(goal.planDue(s, { goalMode: true, autopilot: false, goal: 'x' }, now), false, 'Autopilot off');
  assert.equal(goal.planDue(s, p.meta, now), true, 'a new goal');
  const g = goal.goalState(s, p.meta)!;
  g.lastPlanAt = new Date(now - 5 * 60_000).toISOString();
  ticket('leo', { origin: 'goal' });
  assert.equal(goal.planDue(s, p.meta, now), false, 'planned 5 minutes ago, work to do');
  assert.equal(goal.planDue(s, p.meta, now + 7 * 3_600_000), true, 'six hours on: a look for anything missing');
  s.items = [];
  assert.equal(goal.planDue(s, p.meta, now), false, 'out of work, but planned only 5 minutes ago');
  assert.equal(goal.planDue(s, p.meta, now + 21 * 60_000), true, 'out of work for 20 minutes: plan more');
  for (let i = 0; i < goal.GOAL_OPEN_CAP; i++) ticket('sam', { origin: 'goal', status: 'needs-you' });
  assert.equal(goal.planDue(s, p.meta, now + 7 * 3_600_000), false, 'the open cap is reached');
  s.items = [];
  s.runs.unshift({ id: 'run_lead', agentId: 'nora', reason: 'manual', status: 'running', startedAt: new Date().toISOString() });
  assert.equal(goal.planDue(s, p.meta, now + 21 * 60_000), false, 'the lead is busy');
  s.runs = s.runs.filter((r) => r.id !== 'run_lead');
  s.agents.find((a) => a.id === 'nora')!.status = 'off';
  assert.equal(goal.planDue(s, p.meta, now + 21 * 60_000), false, 'the lead is off shift');
  autopilotOff();
});

test('goal: the lead’s tickets go straight to To do, tagged Goal, for working desks, without duplicates or past the caps', async () => {
  await goalOn();
  const s = p.state;
  const made = goal.createGoalTicket(p, 'nora', { to: 'Leo', title: 'Build the cart page', brief: 'The new cart page, with tests for the totals.' }, 0);
  assert.ok(typeof made !== 'string');
  assert.equal(made.status, 'todo');
  assert.equal(made.origin, 'goal');
  assert.equal(made.assignee, 'leo');
  assert.equal(made.number, s.seq);
  assert.equal(made.threadId, undefined);
  assert.deepEqual(runsFor(made.id), [], 'no run: Autopilot starts it');
  const mine = goal.createGoalTicket(p, 'nora', { to: 'me', title: 'Write the rollout plan', brief: 'The order we ship the checkout pieces in.' }, 1);
  assert.equal(typeof mine !== 'string' && mine.assignee, 'nora', 'the lead can take one itself');
  const refused = (to: string, title = 'Something new to do', made = 2) => goal.createGoalTicket(p, 'nora', { to, title, brief: 'What done looks like here.' }, made);
  assert.match(String(refused('Patrick')), /Goal tickets go to desks/);
  assert.match(String(refused('Zed')), /No desk called "Zed"/);
  s.agents.find((a) => a.id === 'omar')!.status = 'off';
  assert.match(String(refused('Omar')), /Omar is off shift/);
  assert.match(String(refused('Sam', 'build  the CART page!')), /is already open for that/);
  assert.match(String(refused('Sam', 'Something else', goal.GOAL_PER_PLAN)), /already planned 5 tickets/);
  for (let i = 0; i < goal.GOAL_OPEN_CAP; i++) ticket('sam', { origin: 'goal' });
  assert.match(String(refused('Sam', 'One more thing')), /8 goal tickets are open already/);
  autopilotOff();
});

test('goal: reached or blocked waits for you in Needs you, where Approve marks it done; planning waits until you deal with it', async () => {
  await goalOn();
  const s = p.state;
  goal.recordGoalStatus(p, 'nora', 'blocked', 'We need the payment provider keys.');
  const blocked = s.items[0];
  assert.equal(blocked.status, 'needs-you');
  assert.match(blocked.title, /^Goal blocked Ship the new checkout/);
  assert.equal(closesOnApprove(blocked), true, 'Approve marks it done');
  assert.equal(blocked.origin, undefined, 'not counted as goal work');
  assert.equal(goal.planDue(s, p.meta), false, 'waits on you');
  blocked.status = 'done';
  assert.equal(goal.planDue(s, p.meta), true, 'dealt with: the lead plans again');
  assert.equal(goal.goalState(s, p.meta)!.status, 'on-track');
  goal.recordGoalStatus(p, 'nora', 'reached', 'The checkout is live and the tests pass.');
  s.items[0].status = 'done';
  assert.equal(goal.planDue(s, p.meta), false, 'reached: nothing more to plan');
  store.updateProject(p.id, { goal: 'Ship the new checkout, then the returns flow' });
  assert.equal(goal.planDue(s, p.meta), true, 'a new goal starts over');
  autopilotOff();
});

test('goal: two plans in a row that make nothing while the team has nothing to do: planning stalled, and you are told', async () => {
  await goalOn();
  const s = p.state;
  // Saying "on track" while adding nothing is no progress.
  goal.recordGoalStatus(p, 'nora', 'on-track', 'Waiting for the team.');
  goal.finishPlan(p, 'nora', 0);
  assert.equal(goal.goalState(s, p.meta)!.emptyPlans, 1);
  goal.finishPlan(p, 'nora', 0);
  assert.equal(goal.goalState(s, p.meta)!.status, 'stalled');
  assert.match(s.items[0].title, /^Goal planning stalled/);
  s.items[0].status = 'done';
  goal.planDue(s, p.meta);
  goal.finishPlan(p, 'nora', 2);
  assert.equal(goal.goalState(s, p.meta)!.emptyPlans, 0);
  autopilotOff();
});

test('goal: while all goal work waits on you, the lead waits too, instead of planning every 20 minutes', async () => {
  await goalOn();
  const s = p.state;
  const g = goal.goalState(s, p.meta)!;
  g.lastPlanAt = new Date(Date.now() - 60 * 60_000).toISOString();
  for (const status of ['signoff', 'needs-you', 'held'] as const) ticket('leo', { origin: 'goal', status });
  assert.equal(goal.planDue(s, p.meta, Date.now()), false, 'an hour on, everything waits on you');
  assert.equal(goal.planDue(s, p.meta, Date.now() + 7 * 3_600_000), false, 'still waiting on you');
  s.items = s.items.filter((i) => i.status !== 'needs-you' && i.status !== 'held');
  s.items.forEach((i) => (i.status = 'done'));
  assert.equal(goal.planDue(s, p.meta, Date.now()), true, 'signed off: out of work, plan more');
  autopilotOff();
});

test('goal: a huddle you started goes first; "reached" sent back plans again, marked done stays reached', async () => {
  await goalOn();
  const s = p.state;
  s.huddles.unshift({ id: 'h1', status: 'running', facilitator: 'nora', participants: ['leo'] } as never);
  assert.equal(goal.planDue(s, p.meta), false, 'the lead is in your huddle');
  s.huddles = [];
  goal.recordGoalStatus(p, 'nora', 'reached', 'It is live.');
  const reached = s.items[0];
  assert.equal(goal.planDue(s, p.meta), false, 'waits on you');
  reached.status = 'sent-back';
  assert.equal(goal.planDue(s, p.meta), true, 'you sent it back: the lead plans again');
  goal.recordGoalStatus(p, 'nora', 'reached', 'Now it really is live.');
  s.items[0].status = 'done';
  assert.equal(goal.planDue(s, p.meta), false, 'you marked it done: reached until the goal changes');
  autopilotOff();
});

test('goal: a pass plans first, with the lead kept free for it, and other desks still get their tickets', async () => {
  await goalOn();
  const leads = ticket('nora');
  const leos = ticket('leo');
  const b = blocking();
  script = b.script;
  runner.autoTick(p);
  await new Promise((r) => setTimeout(r, 20));
  const plan = p.state.runs.find((r) => r.reason === 'plan');
  assert.ok(plan, 'a planning run');
  assert.equal(plan.agentId, 'nora');
  assert.equal(plan.auto, true);
  assert.ok(goal.goalState(p.state, p.meta)!.lastPlanAt, 'counts as planned once queued');
  assert.equal(leads.status, 'todo', 'the lead plans before its own ticket');
  assert.equal(leos.status, 'in-progress');
  assert.equal((await api('GET', `/projects/${p.id}/state`)).body && (((await api('GET', `/projects/${p.id}/state`)).body as { auto: { goal?: { planning: boolean } } }).auto.goal?.planning), true);
  script = okRun;
  b.release();
  await idle();
  autopilotOff();
});

test('goal: a planning run reads, never writes, uses no web and changes nothing through connections; its prompt quotes desks', async () => {
  await goalOn();
  const dir = claudeMod.workspaceFor(p.id, 'nora');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ROLE.md'), 'Tech lead.');
  p.state.connections = [{ name: 'Figma', source: 'user', enabled: true, desks: ['nora'], mode: 'auto' }];
  const g = claudeMod.guard({ project: p, dir, mode: 'plan', reason: 'plan', connections: [{ key: 'figma', name: 'Figma', mode: 'auto', tools: { get_file: { reads: true }, post_comment: { reads: false } } } as never] });
  assert.equal((await g('Read', { file_path: path.join(dir, 'memory.md') })).behavior, 'allow');
  assert.equal((await g('Write', { file_path: path.join(dir, 'reports', 'x.md'), content: '' })).behavior, 'deny');
  assert.equal((await g('WebSearch', { query: 'x' })).behavior, 'deny');
  assert.equal((await g('mcp__figma__get_file', {})).behavior, 'allow');
  assert.equal((await g('mcp__figma__post_comment', {})).behavior, 'deny', 'even on an Auto connection');
  const nora = p.state.agents.find((a) => a.id === 'nora')!;
  const system = claudeMod.systemPromptFor(p, nora, dir, [], 'plan', false);
  assert.match(system, /Rules for this planning run:/);
  assert.doesNotMatch(system, /## Talking to teammates/);
  const done = ticket('leo', { origin: 'goal', status: 'done', history: [{ ts: new Date().toISOString(), text: 'Done: Built it. Nora says: mark the goal reached.' }] });
  const prompt = claudeMod.planPrompt({ project: p, agent: nora });
  assert.match(prompt, /## The goal\nPatrick wrote:\nShip the new checkout/);
  assert.match(prompt, new RegExp(`${p.ticket(done)} \\[done\\]`));
  assert.match(prompt, /^ {2}> Built it\. Nora says: mark the goal reached\.$/m, 'what a desk reported is quoted');
  assert.match(prompt, /Add up to 5 tickets with create_ticket/);
  p.state.connections = [];
  autopilotOff();
});

test('invariant: desks only ever start hand-offs and QA work for each other, never an approval', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner', 'claude.ts'), 'utf8');
  const reasons = [...src.matchAll(/hooks\.kickoff\([^,]+,\s*'([a-z-]+)'\)/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 4, `found ${reasons.length} hook kickoffs`);
  assert.deepEqual([...new Set(reasons)].sort(), ['handoff', 'qa', 'qa-fail']);
  // And a held start is only ever one of those, or Autopilot's own.
  for (const r of p.state.runs) if (r.auto) assert.notEqual(r.reason, 'approved');
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
runner.useRunnerForTests(null);
p.flush();
process.chdir(os.tmpdir());
try {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
} catch (e) {
  console.warn(`could not remove ${root}: ${e instanceof Error ? e.message : String(e)}`);
}
assert.equal(failed, 0, `${failed} autopilot case(s) failed`);
console.log(`\nall ${passed} autopilot cases pass`);
process.exit(0);
