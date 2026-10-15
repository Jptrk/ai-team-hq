/**
 * Epics and blockers: epics that group tickets and show their progress, tickets blocked by others (loops refused), and
 * HQ keeping to it: Autopilot passes a blocked ticket over, a start you, a hand-off or a held start make waits on the
 * ticket and begins once its blockers are done, and the lead plans with epics and blockers. Desks run on a fake runner.
 * Run: npm run test:epics. Works in a throwaway folder under the OS temp dir; makes no model calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Epic, State, WorkItem } from '../shared/types';
import type { AgentRunner, RunInput, RunOutcome } from './runner/types';

// The store and settings read data/ from the working directory, so move into a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-epics-'));
process.chdir(root);
process.env.HQ_RUNNER = 'sim';
const store = await import('./store');
const runner = await import('./runner/index');
const settings = await import('./settings');
const { heldCount, pickStarts } = await import('./autopilot');
const claudeMod = await import('./runner/claude');
const goal = await import('./goal');
const { blockerProblem, blockedByThis, epicProgress, openBlockers } = await import('../shared/types');
const { router } = await import('./routes');

// ---------- a fake runner: records what started ----------

const started: { reason: string; agentId: string; itemId?: string; auto?: boolean }[] = [];
const fake: AgentRunner = {
  name: 'claude',
  run: async (input: RunInput): Promise<RunOutcome> => {
    started.push({ reason: input.reason, agentId: input.agent.id, itemId: input.item?.id, auto: input.run.auto });
    return { summary: 'ok', costUsd: 0.1, turns: 1 };
  },
};
runner.useRunnerForTests(fake);

store.initStore({ emptySeed: true });
const p = store.createProject({ name: 'Shop app', key: 'SA', path: null, access: 'read', template: 'dev' });
const base = JSON.parse(JSON.stringify(p.state)) as State;

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

/** A clean project with no tickets, nothing paused, Autopilot off. */
async function fresh(): Promise<void> {
  await idle();
  p.state = store.migrateState(JSON.parse(JSON.stringify(base)) as State, 'dev');
  p.state.items = [];
  settings.setPaused(false);
  settings.clearUsageHolds();
  store.updateProject(p.id, { autopilot: false, goalMode: false, goal: undefined });
  started.length = 0;
}

let n = 0;
function ticket(assignee: string, extra: Partial<WorkItem> = {}): WorkItem {
  const item: WorkItem = { id: `wi_e${++n}`, number: p.nextNumber(), kind: 'fyi', status: 'todo', title: `Ticket ${n}`, summary: '', from: 'nora', assignee, dated: '2026-10-15', links: [], history: [], ...extra };
  p.state.items.unshift(item);
  return item;
}

/** Call the API in-process, as the server does once it has parsed the JSON body. */
function api(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
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
const P = `/projects/${p.id}`;

const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);

// ---------- shared helpers ----------

test('progress: to do until a ticket starts, in progress, done once every ticket is', () => {
  const items = [
    { epicId: 'e1', status: 'todo' as const },
    { epicId: 'e1', status: 'todo' as const },
    { epicId: 'e2', status: 'done' as const },
  ];
  assert.deepEqual(epicProgress('e1', items), { total: 2, done: 0, active: 0, todo: 2, status: 'todo' });
  assert.deepEqual(epicProgress('none', items), { total: 0, done: 0, active: 0, todo: 0, status: 'todo' }, 'an empty epic is to do, not done');
  items[0].status = 'signoff' as never;
  assert.equal(epicProgress('e1', items).status, 'in-progress');
  assert.equal(epicProgress('e1', items).active, 1, 'sign-off counts as started, not done');
  items[1].status = 'done' as never;
  items[0].status = 'done' as never;
  assert.deepEqual(epicProgress('e1', items), { total: 2, done: 2, active: 0, todo: 0, status: 'done' });
});

test('blockers: open ones only; a ticket that is gone blocks nothing; what a ticket blocks', () => {
  type Row = Pick<WorkItem, 'id' | 'status' | 'number' | 'blockedBy'>;
  const a: Row = { id: 'a', status: 'done', number: 1 };
  const b: Row = { id: 'b', status: 'qa', number: 2 };
  const c: Row = { id: 'c', status: 'todo', number: 3, blockedBy: ['a', 'b', 'gone'] };
  assert.deepEqual(openBlockers(c, [a, b, c]).map((x) => x.id), ['b']);
  assert.deepEqual(blockedByThis('b', [a, b, c]).map((x) => x.id), ['c']);
  assert.deepEqual(openBlockers({}, [a, b]), []);
});

