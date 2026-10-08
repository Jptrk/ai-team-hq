/**
 * Idle: HQ can't go live (no Claude login to run on) but the projects are real, so there is no sim. What you start
 * waits on its ticket or thread, with what you gave it, and starts as your own click once HQ is live; huddles don't
 * start; HQ remembers it went live.
 * Run: npm run test:idle. Works in a throwaway folder under the OS temp dir; makes no Claude calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Attachment, Huddle, State, WorkItem } from '../shared/types';
import type { AgentRunner, RunInput } from './runner/types';

// The store and settings read data/ from the working directory, so move into a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-idle-'));
process.chdir(root);
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-config');
delete process.env.HQ_RUNNER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const store = await import('./store');
const chat = await import('./chat');
const runner = await import('./runner/index');
const settings = await import('./settings');
const engine = await import('./huddles');
const { localDay } = await import('../shared/types');
const { holdText, runnerLabel } = await import('../src/util');

// As at boot with no key, no login and no yes: sim. A test process can't reach idle by itself after that pick.
assert.equal(runner.runnerName(), 'sim');
assert.equal(runner.isIdle(), false);
runner.setIdleForTests(true);

interface Started {
  reason: string;
  agentId: string;
  itemId?: string;
  threadId?: string;
  note?: string;
  images?: number;
  notes?: boolean;
  auto?: boolean;
}
const started: Started[] = [];
const fake: AgentRunner = {
  name: 'claude',
  run: async (input: RunInput) => {
    started.push({
      reason: input.reason,
      agentId: input.agent.id,
      itemId: input.item?.id,
      threadId: input.thread?.id,
      note: input.note,
      images: input.images?.length ?? 0,
      notes: Boolean(input.includeNotes),
      auto: Boolean(input.run.auto),
    });
    return { summary: 'ok', costUsd: 0, turns: 1 };
  },
};

store.initStore({ emptySeed: true });
const p = store.createProject({ name: 'Shop app', key: 'SA', path: null, access: 'read', template: 'dev' });
const base = JSON.parse(JSON.stringify(p.state)) as State;

function fresh(): void {
  runner.useRunnerForTests(null);
  runner.setIdleForTests(true);
  p.state = store.migrateState(JSON.parse(JSON.stringify(base)) as State, 'dev');
  settings.setPaused(false);
  settings.setUsageHold(null);
  started.length = 0;
}

/** Waits until no run is queued or running. */
async function settle(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (!p.state.runs.some((r) => r.status === 'queued' || r.status === 'running')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('runs never finished');
}

let n = 0;
function ticket(assignee: string, extra: Partial<WorkItem> = {}): WorkItem {
  const item: WorkItem = { id: `wi_i${++n}`, number: 100 + n, kind: 'fyi', status: 'in-progress', title: `Ticket ${n}`, summary: '', from: 'you', assignee, dated: '2026-10-08', links: [], history: [], ...extra };
  p.state.items.unshift(item);
  return item;
}

const image: Attachment = { id: 'att1', file: 'att1.png', type: 'image/png', size: 10, by: 'you', ts: '2026-10-08T10:00:00.000Z' };

/** HQ restarted with a login: live, on the fake runner. */
function goLive(): void {
  runner.setIdleForTests(false);
  runner.useRunnerForTests(fake);
}

const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);

test('meta: idle, not live, and the page says so', () => {
  fresh();
  const m = runner.meta();
  assert.equal(m.idle, true);
  assert.equal(m.runner, 'sim');
  assert.equal(runner.isLive(), false);
  assert.equal(runnerLabel(m), 'Not live');
  assert.match(runner.notLiveText(), /no login to run desks on.*sign in to Claude or ChatGPT.*then restart HQ/);
});

