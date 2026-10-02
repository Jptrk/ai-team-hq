/**
 * The Office's six states (shared/activity.ts), desk numbers (shared/desks.ts) and Coding vs Working
 * from the runner's last tool (server/runner/liveTools.ts). Pure functions, no server, no network.
 * Run: npm run test:activity.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { deriveActivities, stampNeedsYou, startsFrom, waitingSince, withSince, type ActivityInput } from '../shared/activity';
import { assignDeskNumbers, deskSlotsFor, withDeskNumbers } from '../shared/desks';
import type { Agent, Run, State, Thread, WorkItem } from '../shared/types';
import { lastTools, noteTools, setLastTool, toolKind } from './runner/liveTools';
import { seed } from './seed';
import { migrateState } from './store';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}`);
    throw e;
  }
}

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  role: 'Desk',
  desk: 'Desk',
  status: 'idle',
  color: '#3b6ea5',
  seat: { col: 0, row: 0 },
  lastActive: '2026-10-02T00:00:00.000Z',
  skills: [],
  ...extra,
});
const founder = agent('you', { isHuman: true, name: 'Patrick' });
const item = (n: number, assignee: string, status: WorkItem['status'], ts = '2026-10-02T08:00:00.000Z'): WorkItem =>
  ({ id: `w${n}`, number: n, kind: 'decide', status, title: `T${n}`, summary: '', client: '', from: assignee, assignee, dated: '', links: [], history: [{ ts, text: 'x' }] }) as WorkItem;
const run = (id: string, agentId: string, extra: Partial<Run> = {}): Run => ({ id, agentId, reason: 'instruction', status: 'running', startedAt: '2026-10-02T09:00:00.000Z', ...extra });
const thread = (id: string, participants: string[], extra: Partial<Thread> = {}): Thread => ({
  id,
  title: '',
  createdBy: participants[0],
  participants,
  status: 'open',
  agentHops: 0,
  count: 1,
  cursor: {},
  waiting: [],
  youSeen: 0,
  createdAt: '',
  updatedAt: '',
  ...extra,
});
const input = (over: Partial<ActivityInput>): ActivityInput => ({ agents: [], items: [], runs: [], threads: [], huddles: [], lastTool: {}, ...over });

test('off beats everything; idle is the default', () => {
  const a = deriveActivities(input({ agents: [founder, agent('rod', { status: 'off' }), agent('ivy')], runs: [run('r1', 'rod')] }));
  assert.equal(a.rod.activity, 'off');
  assert.equal(a.ivy.activity, 'idle');
  assert.equal(a.you, undefined, 'the founder is not a desk');
});

test('mid-run: coding when the last tool wrote in the project folder, else working', () => {
  const agents = [agent('den'), agent('pai')];
  const a = deriveActivities(input({ agents, runs: [run('r1', 'den'), run('r2', 'pai')], lastTool: { r1: 'code', r2: 'other' } }));
  assert.equal(a.den.activity, 'coding');
  assert.equal(a.pai.activity, 'working');
  const none = deriveActivities(input({ agents, runs: [run('r1', 'den', { status: 'done' })] }));
  assert.equal(none.den.activity, 'idle');
});

test('no run: waiting on you beats work in progress; in-progress, sent-back, approved and todo are working', () => {
  const agents = [agent('mik'), agent('ril'), agent('dyl')];
  const a = deriveActivities(input({ agents, items: [item(1, 'mik', 'needs-you'), item(2, 'mik', 'in-progress'), item(3, 'ril', 'todo'), item(4, 'dyl', 'done')] }));
  assert.equal(a.mik.activity, 'waiting');
  assert.equal(a.ril.activity, 'working');
  assert.equal(a.dyl.activity, 'idle');
  // Mid-run on something else: the desk is at work, not on the bench.
  const busy = deriveActivities(input({ agents, items: [item(1, 'mik', 'needs-you')], runs: [run('r', 'mik')] }));
  assert.equal(busy.mik.activity, 'working');
});

test('desk-to-desk chat: both halves pair up while the reply is being written', () => {
  const agents = [agent('dyl'), agent('mar'), agent('pai')];
  const t = thread('t1', ['dyl', 'mar'], { waiting: ['mar'], last: { from: 'dyl', to: ['mar'], text: 'hi', ts: '' } });
  const a = deriveActivities(input({ agents, threads: [t], runs: [run('r', 'mar', { reason: 'message', threadId: 't1' })] }));
  assert.deepEqual(a.mar, { activity: 'chatting', with: ['dyl'] });
  assert.deepEqual(a.dyl, { activity: 'chatting', with: ['mar'] });
  assert.equal(a.pai.activity, 'idle');
  // Woken, but still busy with a ticket: not talking yet, and Dylan isn't pulled into a pair.
  const queued = deriveActivities(input({ agents, threads: [t], runs: [run('r', 'mar')] }));
  assert.equal(queued.mar.activity, 'working');
  assert.equal(queued.dyl.activity, 'idle');
  // The partner is busy with its own run: the replier chats alone from its desk.
  const busy = deriveActivities(input({ agents, threads: [t], runs: [run('r', 'mar', { reason: 'message', threadId: 't1' }), run('r2', 'dyl')] }));
  assert.deepEqual(busy.mar, { activity: 'chatting', with: ['dyl'] });
  assert.equal(busy.dyl.activity, 'working');
});

test('answering you: chatting with nobody, so it stays at its desk', () => {
  const agents = [agent('mar')];
  const t = thread('t1', ['mar', 'you'], { waiting: ['mar'], last: { from: 'you', to: ['mar'], text: '?', ts: '' } });
  const a = deriveActivities(input({ agents, threads: [t], runs: [run('r', 'mar', { reason: 'message', threadId: 't1' })] }));
  assert.deepEqual(a.mar, { activity: 'chatting', with: [] });
});

test('a pair stays a pair after the replier posts mid-run, or an HQ note lands; "with you" only when nobody else is in it', () => {
  const agents = [agent('dyl'), agent('mar')];
  const replying = run('r', 'mar', { reason: 'message', threadId: 't1' });
  // Maria posted her reply with the message tool; her run hasn't ended, so she is still waiting.
  const posted = thread('t1', ['dyl', 'mar'], { waiting: ['mar'], last: { from: 'mar', to: ['dyl'], text: 'done', ts: '' } });
  const a = deriveActivities(input({ agents, threads: [posted], runs: [replying] }));
  assert.deepEqual(a.mar, { activity: 'chatting', with: ['dyl'] });
  assert.deepEqual(a.dyl, { activity: 'chatting', with: ['mar'] });
  // Then Dylan is woken to answer her: the same pair, so nobody moves.
  const back = thread('t1', ['dyl', 'mar'], { waiting: ['dyl'], last: { from: 'mar', to: ['dyl'], text: 'done', ts: '' } });
  const b = deriveActivities(input({ agents, threads: [back], runs: [run('r2', 'dyl', { reason: 'message', threadId: 't1' })] }));
  assert.deepEqual(b.dyl, { activity: 'chatting', with: ['mar'] });
  assert.deepEqual(b.mar, { activity: 'chatting', with: ['dyl'] });
  // An HQ note last (after Resume): still the thread's other desk.
  const noted = thread('t1', ['dyl', 'mar'], { waiting: ['mar'], last: { from: 'hq', to: [], text: 'resumed', ts: '' } });
  assert.deepEqual(deriveActivities(input({ agents, threads: [noted], runs: [replying] })).mar, { activity: 'chatting', with: ['dyl'] });
  // You posted last in a thread with another desk in it: she's still talking with that desk.
  const yours = thread('t1', ['dyl', 'mar', 'you'], { waiting: ['mar'], last: { from: 'you', to: ['mar'], text: '?', ts: '' } });
  assert.deepEqual(deriveActivities(input({ agents, threads: [yours], runs: [replying] })).mar, { activity: 'chatting', with: ['dyl'] });
  // Only you and her: answering you, from her desk.
  const solo = thread('t1', ['mar', 'you'], { waiting: ['mar'], last: { from: 'mar', to: ['you'], text: 'ok', ts: '' } });
  assert.deepEqual(deriveActivities(input({ agents, threads: [solo], runs: [replying] })).mar, { activity: 'chatting', with: [] });
});

test('a running huddle: everyone in it is chatting, not only the desk whose turn it is', () => {
  const agents = [agent('dyl'), agent('mar'), agent('pai'), agent('rod', { status: 'off' })];
  const huddles = [{ id: 'h1', status: 'running', facilitator: 'dyl', participants: ['mar', 'pai', 'rod'] }];
  const a = deriveActivities(input({ agents, huddles, runs: [run('r', 'mar', { reason: 'huddle', huddleId: 'h1' })] }));
  for (const id of ['dyl', 'mar', 'pai']) assert.equal(a[id].activity, 'chatting', id);
  assert.equal(a.mar.huddleId, 'h1');
  assert.deepEqual(a.dyl.with?.sort(), ['mar', 'pai']);
  assert.equal(a.rod.activity, 'off');
  const done = deriveActivities(input({ agents, huddles: [{ ...huddles[0], status: 'done' }] }));
  assert.equal(done.mar.activity, 'idle');
});

test('since stays put while the activity does, and waiting counts from the ticket', () => {
  const t0 = '2026-10-02T09:00:00.000Z';
  const t1 = '2026-10-02T09:05:00.000Z';
  const items = [item(1, 'mik', 'needs-you', '2026-10-02T07:00:00.000Z')];
  const first = withSince({ den: { activity: 'coding' }, mik: { activity: 'waiting' } }, undefined, t0, items);
  assert.equal(first.den.since, t0);
  assert.equal(first.mik.since, '2026-10-02T07:00:00.000Z');
  const same = withSince({ den: { activity: 'coding' }, mik: { activity: 'waiting' } }, first, t1, items);
  assert.equal(same.den.since, t0);
  const moved = withSince({ den: { activity: 'working' }, mik: { activity: 'waiting' } }, first, t1, items);
  assert.equal(moved.den.since, t1);
  assert.equal(waitingSince(items, 'nobody'), undefined);
});

test('the waiting clock counts from when the ticket went into Needs you, not its newest history', () => {
  const asked = '2026-10-02T07:00:00.000Z';
  const later = '2026-10-02T09:30:00.000Z';
  const wi = item(1, 'mik', 'needs-you', asked);
  stampNeedsYou([wi], asked);
  // A comment run queued, an image attached, a failed run: history grows while it waits.
  wi.history.push({ ts: later, text: 'Queued for Mike (comment)' }, { ts: later, text: 'You attached 1 image' }, { ts: later, text: 'Run failed: timeout' });
  stampNeedsYou([wi], later);
  assert.equal(wi.needsYouAt, asked, 'a later commit leaves it alone');
  assert.equal(waitingSince([wi], 'mik'), asked);
  // It leaves Needs you and comes back: a new wait.
  wi.status = 'approved';
  stampNeedsYou([wi], later);
  assert.equal(wi.needsYouAt, undefined);
  wi.status = 'needs-you';
  stampNeedsYou([wi], later);
  assert.equal(waitingSince([wi], 'mik'), later);
  // Saved before needsYouAt existed: the newest history entry, as before.
  const old = item(2, 'ril', 'needs-you', asked);
  assert.equal(waitingSince([old], 'ril'), asked);
});

test('a restart keeps the waiting clock: needsYouAt is filled in before the restart note is added', () => {
  const asked = '2026-10-02T07:00:00.000Z';
  const s = seed('blank', { empty: true, ownerName: 'Patrick', projectName: 'X' });
  s.agents.push(agent('mik'));
  s.items.push(item(1, 'mik', 'needs-you', asked));
  s.runs.push(run('r1', 'mik', { reason: 'comment', itemId: 'w1', startedAt: '2026-10-02T09:00:00.000Z' }));
  const after = migrateState(JSON.parse(JSON.stringify(s)) as State);
  const wi = after.items.find((i) => i.id === 'w1')!;
  assert.ok(wi.history.at(-1)!.text.includes('server restart'), 'the restart note is the newest entry');
  assert.equal(wi.needsYouAt, asked);
  assert.equal(waitingSince(after.items, 'mik'), asked);
});

test('since after a restart comes from the data: the run, the huddle, or when the desk was last active', () => {
  const now = '2026-10-02T12:00:00.000Z';
  const agents = [agent('den', { lastActive: '2026-10-02T11:00:00.000Z' }), agent('pai', { lastActive: '2026-10-02T10:00:00.000Z' }), agent('dyl'), agent('mar'), agent('rod', { status: 'off' })];
  const runs = [run('r1', 'den', { startedAt: '2026-10-02T11:50:00.000Z' }), run('r2', 'mar', { reason: 'message', threadId: 't1', startedAt: '2026-10-02T11:40:00.000Z' })];
  const huddles = [{ id: 'h1', status: 'running', facilitator: 'dyl', participants: [], createdAt: '2026-10-02T11:30:00.000Z' }];
  const derived = { den: { activity: 'coding' as const }, pai: { activity: 'idle' as const }, mar: { activity: 'chatting' as const, with: ['x'] }, x: { activity: 'chatting' as const, with: ['mar'] }, dyl: { activity: 'chatting' as const, with: [], huddleId: 'h1' }, rod: { activity: 'off' as const } };
  const first = withSince(derived, undefined, now, [], startsFrom({ agents: [...agents, agent('x')], runs, huddles }));
  assert.equal(first.den.since, '2026-10-02T11:50:00.000Z', 'its run');
  assert.equal(first.pai.since, '2026-10-02T10:00:00.000Z', 'idle: last active');
  assert.equal(first.x.since, '2026-10-02T11:40:00.000Z', 'the half of a pair without a run: its partner\'s run');
  assert.equal(first.dyl.since, '2026-10-02T11:30:00.000Z', 'the huddle');
  assert.equal(first.rod.since, now, 'off shift has no start of its own');
  // Once HQ has seen a desk, a change starts the clock at that poll; a time in the future never counts.
  const later = withSince({ ...derived, den: { activity: 'working' } }, first, '2026-10-02T12:01:00.000Z', [], startsFrom({ agents, runs, huddles }));
  assert.equal(later.den.since, '2026-10-02T12:01:00.000Z');
  const ahead = withSince({ pai: { activity: 'idle' } }, undefined, now, [], () => '2026-10-02T13:00:00.000Z');
  assert.equal(ahead.pai.since, now);
});

test('desk numbers: kept when someone leaves; newcomers take the lowest free one; the founder has none', () => {
  const team = [founder, agent('a'), agent('b'), agent('c')];
  assert.equal(assignDeskNumbers(team), true);
  assert.deepEqual(team.map((a) => a.deskNo), [undefined, 1, 2, 3]);
  assert.equal(assignDeskNumbers(team), false, 'nothing changes the second time');
  const left = team.filter((a) => a.id !== 'b');
  assignDeskNumbers(left);
  assert.deepEqual(left.map((a) => a.deskNo), [undefined, 1, 3]);
  assert.equal(deskSlotsFor(left), 3);
  left.push(agent('d'));
  assignDeskNumbers(left);
  assert.equal(left.at(-1)!.deskNo, 2);
  // Duplicates and junk get fixed.
  const bad = [agent('x', { deskNo: 2 }), agent('y', { deskNo: 2 }), agent('z', { deskNo: -1 }), { ...founder, deskNo: 4 }];
  assignDeskNumbers(bad);
  assert.deepEqual(bad.map((a) => a.deskNo), [2, 1, 3, undefined]);
  assert.equal(deskSlotsFor([founder]), 1);
});

test('seed() numbers every desk, so a reset or a fresh project has the right office', () => {
  for (const template of ['business', 'dev', 'blank'] as const) {
    for (const empty of [true, false]) {
      const s = seed(template, { empty, ownerName: 'Patrick', projectName: 'X' });
      const desks = s.agents.filter((a) => !a.isHuman);
      assert.deepEqual(desks.map((a) => a.deskNo), desks.map((_, i) => i + 1), template);
      assert.equal(s.agents.find((a) => a.isHuman)?.deskNo, undefined);
      assert.equal(deskSlotsFor(s.agents), Math.max(1, desks.length), template);
    }
  }
  // The demo's waiting clocks start when each ticket was flagged, not at the first save.
  const demo = seed('business', { empty: false, ownerName: 'Patrick', projectName: 'X' });
  for (const i of demo.items.filter((x) => x.status === 'needs-you')) assert.equal(i.needsYouAt, i.history.at(-1)!.ts, i.id);
});

test('the Office numbers desks the server hasn\'t, lowest free first in roster order, without touching the data', () => {
  const team = [founder, agent('a', { deskNo: 2 }), agent('b'), agent('c'), agent('d', { deskNo: 30 })];
  const seen = withDeskNumbers(team, 24);
  assert.deepEqual(seen.map((a) => a.deskNo), [undefined, 2, 1, 3, 4]);
  assert.deepEqual(team.map((a) => a.deskNo), [undefined, 2, undefined, undefined, 30], 'the agents passed in are unchanged');
  assert.equal(deskSlotsFor(seen), 4);
});

test('coding is a Write or Edit inside the project folder, never the desk\'s own reports', () => {
  const proj = path.resolve('/work/app');
  // The SDK runs in the desk's workspace, so that's what a relative path is relative to.
  const ws = path.resolve('/work/hq/workspaces/p/x');
  assert.equal(toolKind('Write', { file_path: path.join(proj, 'src/a.ts') }, proj, ws), 'code');
  assert.equal(toolKind('Edit', { file_path: path.join('notes', 'draft.md') }, proj, ws), 'other', 'relative: a note in the workspace');
  assert.equal(toolKind('Edit', { file_path: path.relative(ws, path.join(proj, 'src', 'b.ts')) }, proj, ws), 'code', 'relative, climbing into the project');
  assert.equal(toolKind('NotebookEdit', { notebook_path: path.join(proj, 'n.ipynb') }, proj, ws), 'code');
  assert.equal(toolKind('Write', { file_path: path.join(ws, 'reports', 'r.md') }, proj, ws), 'other');
  assert.equal(toolKind('Write', { file_path: path.join(proj, '..', 'other', 'x.ts') }, proj, ws), 'other');
  assert.equal(toolKind('Write', { file_path: `${proj}2${path.sep}x.ts` }, proj, ws), 'other', 'a sibling with the same prefix');
  assert.equal(toolKind('Write', { file_path: path.join(proj, '..env.local') }, proj, ws), 'code', 'a root file whose name starts with two dots');
  assert.equal(toolKind('Write', { file_path: proj }, proj, ws), 'other', 'the folder itself is not a file in it');
  assert.equal(toolKind('Read', { file_path: path.join(proj, 'a.ts') }, proj, ws), 'other');
  assert.equal(toolKind('Write', { file_path: path.join(proj, 'a.ts') }, null, ws), 'other', 'no linked folder, or the run may not write it: nothing is code');
  assert.equal(toolKind('mcp__figma__use_figma', {}, proj, ws), 'other');
  // A linked folder around HQ: the workspace inside it still isn't the project.
  const around = path.resolve('/work');
  assert.equal(toolKind('Write', { file_path: path.join(ws, 'reports', 'r.md') }, around, ws), 'other');
  if (path.sep === '\\') {
    // Windows long paths: "\\?\C:\work\app\x.ts" is "C:\work\app\x.ts".
    assert.equal(toolKind('Write', { file_path: `\\\\?\\${path.join(proj, 'x.ts')}` }, proj, ws), 'code');
    assert.equal(toolKind('Write', { file_path: path.join(proj, 'x.ts').toLowerCase().replace(/\\/g, '/') }, proj, ws), 'code', 'case and slashes');
  }
});

test('noteTools records the last tool of an assistant message, with the run\'s cwd', () => {
  const proj = path.resolve('/work/app');
  const ws = path.resolve('/work/hq/workspaces/p/x');
  const msg = (file: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: file } }] } });
  noteTools('nt1', msg(path.join(proj, 'a.ts')), proj, ws);
  noteTools('nt2', msg('draft.md'), proj, ws);
  // A read-only project (or a QA check or huddle) passes no project folder, so the write it is about to be refused never counts.
  noteTools('nt3', msg(path.join(proj, 'a.ts')), null, ws);
  assert.deepEqual(lastTools(new Set(['nt1', 'nt2', 'nt3'])), { nt1: 'code', nt2: 'other', nt3: 'other' });
});

test('last tools: only running runs are reported; another project\'s live runs are never dropped', () => {
  const t0 = Date.now();
  setLastTool('live', 'code', t0);
  setLastTool('elsewhere', 'other', t0);
  setLastTool('gone', 'other', t0 - 31 * 60_000);
  assert.deepEqual(lastTools(new Set(['live']), t0), { live: 'code' });
  // A poll for one project must not forget a run in another.
  assert.deepEqual(lastTools(new Set(['elsewhere']), t0), { elsewhere: 'other' });
  assert.deepEqual(lastTools(new Set(['gone']), t0), {}, 'an entry untouched for 30 minutes is gone');
});

console.log(`\nactivity: ${passed} tests passed`);