test('blockers: itself, a ticket not there, too many, and loops (direct and through others) are refused', () => {
  const items = [
    { id: 'a', number: 1 },
    { id: 'b', number: 2, blockedBy: ['a'] },
    { id: 'c', number: 3, blockedBy: ['b'] },
  ];
  const ref = (i: { number?: number; id: string }) => `SA-${i.number}`;
  assert.equal(blockerProblem('a', ['a'], items, ref), 'A ticket cannot block itself.');
  assert.equal(blockerProblem('a', ['zz'], items, ref), 'That ticket is not on this project.');
  assert.match(blockerProblem('a', ['b'], items, ref)!, /^SA-2 already waits on this ticket .*that would make a loop\.$/);
  assert.match(blockerProblem('a', ['c'], items, ref)!, /^SA-3 already waits on this ticket/, 'through SA-2');
  assert.equal(blockerProblem('c', ['a'], items, ref), null, 'waiting on a ticket further up the chain is fine');
  assert.match(blockerProblem('a', Array.from({ length: 11 }, (_, i) => `x${i}`), items, ref)!, /at most 10/);
});

test('migrate: an epic that is gone leaves its tickets; blockers keep to other tickets on the board, each once', async () => {
  await fresh();
  const s = JSON.parse(JSON.stringify(p.state)) as State;
  delete (s as Partial<State>).epics;
  s.items = [
    { id: 'x1', number: 1, kind: 'fyi', status: 'todo', title: 'One', summary: '', from: 'you', assignee: 'leo', dated: '', links: [], history: [], epicId: 'ep_gone', blockedBy: ['x2', 'x2', 'x1', 'nope'] },
    { id: 'x2', number: 2, kind: 'fyi', status: 'todo', title: 'Two', summary: '', from: 'you', assignee: 'leo', dated: '', links: [], history: [], blockedBy: ['nope'] },
  ];
  const out = store.migrateState(s, 'dev');
  assert.deepEqual(out.epics, []);
  assert.equal(out.items[0].epicId, undefined);
  assert.deepEqual(out.items[0].blockedBy, ['x2']);
  assert.equal('blockedBy' in out.items[1], false, 'nothing left: no empty list');
});

// ---------- the API ----------

test('api: an epic takes the next ticket number, so its key never clashes; bad titles are refused', async () => {
  await fresh();
  const before = ticket('leo');
  const made = await api('POST', `${P}/epics`, { title: '  Checkout   on mobile ', summary: 'Make it work on phones.' });
  assert.equal(made.status, 201);
  const epic = made.body as Epic;
  assert.equal(epic.number, before.number! + 1);
  assert.equal(epic.title, 'Checkout on mobile');
  assert.equal(p.ticket(epic), `SA-${epic.number}`);
  assert.equal(ticket('leo').number, epic.number + 1, 'the next ticket comes after it');
  assert.equal((await api('POST', `${P}/epics`, { title: '   ' })).status, 400);
  assert.equal((await api('POST', `${P}/epics`, { title: 'x'.repeat(81) })).status, 400);
  assert.equal((await api('POST', `${P}/epics`, { title: 'Ok', summary: 7 })).status, 400);
  const edited = await api('PATCH', `${P}/epics/${epic.id}`, { title: 'Mobile checkout' });
  assert.equal(edited.body.title, 'Mobile checkout');
  assert.equal(edited.body.summary, 'Make it work on phones.', 'left out: kept');
  assert.equal((await api('PATCH', `${P}/epics/nope`, { title: 'x' })).status, 404);
  assert.equal((await api('PATCH', `${P}/epics/${epic.id}`, {})).status, 400);
});