test('a start you make waits on its ticket, says why, and starts as your own click once HQ is live', async () => {
  fresh();
  const item = ticket('leo');
  assert.equal(runner.kickoff(p, item.id, 'instruction'), null);
  assert.equal(p.state.runs.length, 0, 'no run is queued');
  assert.deepEqual({ reason: item.autoHold?.reason, why: item.autoHold?.why, mine: item.autoHold?.mine }, { reason: 'instruction', why: 'login', mine: true });
  assert.match(item.history.at(-1)!.text, /HQ has no login to run desks on/);
  assert.match(holdText(item.autoHold!), /once HQ is live/);
  goLive();
  assert.equal(runner.releaseHolds(p), 1);
  await settle();
  assert.deepEqual(
    started.map((x) => [x.reason, x.agentId, x.itemId, x.auto]),
    [['instruction', 'leo', item.id, false]],
  );
  assert.equal(item.autoHold, undefined);
  assert.equal(p.state.auto.usage.runs, 0, "yours: not counted against the team's daily runs");
});

test('your Instruct keeps its note, images and team-notes ask; a second one without a note keeps the first note', async () => {
  fresh();
  const item = ticket('leo');
  runner.kickoff(p, item.id, 'instruct', 'Use the new API', [image], { includeNotes: true });
  runner.kickoff(p, item.id, 'instruct', undefined, []);
  assert.deepEqual({ note: item.autoHold?.note, images: item.autoHold?.images?.length, notes: item.autoHold?.notes }, { note: 'Use the new API', images: 1, notes: true });
  goLive();
  runner.releaseHolds(p);
  await settle();
  assert.deepEqual(
    started.map((x) => [x.reason, x.note, x.images, x.notes]),
    [['instruct', 'Use the new API', 1, true]],
  );
});

test("the team's daily limit used up: yours still starts", async () => {
  fresh();
  const item = ticket('sam');
  runner.kickoff(p, item.id, 'instruction');
  p.state.auto.usage = { day: localDay(), runs: 9999, usd: 0 };
  goLive();
  assert.equal(runner.releaseHolds(p), 1);
  await settle();
  assert.deepEqual(
    started.map((x) => x.reason),
    ['instruction'],
  );
});

test('paused when it goes live: yours waits for Resume, and says it waits for the Pause', async () => {
  fresh();
  const item = ticket('sam', { status: 'approved' });
  runner.kickoff(p, item.id, 'approved');
  goLive();
  settings.setPaused(true);
  assert.equal(runner.releaseHolds(p), 0);
  assert.equal(item.autoHold?.why, 'paused');
  assert.equal(item.autoHold?.mine, true);
  assert.match(holdText(item.autoHold!), /HQ is paused/);
  settings.setPaused(false);
  assert.equal(runner.releaseHolds(p), 1);
  await settle();
  assert.deepEqual(
    started.map((x) => [x.reason, x.agentId, x.auto]),
    [['approved', 'sam', false]],
  );
});

test('a comment held, then a decision takes its place: the comment still gets its answer after the work', async () => {
  fresh();
  const item = ticket('leo');
  item.comments = [{ id: 'c1', from: 'you', ts: new Date().toISOString(), text: 'Why this approach?' }];
  runner.kickoff(p, item.id, 'comment');
  assert.equal(item.autoHold?.reason, 'comment');
  // The decision route settles whatever was held before it starts its own.
  delete item.autoHold;
  runner.kickoff(p, item.id, 'instruct', 'Try the other one');
  goLive();
  runner.releaseHolds(p);
  await settle();
  assert.deepEqual(
    started.map((x) => x.reason),
    ['instruct', 'comment'],
  );
});