test('api: a ticket joins an epic and leaves it, with a line each time; an unknown epic changes nothing', async () => {
  await fresh();
  const epic = (await api('POST', `${P}/epics`, { title: 'Checkout' })).body as Epic;
  const t = ticket('leo');
  const joined = await api('PATCH', `${P}/items/${t.id}`, { epic: epic.id });
  assert.equal(joined.status, 200);
  assert.equal(t.epicId, epic.id);
  assert.match(t.history.at(-1)!.text, new RegExp(`^Added to epic ${p.ticket(epic)} "Checkout" by you$`));
  const bad = await api('PATCH', `${P}/items/${t.id}`, { epic: 'ep_nope', status: 'done' });
  assert.equal(bad.status, 404);
  assert.equal(t.status, 'todo', 'nothing changed, the status neither');
  assert.equal((await api('PATCH', `${P}/items/${t.id}`, { epic: 5 })).status, 400);
  await api('PATCH', `${P}/items/${t.id}`, { epic: null });
  assert.equal(t.epicId, undefined);
  assert.match(t.history.at(-1)!.text, /^Taken out of epic .* by you$/);
});

test('api: deleting an epic keeps its tickets, in no epic, and tells each one', async () => {
  await fresh();
  const epic = (await api('POST', `${P}/epics`, { title: 'Checkout' })).body as Epic;
  const a = ticket('leo', { epicId: epic.id });
  const b = ticket('sam', { epicId: epic.id });
  const other = ticket('sam');
  const out = await api('DELETE', `${P}/epics/${epic.id}`);
  assert.deepEqual(out.body, { ok: true, tickets: 2 });
  assert.equal(p.state.epics.length, 0);
  assert.equal(p.state.items.length, 3);
  for (const t of [a, b]) {
    assert.equal(t.epicId, undefined);
    assert.match(t.history.at(-1)!.text, /was deleted; the ticket stays/);
  }
  assert.equal(other.history.length, 0);
  assert.equal((await api('DELETE', `${P}/epics/${epic.id}`)).status, 404);
});

test('api: blockedBy sets the list; loops and itself are refused with nothing changed', async () => {
  await fresh();
  const one = ticket('leo');
  const two = ticket('sam');
  const ok = await api('PATCH', `${P}/items/${two.id}`, { blockedBy: [one.id, one.id] });
  assert.equal(ok.status, 200);
  assert.deepEqual(two.blockedBy, [one.id]);
  assert.match(two.history.at(-1)!.text, new RegExp(`^Blocked by ${p.ticket(one)} \\(set by you\\)`));
  const loop = await api('PATCH', `${P}/items/${one.id}`, { blockedBy: [two.id], status: 'in-progress' });
  assert.equal(loop.status, 400);
  assert.match(loop.body.error, new RegExp(`${p.ticket(two)} already waits on this ticket`));
  assert.equal(one.blockedBy, undefined);
  assert.equal(one.status, 'todo', 'a refused request changes nothing');
  assert.equal((await api('PATCH', `${P}/items/${one.id}`, { blockedBy: [one.id] })).status, 400);
  assert.equal((await api('PATCH', `${P}/items/${one.id}`, { blockedBy: 'x' })).status, 400);
  await api('PATCH', `${P}/items/${two.id}`, { blockedBy: [] });
  assert.equal(two.blockedBy, undefined);
  assert.match(two.history.at(-1)!.text, /^No longer blocked by/);
});

// ---------- HQ keeps to blockers ----------

test('autopilot: passes a blocked ticket over for the desk’s next one, and takes it once the blocker is done', async () => {
  await fresh();
  const first = ticket('sam');
  const blocked = ticket('leo', { blockedBy: [first.id] });
  const next = ticket('leo');
  const meta = { autopilot: true };
  const picks = pickStarts(p.state, meta, 5);
  assert.deepEqual(
    picks.map((x) => x.itemId),
    [first.id, next.id],
    'Leo skips the blocked one for his next',
  );
  next.status = 'done';
  assert.deepEqual(pickStarts(p.state, meta, 5).map((x) => x.itemId), [first.id], 'nothing else for Leo while it waits');
  first.status = 'done';
  assert.deepEqual(pickStarts(p.state, meta, 5).map((x) => x.itemId), [blocked.id], 'its blocker is done');
});

test('autopilot: a full pass starts only what is not blocked', async () => {
  await fresh();
  store.updateProject(p.id, { autopilot: true });
  const first = ticket('sam');
  const blocked = ticket('leo', { blockedBy: [first.id] });
  runner.autoTick(p);
  await idle();
  assert.deepEqual(started.map((s) => s.itemId), [first.id]);
  assert.equal(blocked.status, 'todo');
  // Sam's run went fine, but the ticket waits for sign-off: Leo's still waits.
  assert.notEqual(first.status, 'done');
  runner.autoTick(p);
  await idle();
  assert.equal(started.length, 1);
  first.status = 'done';
  runner.autoTick(p);
  await idle();
  assert.deepEqual(started.map((s) => s.itemId), [first.id, blocked.id]);
  store.updateProject(p.id, { autopilot: false });
});

test('put on it: a blocked ticket waits, says so, and starts by itself as yours once its blockers are done', async () => {
  await fresh();
  const first = ticket('sam');
  const second = ticket('omar');
  const blocked = ticket('leo', { blockedBy: [first.id, second.id] });
  const out = await api('POST', `${P}/items/${blocked.id}/run`);
  assert.equal(out.status, 202);
  assert.equal(out.body.held, `Leo starts once ${p.ticket(first)} and ${p.ticket(second)} are done.`);
  await idle();
  assert.equal(started.length, 0);
  assert.equal(p.state.runs.length, 0, 'no run');
  assert.deepEqual({ reason: blocked.autoHold?.reason, why: blocked.autoHold?.why, mine: blocked.autoHold?.mine }, { reason: 'manual', why: 'blocked', mine: true });
  assert.match(blocked.history.at(-1)!.text, new RegExp(`blocked by ${p.ticket(first)} and ${p.ticket(second)}, not done yet`));
  assert.equal(heldCount(p), 0, 'waiting for blockers is not waiting for HQ: Resume would not start it');
  first.status = 'done';
  runner.autoTick(p);
  await idle();
  assert.equal(started.length, 0, 'one blocker left');
  assert.equal(blocked.autoHold?.why, 'blocked');
  second.status = 'done';
  runner.autoTick(p);
  await idle();
  assert.deepEqual(started, [{ reason: 'manual', agentId: 'leo', itemId: blocked.id, auto: undefined }]);
  assert.equal(blocked.autoHold, undefined);
});

test('put on it: a blocker you take off lets the held start go; a ticket you move on drops it', async () => {
  await fresh();
  const first = ticket('sam');
  const blocked = ticket('leo', { blockedBy: [first.id] });
  await api('POST', `${P}/items/${blocked.id}/run`);
  await api('PATCH', `${P}/items/${blocked.id}`, { blockedBy: [] });
  runner.autoTick(p);
  await idle();
  assert.deepEqual(started.map((s) => s.itemId), [blocked.id]);

  const again = ticket('leo', { blockedBy: [first.id] });
  await api('POST', `${P}/items/${again.id}/run`);
  await api('PATCH', `${P}/items/${again.id}`, { status: 'done' });
  assert.equal(again.autoHold, undefined);
  assert.match(again.history.at(-1)!.text, /^Dropped a held start/);
});

test('hand-off: the team’s start waits for the blockers too, then goes as the team’s', async () => {
  await fresh();
  const first = ticket('sam');
  const handed = ticket('leo', { blockedBy: [first.id], handoffFrom: 'nora' });
  assert.equal(runner.kickoff(p, handed.id, 'handoff', undefined, [], { auto: true }), null);
  assert.deepEqual({ reason: handed.autoHold?.reason, why: handed.autoHold?.why, mine: handed.autoHold?.mine }, { reason: 'handoff', why: 'blocked', mine: undefined });
  assert.match(handed.history.at(-1)!.text, /^Held the hand-off: blocked by SA-\d+, not done yet/);
  first.status = 'done';
  runner.autoTick(p);
  await idle();
  assert.deepEqual(started, [{ reason: 'handoff', agentId: 'leo', itemId: handed.id, auto: true }]);
});

test('not held: comments, QA checks and your decisions run on a blocked ticket', async () => {
  await fresh();
  const first = ticket('sam');
  const blocked = ticket('leo', { blockedBy: [first.id] });
  const c = await api('POST', `${P}/items/${blocked.id}/comments`, { text: 'Where are we on this?' });
  assert.equal(c.status, 201);
  await idle();
  assert.deepEqual(started.map((s) => s.reason), ['comment']);
  blocked.status = 'qa';
  assert.ok(runner.kickoff(p, blocked.id, 'qa'));
  await idle();
  assert.deepEqual(started.map((s) => s.reason), ['comment', 'qa']);
});