test('messages to a desk wait: no "replying" forever, one note however many you send, and the desk answers once HQ is live', async () => {
  fresh();
  const s = p.state;
  const t = chat.createThread(s, { title: 'Cart bug', createdBy: 'you' });
  const messages = s.messages.length;
  for (const text of ['@Sam can you check the cart API?', '@Sam and the totals?']) {
    const posted = chat.postFounderMessage(s, t, text);
    assert.deepEqual(runner.deliver(p, t.id, posted.deliver), []);
  }
  assert.equal(t.waiting.includes('sam'), false, 'Sam no longer shows as replying');
  assert.deepEqual(
    s.auto.heldWakes.map((w) => [w.agentId, w.why, w.mine]),
    [['sam', 'login', true]],
  );
  const notes = s.messages.slice(messages).filter((m) => m.from === 'hq');
  assert.deepEqual(
    notes.map((m) => m.text),
    ['Sam sees this once it clears: HQ has no login to run desks on.'],
  );
  goLive();
  p.state.auto.usage = { day: localDay(), runs: 9999, usd: 0 };
  runner.releaseHolds(p);
  await settle();
  assert.deepEqual(
    started.map((x) => [x.reason, x.agentId, x.threadId, x.auto]),
    [['message', 'sam', t.id, false]],
  );
  assert.equal(s.auto.heldWakes.length, 0);
});

test('huddles: refused to start and to resume, and nothing is written', () => {
  fresh();
  const body = { kind: 'retro', topic: 'Last two weeks', participants: ['leo', 'sam'], rounds: 1, includeNotes: false };
  const out = engine.startHuddle(p, body) as { error: string; status: number };
  assert.equal(out.status, 409);
  assert.match(out.error, /no login to run desks on/);
  assert.equal(p.state.huddles.length, 0);
  // A huddle stopped earlier stays stopped.
  const h = engine.startHuddle(p, body, async () => ({ ran: false, ok: false, skipped: true, reply: '' })) as Huddle;
  engine.stopHuddleRun(p, h.id);
  assert.match(engine.resumeHuddleRun(p, h.id) ?? '', /no login to run desks on/);
  assert.equal(p.state.huddles.find((x) => x.id === h.id)?.status, 'stopped');
});

test('settings: the yes notes HQ went live; signing out or switching it off keeps that, so a restart stays idle', () => {
  settings.setClaudeLogin(false);
  assert.equal(settings.settings().wentLive, undefined);
  settings.setClaudeLogin(true, '2026-10-08T10:00:00.000Z');
  assert.equal(settings.settings().wentLive?.at, '2026-10-08T10:00:00.000Z');
  settings.setClaudeLogin(false);
  assert.equal(settings.settings().claudeLogin, undefined);
  assert.equal(settings.settings().wentLive?.at, '2026-10-08T10:00:00.000Z', 'sign-out keeps it');
  settings.noteWentLive('2026-10-09T10:00:00.000Z');
  assert.equal(settings.settings().wentLive?.at, '2026-10-08T10:00:00.000Z', 'noted once');
  assert.deepEqual(settings.parseSettings({ wentLive: { at: 'nope' } }), {});
  assert.equal(runner.pickIdle({ runner: 'sim', optIn: false, wentLive: Boolean(settings.settings().wentLive) }), true);
});

test('desk runs on disk: what boot reads to note wentLive for installs from before HQ kept it', async () => {
  fresh();
  await settle();
  p.state.runs = [];
  p.commit();
  p.flush();
  assert.equal(store.deskRunsOnDisk(), false, 'no runs yet');
  p.state.runs = [{ id: 'run_x', agentId: 'leo', reason: 'manual', status: 'done', startedAt: '2026-10-01T10:00:00.000Z' }];
  p.commit();
  p.flush();
  assert.equal(store.deskRunsOnDisk(), true);
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
await settle().catch(() => undefined);
runner.useRunnerForTests(null);
p.flush();
process.chdir(os.tmpdir());
try {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
} catch (e) {
  console.warn(`could not remove ${root}: ${e instanceof Error ? e.message : String(e)}`);
}
assert.equal(failed, 0, `${failed} idle case(s) failed`);
console.log(`\nall ${passed} idle cases pass`);
process.exit(0);