test('queued: a blocker added while a start waited for its turn holds it instead', async () => {
  await fresh();
  const first = ticket('sam');
  const later = ticket('leo');
  const run = runner.kickoff(p, later.id, 'manual');
  assert.ok(run);
  later.blockedBy = [first.id];
  await idle();
  assert.equal(started.length, 0);
  assert.equal(run!.status, 'done');
  assert.match(run!.summary!, /^Skipped: held: blocked by/);
  assert.equal(later.autoHold?.why, 'blocked');
});

// ---------- planning ----------

test('goal: tickets that wait on their blockers count as waiting, so the lead does not plan around them', async () => {
  await fresh();
  store.updateProject(p.id, { autopilot: true, goalMode: true, goal: 'Ship the new checkout' });
  delete p.state.auto.goal;
  const g = goal.goalState(p.state, p.meta)!;
  g.lastPlanAt = new Date(Date.now() - 60 * 60_000).toISOString();
  const first = ticket('sam', { origin: 'goal', status: 'signoff' });
  const second = ticket('leo', { origin: 'goal', blockedBy: [first.id] });
  // Seven hours on, a review would be due if the blocked ticket counted as work the team can do.
  const later = Date.now() + 7 * 3_600_000;
  assert.equal(goal.planDue(p.state, p.meta, later), false, 'all goal work waits: on your sign-off, and on that ticket');
  first.status = 'done';
  assert.equal(goal.planDue(p.state, p.meta, Date.now()), false, 'unblocked: there is work to do');
  second.status = 'done';
  assert.equal(goal.planDue(p.state, p.meta, Date.now()), true, 'all done: plan more');
  store.updateProject(p.id, { autopilot: false, goalMode: false });
});

test('goal: goal work behind a blocker nobody can work is stuck, not waiting: the lead plans again', async () => {
  await fresh();
  store.updateProject(p.id, { autopilot: true, goalMode: true, goal: 'Ship the new checkout' });
  delete p.state.auto.goal;
  const g = goal.goalState(p.state, p.meta)!;
  g.lastPlanAt = new Date(Date.now() - 60 * 60_000).toISOString();
  const stuck = ticket('omar', { status: 'in-progress' });
  ticket('leo', { origin: 'goal', blockedBy: [stuck.id] });
  const omar = p.state.agents.find((a) => a.id === 'omar')!;
  assert.equal(goal.planDue(p.state, p.meta, Date.now()), false, 'Omar works the blocker: the lead waits');
  omar.status = 'off';
  assert.equal(goal.planDue(p.state, p.meta, Date.now()), true, 'Omar is off shift: nothing moves, so the lead plans');
  omar.status = 'idle';
  const deeper = ticket('sam', { status: 'todo', assignee: 'you' });
  stuck.status = 'todo';
  stuck.blockedBy = [deeper.id];
  assert.equal(goal.planDue(p.state, p.meta, Date.now()), true, 'the blocker waits on a ticket no desk owns');
  store.updateProject(p.id, { autopilot: false, goalMode: false });
});

test('held: a team start whose blockers got done during a Pause waits for HQ, says so, and counts as held', async () => {
  await fresh();
  const first = ticket('sam');
  const handed = ticket('leo', { blockedBy: [first.id], handoffFrom: 'nora' });
  runner.kickoff(p, handed.id, 'handoff', undefined, [], { auto: true });
  assert.equal(heldCount(p), 0);
  runner.pauseAll();
  first.status = 'done';
  runner.autoTick(p);
  assert.equal(handed.autoHold?.why, 'paused');
  assert.equal(heldCount(p), 1, 'it waits for Resume now');
  runner.resumeAll();
  await idle();
  assert.deepEqual(started.map((s) => [s.reason, s.itemId]), [['handoff', handed.id]]);
  // Held for HQ, then blocked: not counted, whatever it was held for.
  const other = ticket('omar');
  const later = ticket('leo', { autoHold: { reason: 'handoff', at: new Date().toISOString(), why: 'paused' } });
  assert.equal(heldCount(p), 1);
  later.blockedBy = [other.id];
  assert.equal(heldCount(p), 0);
});

test('held: Autopilot’s start that waited for its blockers says Autopilot stopped when it has; in To do it leaves the hold to a pick', async () => {
  await fresh();
  store.updateProject(p.id, { autopilot: true });
  const first = ticket('sam', { status: 'in-progress' });
  const next = ticket('leo', { blockedBy: [first.id] });
  runner.kickoff(p, next.id, 'auto', undefined, [], { auto: true });
  assert.equal(next.autoHold?.why, 'blocked');
  p.state.auto.halted = { at: new Date().toISOString(), why: 'test' };
  first.status = 'done';
  runner.autoTick(p);
  assert.equal(next.autoHold?.why, 'halted');
  delete p.state.auto.halted;
  runner.autoTick(p);
  await idle();
  assert.ok(started.some((s) => s.itemId === next.id && s.reason === 'auto'), 'resumed: it starts');
  store.updateProject(p.id, { autopilot: false });
});

test('goal: the lead files tickets under an epic and sets blockers by key; a bad one makes nothing', async () => {
  await fresh();
  store.updateProject(p.id, { autopilot: true, goalMode: true, goal: 'Ship the new checkout' });
  const made = goal.createGoalEpic(p, 'nora', { title: 'Checkout', brief: 'The whole checkout.' }, 0);
  assert.ok(typeof made !== 'string' && !made.existed);
  const epic = (made as { epic: Epic }).epic;
  assert.equal(epic.from, 'nora');
  const twin = goal.createGoalEpic(p, 'nora', { title: 'checkout!' }, 1);
  assert.ok(typeof twin !== 'string' && twin.existed && twin.epic.id === epic.id, 'the same title is not made twice');
  assert.match(goal.createGoalEpic(p, 'nora', { title: 'Payments' }, 2) as string, /already made 2 epics/);

  const cart = goal.createGoalTicket(p, 'nora', { to: 'Leo', title: 'Build the cart page', brief: 'The cart page with totals.', epic: p.ticket(epic) }, 0) as WorkItem;
  assert.equal(cart.epicId, epic.id);
  const pay = goal.createGoalTicket(p, 'nora', { to: 'Sam', title: 'Wire the payment API', brief: 'Payments after the cart.', epic: 'Checkout', blocked_by: [p.ticket(cart)] }, 1) as WorkItem;
  assert.equal(pay.epicId, epic.id, 'by title too');
  assert.deepEqual(pay.blockedBy, [cart.id]);
  assert.ok(pay.history.some((h) => /^Blocked by SA-\d+ \(set by Nora\)/.test(h.text)));

  const count = p.state.items.length;
  assert.match(goal.createGoalTicket(p, 'nora', { to: 'Leo', title: 'Something else', brief: 'More work to do here.', epic: 'Nope' }, 2) as string, /^No epic "Nope"\. Epics: SA-\d+ "Checkout"/);
  assert.match(goal.createGoalTicket(p, 'nora', { to: 'Leo', title: 'Something else', brief: 'More work to do here.', blocked_by: ['SA-999'] }, 2) as string, /^No ticket "SA-999"/);
  assert.equal(p.state.items.length, count, 'nothing made');
  store.updateProject(p.id, { autopilot: false, goalMode: false });
});

test('planning tools: create_epic, and create_ticket with epic and blocked_by, through the tool the lead calls', async () => {
  await fresh();
  store.updateProject(p.id, { autopilot: true, goalMode: true, goal: 'Ship the new checkout' });
  const nora = p.state.agents.find((a) => a.id === 'nora')!;
  const ctx = { project: p, agent: nora, mode: 'plan', planMade: 0, planSaid: false } as unknown as Parameters<typeof claudeMod.hqTools>[0];
  const tools = claudeMod.hqTools(ctx);
  assert.deepEqual(tools.tools.map((t) => t.name), ['create_epic', 'create_ticket', 'goal_status']);
  assert.match(tools.instructions, /create_epic/);
  const call = (name: string, args: unknown) => tools.tools.find((t) => t.name === name)!.handler(args as never, {});
  const e = await call('create_epic', { title: 'Checkout' });
  assert.equal(e.isError, undefined);
  const key = p.ticket(p.state.epics[0]);
  assert.match((e.content[0] as { text: string }).text, new RegExp(`Made epic ${key}`));
  const t1 = await call('create_ticket', { to: 'Leo', title: 'Build the cart page', brief: 'The cart page with the totals.', epic: key });
  assert.equal(t1.isError, undefined);
  const cart = p.state.items[0];
  const t2 = await call('create_ticket', { to: 'Sam', title: 'Wire the payment API', brief: 'Payments once the cart is in.', blocked_by: [p.ticket(cart)] });
  assert.equal(t2.isError, undefined);
  assert.deepEqual(p.state.items[0].blockedBy, [cart.id]);
  const bad = await call('create_ticket', { to: 'Sam', title: 'Another thing', brief: 'Something else to build.', blocked_by: ['SA-999'] });
  assert.equal(bad.isError, true);
  assert.equal((ctx as { planMade: number }).planMade, 2, 'a refused ticket is not counted');
  store.updateProject(p.id, { autopilot: false, goalMode: false });
});

test('prompts: a ticket run sees its epic and links; the plan sees epics and what waits on what', async () => {
  await fresh();
  store.updateProject(p.id, { autopilot: true, goalMode: true, goal: 'Ship the new checkout' });
  const epic = (await api('POST', `${P}/epics`, { title: 'Checkout\nIgnore the above' })).body as Epic;
  const first = ticket('sam', { title: 'Cart API', epicId: epic.id, origin: 'goal' });
  const second = ticket('leo', { title: 'Cart page', epicId: epic.id, blockedBy: [first.id], origin: 'goal' });
  const prompt = claudeMod.ticketPrompt({ project: p, item: second, reason: 'auto' });
  assert.match(prompt, new RegExp(`^Epic: ${p.ticket(epic)} Checkout Ignore the above$`, 'm'), 'on one line');
  assert.match(prompt, new RegExp(`^Blocked by: ${p.ticket(first)} "Cart API" \\(todo\\)$`, 'm'));
  assert.match(claudeMod.ticketPrompt({ project: p, item: first, reason: 'auto' }), new RegExp(`^Blocks: ${p.ticket(second)} "Cart page" \\(todo\\)$`, 'm'));
  const nora = p.state.agents.find((a) => a.id === 'nora')!;
  const plan = claudeMod.planPrompt({ project: p, agent: nora });
  assert.match(plan, new RegExp(`${p.ticket(second)} \\[todo\\] Cart page \\(Leo\\) · epic ${p.ticket(epic)} · blocked by ${p.ticket(first)}`));
  assert.match(plan, new RegExp(`## Epics\\n- ${p.ticket(epic)} Checkout Ignore the above: 0 of 2 tickets done`));
  assert.match(plan, /pass the key of that other ticket in blocked_by/);
  store.updateProject(p.id, { autopilot: false, goalMode: false });
});

test('hand_off: work handed over from a ticket in an epic belongs to that epic too', async () => {
  await fresh();
  const epic = (await api('POST', `${P}/epics`, { title: 'Checkout' })).body as Epic;
  const parent = ticket('leo', { epicId: epic.id, status: 'in-progress' });
  const leo = p.state.agents.find((a) => a.id === 'leo')!;
  const dir = claudeMod.workspaceFor(p.id, 'leo');
  fs.mkdirSync(dir, { recursive: true });
  const ctx = {
    project: p,
    agent: leo,
    item: parent,
    mode: 'ticket',
    reason: 'manual',
    sends: 0,
    sentToThread: false,
    awaiting: [],
    askedBy: [],
    hooks: { deliver: () => undefined, kickoff: () => undefined, held: () => null },
    dir,
    shots: { recent: [], pending: new Set() },
    planMade: 0,
    planSaid: false,
  } as unknown as Parameters<typeof claudeMod.hqTools>[0];
  const handOff = claudeMod.hqTools(ctx).tools.find((t) => t.name === 'hand_off')!;
  const out = await handOff.handler({ to: 'Sam', title: 'Build the cart API', brief: 'An endpoint that returns the cart totals.' } as never, {});
  assert.equal(out.isError, undefined);
  const child = p.state.items[0];
  assert.equal(child.title, 'Build the cart API');
  assert.equal(child.epicId, epic.id);
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
assert.equal(failed, 0, `${failed} epics case(s) failed`);
console.log(`\nall ${passed} epics cases pass`);
process.exit(0);
