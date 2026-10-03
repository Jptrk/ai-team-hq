/**
 * Chat core: recipients, the loop limit, founder posts, resume, batching, and end-of-run settle.
 * Run: npm run test:chat. Pure state, no Claude calls, touches nothing on disk.
 */
import assert from 'node:assert/strict';
import type { Agent, Attachment, Run, State, WorkItem } from '../shared/types';
import { mentionsIn } from './agents';
import { addComment } from './comments';
import { rewindCursor } from './cursor';
import { migrateState } from './store';
import {
  ChatError,
  closeThread,
  createThread,
  messagesOf,
  needsWake,
  pauseForFailure,
  postAgentMessage,
  postFounderMessage,
  resolveRecipients,
  resumeThread,
  settleAfterRun,
  unreadFor,
  markRead,
  type Limits,
} from './chat';

const desk = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name,
  role: `${name} role`,
  desk: 'desk',
  status: 'idle',
  color: '#000',
  seat: { col: 0, row: 0 },
  lastActive: '2026-10-01T00:00:00Z',
  skills: [],
  ...extra,
});

function fresh(): State {
  return {
    huddles: [],
    huddleDay: { day: '2026-10-01', started: 0 },
    huddleSeq: 0,
    teamNotes: '',
    notesEveryRun: false,
    skillDesks: {},
    company: { name: 'Test', ownerId: 'you', timezone: 'UTC' },
    agents: [
      desk('you', 'Patrick', { isHuman: true }),
      desk('dylan', 'Dylan', { lead: true, skills: ['plan'] }),
      desk('leo', 'Leo', { skills: ['frontend'] }),
      desk('sam', 'Sam', { skills: ['backend'] }),
      desk('ivy', 'Ivy', { status: 'off' }),
    ],
    items: [],
    instructions: [],
    activity: [],
    runs: [],
    seq: 0,
    connections: [],
    checks: {},
    threads: [],
    messages: [],
    chat: { day: '2026-10-01', wakes: 0 },
  };
}

const L: Limits = { hopLimit: 6, dailyCap: 30, today: '2026-10-01' };
let passed = 0;
const cases: [string, () => void][] = [];
const test = (name: string, fn: () => void) => cases.push([name, fn]);

test('mentions: every desk, in order, no repeats, unknown ignored', () => {
  const s = fresh();
  const hits = mentionsIn('@Leo and @sam, cc @nobody and @leo again', s.agents.filter((a) => !a.isHuman));
  assert.deepEqual(hits.map((a) => a.id), ['leo', 'sam']);
});

test('recipients: self, off shift, unknown, and too many are refused; founder is fine', () => {
  const s = fresh();
  assert.match(resolveRecipients(s, 'leo', ['Leo']).errors.join(), /yourself/);
  assert.match(resolveRecipients(s, 'leo', ['Ivy']).errors.join(), /off shift/);
  assert.match(resolveRecipients(s, 'leo', ['Zed']).errors.join(), /No teammate called "Zed"/);
  const ok = resolveRecipients(s, 'leo', ['@Sam', 'founder']);
  assert.deepEqual(ok.agents.map((a) => a.id), ['sam']);
  assert.equal(ok.founder, true);
  assert.equal(ok.errors.length, 0);
  const s2 = fresh();
  s2.agents.push(desk('omar', 'Omar'), desk('nora', 'Nora'));
  assert.match(resolveRecipients(s2, 'leo', ['Sam', 'Dylan', 'Omar', 'Nora']).errors.join(), /at most 3/);
});

test('loop limit: 6 desk wakes go through, the 7th pauses and is held', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  for (let i = 0; i < 6; i++) {
    const from = i % 2 ? 'sam' : 'leo';
    const to = i % 2 ? 'leo' : 'sam';
    const r = postAgentMessage(s, t, from, [to], `m${i}`, L);
    assert.deepEqual(r.deliver, [to], `message ${i + 1} should deliver`);
  }
  assert.equal(t.agentHops, 6);
  assert.equal(t.status, 'open');
  const seventh = postAgentMessage(s, t, 'leo', ['sam'], 'm7', L);
  assert.deepEqual(seventh.deliver, []);
  assert.deepEqual(seventh.message.undelivered, ['sam']);
  assert.equal(t.status, 'paused');
  assert.equal(t.pausedReason, 'hop-limit');
  assert.ok(messagesOf(s, t.id).some((m) => m.from === 'hq' && /Paused after 6/.test(m.text)), 'a pause note is posted');
});

test('loop limit: a 3-recipient message at 5 hops delivers one and holds two', () => {
  const s = fresh();
  s.agents.push(desk('omar', 'Omar'));
  const t = createThread(s, { title: 'T', createdBy: 'dylan' });
  t.agentHops = 5;
  const r = postAgentMessage(s, t, 'dylan', ['leo', 'sam', 'omar'], 'all hands', L);
  assert.deepEqual(r.deliver, ['leo']);
  assert.deepEqual(r.message.undelivered, ['sam', 'omar']);
  assert.equal(t.status, 'paused');
});

test('messages to the founder never count as hops', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  const r = postAgentMessage(s, t, 'leo', ['you'], 'done, see report', L);
  assert.deepEqual(r.deliver, []);
  assert.equal(t.agentHops, 0);
  assert.equal(s.chat.wakes, 0);
});

test('founder post: resets hops, reopens, wakes mentions; no mention wakes the last desk that spoke', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  postAgentMessage(s, t, 'leo', ['sam'], 'q', L);
  t.agentHops = 6;
  t.status = 'paused';
  t.pausedReason = 'hop-limit';
  const a = postFounderMessage(s, t, '@Dylan please decide');
  assert.deepEqual(a.deliver, ['dylan']);
  assert.equal(t.status, 'open');
  assert.equal(t.agentHops, 0);
  assert.equal(s.chat.wakes, 1, 'founder wakes do not count toward the daily cap');
  const b = postFounderMessage(s, t, 'and what about the date?');
  assert.deepEqual(b.deliver, ['leo'], 'last desk that spoke');
  const t2 = createThread(s, { title: 'fresh', createdBy: 'you' });
  const c = postFounderMessage(s, t2, 'the backend is slow');
  assert.deepEqual(c.deliver, ['sam'], 'no desk yet: the router picks by keyword');
});

test('resume: delivers held recipients once, clears them, counts them toward the fresh limit', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  t.agentHops = 6;
  postAgentMessage(s, t, 'leo', ['sam'], 'held 1', L);
  postAgentMessage(s, t, 'dylan', ['sam', 'leo'], 'held 2', L);
  const woke = resumeThread(s, t, L);
  assert.deepEqual(woke.sort(), ['leo', 'sam']);
  assert.equal(t.status, 'open');
  assert.equal(t.agentHops, 2);
  assert.ok(messagesOf(s, t.id).every((m) => !m.undelivered), 'held lists cleared');
  assert.deepEqual(resumeThread(s, t, L), [], 'nothing left to deliver');
});

test('closed thread: desks cannot post; the founder posting reopens it', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  closeThread(s, t);
  assert.throws(() => postAgentMessage(s, t, 'leo', ['sam'], 'x', L), ChatError);
  assert.throws(() => resumeThread(s, t, L), ChatError);
  postFounderMessage(s, t, '@Leo one more thing');
  assert.equal(t.status, 'open');
});

test('daily cap: pauses with daily-cap, and rolls over the next day', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  const tight: Limits = { ...L, dailyCap: 2 };
  postAgentMessage(s, t, 'leo', ['sam'], '1', tight);
  postAgentMessage(s, t, 'sam', ['leo'], '2', tight);
  const third = postAgentMessage(s, t, 'leo', ['sam'], '3', tight);
  assert.deepEqual(third.deliver, []);
  assert.equal(t.pausedReason, 'daily-cap');
  const t2 = createThread(s, { title: 'next day', createdBy: 'leo' });
  const tomorrow = postAgentMessage(s, t2, 'leo', ['sam'], 'new day', { ...tight, today: '2026-10-02' });
  assert.deepEqual(tomorrow.deliver, ['sam']);
});

test('batching: a queued run for the desk and thread means no second wake; a running one does not block', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  const run = (status: Run['status']): Run => ({ id: `r_${status}`, agentId: 'sam', threadId: t.id, reason: 'message', status, startedAt: '' });
  assert.equal(needsWake(s, t, 'sam'), true);
  s.runs.push(run('running'));
  assert.equal(needsWake(s, t, 'sam'), true);
  s.runs.push(run('queued'));
  assert.equal(needsWake(s, t, 'sam'), false);
});

test('unread: counts messages after the cursor, flags the ones addressed to the desk', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  postAgentMessage(s, t, 'leo', ['sam'], 'for sam', L);
  postAgentMessage(s, t, 'leo', ['dylan'], 'for dylan', L);
  const u = unreadFor(s, t, 'sam');
  assert.equal(u.all.length, 2);
  assert.equal(u.addressed.length, 1);
  markRead(t, 'sam');
  assert.equal(unreadFor(s, t, 'sam').all.length, 0);
  assert.equal(unreadFor(s, t, 'leo').all.length, 0, 'own messages are never unread');
});

const ticket = (s: State, owner: string): WorkItem => {
  const item: WorkItem = { id: 'wi_1', number: 1, kind: 'fyi', status: 'in-progress', title: 'Fix checkout', summary: '', from: 'you', assignee: owner, dated: '', links: [], history: [] };
  s.items.push(item);
  return item;
};
const noLog = () => undefined;
/** A project without QA or sign-off: a finished ticket is done. */
const NO_CHECKS = { qa: false, signoff: false };

test("settle: a message run never touches the owner's ticket", () => {
  const s = fresh();
  const item = ticket(s, 'leo');
  const t = createThread(s, { title: 'T', createdBy: 'leo', itemId: item.id });
  settleAfterRun(s, { mode: 'message', agentId: 'sam', itemId: item.id, threadId: t.id, raised: false, finished: false, sentToThread: true, awaiting: [], askedBy: ['leo'], summary: 'all done', ...NO_CHECKS }, noLog, L);
  assert.equal(item.status, 'in-progress');
});

test('settle: leftover text in a message run becomes the reply and wakes the asker', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  const wake = settleAfterRun(s, { mode: 'message', agentId: 'sam', threadId: t.id, raised: false, finished: false, sentToThread: false, awaiting: [], askedBy: ['leo', 'you'], summary: 'Endpoint is /orders.', ...NO_CHECKS }, noLog, L);
  assert.deepEqual(wake, ['leo']);
  const last = messagesOf(s, t.id).at(-1)!;
  assert.equal(last.from, 'sam');
  assert.deepEqual(last.to, ['leo', 'you']);
});

test('settle: a ticket run that asked a teammate stays in progress; otherwise it finishes', () => {
  const s = fresh();
  const item = ticket(s, 'leo');
  settleAfterRun(s, { mode: 'ticket', agentId: 'leo', itemId: item.id, raised: false, finished: false, sentToThread: false, awaiting: ['sam'], askedBy: [], summary: 'asked Sam', ...NO_CHECKS }, noLog, L);
  assert.equal(item.status, 'in-progress');
  assert.match(item.history.at(-1)!.text, /Waiting on Sam/);
  settleAfterRun(s, { mode: 'ticket', agentId: 'leo', itemId: item.id, raised: false, finished: false, sentToThread: false, awaiting: [], askedBy: [], summary: 'fixed it', ...NO_CHECKS }, noLog, L);
  assert.equal(item.status, 'done');
});

test("settle: a ticket run by someone other than the owner cannot finish the ticket", () => {
  const s = fresh();
  const item = ticket(s, 'leo');
  settleAfterRun(s, { mode: 'ticket', agentId: 'sam', itemId: item.id, raised: false, finished: false, sentToThread: false, awaiting: [], askedBy: [], summary: 'x', ...NO_CHECKS }, noLog, L);
  assert.equal(item.status, 'in-progress');
});

const image = (id: string): Attachment => ({ id, file: `${id}.png`, type: 'image/png', size: 10, by: 'you', ts: '2026-10-01T00:00:00Z' });

test('images: a founder message can be only an image, and the preview says so', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'you' });
  const r = postFounderMessage(s, t, '@Leo', []);
  assert.deepEqual(r.deliver, ['leo']);
  postFounderMessage(s, t, '', [image('att_000000000001')]);
  const last = messagesOf(s, t.id).at(-1)!;
  assert.equal(last.attachments?.length, 1);
  assert.equal(t.last?.text, 'Sent an image');
  postFounderMessage(s, t, '', [image('att_000000000002'), image('att_000000000003')]);
  assert.equal(t.last?.text, 'Sent 2 images');
  postFounderMessage(s, t, 'plain text', []);
  assert.equal(messagesOf(s, t.id).at(-1)!.attachments, undefined, 'no empty attachments list is stored');
});

test('settle: answering your comment leaves the ticket alone and posts the reply as a comment', () => {
  const s = fresh();
  const item = ticket(s, 'leo');
  addComment(item, { from: 'you', text: 'Why blue?' });
  settleAfterRun(s, { mode: 'ticket', agentId: 'leo', itemId: item.id, raised: false, finished: false, sentToThread: false, awaiting: [], askedBy: [], summary: 'Brand color.', reason: 'comment', ...NO_CHECKS }, noLog, L);
  assert.equal(item.status, 'in-progress', 'a reply never closes the ticket');
  assert.equal(item.comments?.at(-1)?.from, 'leo');
  assert.equal(item.comments?.at(-1)?.text, 'Brand color.');
  // When the desk already commented with the tool, the summary is not posted again.
  settleAfterRun(s, { mode: 'ticket', agentId: 'leo', itemId: item.id, raised: false, finished: false, sentToThread: false, awaiting: [], askedBy: [], summary: 'again', reason: 'comment', commented: true, ...NO_CHECKS }, noLog, L);
  assert.equal(item.comments?.length, 2);
});

test('resume: a reply cut off by a restart is asked again after Resume', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'you' });
  postFounderMessage(s, t, '@Sam first question', []);
  t.cursor.sam = t.count; // Sam answered it earlier
  postAgentMessage(s, t, 'sam', ['you'], 'answer one', L);
  postFounderMessage(s, t, '@Sam are you going to send a picture?', []);
  const asked = t.count;
  // The run starts: it remembers the marker, then marks the thread read.
  const run: Run = { id: 'r_cut', agentId: 'sam', threadId: t.id, reason: 'message', status: 'running', startedAt: '2099-01-01T00:00:00Z', cursorFrom: t.cursor.sam };
  t.cursor.sam = t.count;
  s.runs.push(run);
  migrateState(s);
  assert.equal(run.status, 'failed');
  assert.equal(t.status, 'paused');
  assert.equal(t.pausedReason, 'restart');
  assert.ok((t.cursor.sam ?? 0) < asked, 'the read marker was put back');
  assert.deepEqual(resumeThread(s, t, L), ['sam']);
  const unread = unreadFor(s, t, 'sam');
  assert.ok(unread.addressed.some((m) => m.text.includes('send a picture')), 'Resume shows Sam the question again');
});

test('resume: a desk that already replied is not rewound', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'you' });
  postFounderMessage(s, t, '@Sam ping', []);
  const before = t.cursor.sam ?? 0;
  const startedAt = new Date(Date.now() - 1000).toISOString();
  t.cursor.sam = t.count;
  postAgentMessage(s, t, 'sam', ['you'], 'pong', L);
  assert.equal(rewindCursor(t, s.messages, 'sam', before, startedAt), false);
  assert.equal(t.cursor.sam, t.count);
  // Without a remembered marker there is nothing to put back.
  assert.equal(rewindCursor(t, s.messages, 'leo', undefined, startedAt), false);
});

test('failed reply: the thread pauses and Resume asks the desk again', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'you' });
  postFounderMessage(s, t, '@Sam what is the endpoint?', []);
  const asked = t.count;
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const before = t.cursor.sam ?? 0;
  markRead(t, 'sam');
  // What execute() does when a message run fails before replying.
  assert.equal(rewindCursor(t, s.messages, 'sam', before, startedAt), true);
  pauseForFailure(s, t, 'sam', "Sam's run failed: boom");
  assert.equal(t.status, 'paused');
  assert.equal(t.pausedReason, 'failed');
  assert.deepEqual(messagesOf(s, t.id).at(-1)!.undelivered, ['sam']);
  assert.deepEqual(resumeThread(s, t, L), ['sam']);
  assert.ok(unreadFor(s, t, 'sam').addressed.some((m) => m.n === asked), 'Resume shows Sam the question again');
});

test('failed reply: a thread already paused keeps its reason, and still holds the desk for Resume', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  t.status = 'paused';
  t.pausedReason = 'hop-limit';
  pauseForFailure(s, t, 'sam', "Sam's run failed: boom");
  assert.equal(t.pausedReason, 'hop-limit');
  assert.deepEqual(messagesOf(s, t.id).at(-1)!.undelivered, ['sam']);
});

test('restart: a ticket run puts its read marker back in the ticket thread, without pausing it', () => {
  const s = fresh();
  const item = ticket(s, 'leo');
  const t = createThread(s, { title: 'T', createdBy: 'you', itemId: item.id });
  item.threadId = t.id;
  postFounderMessage(s, t, '@Leo a note for the ticket', []);
  // kickoff() remembers the marker and the thread, then marks it read.
  const run: Run = { id: 'r_ticket', agentId: 'leo', itemId: item.id, reason: 'instruction', status: 'running', startedAt: '2099-01-01T00:00:00Z', cursorFrom: t.cursor.leo ?? 0, cursorThread: t.id };
  markRead(t, 'leo');
  s.runs.push(run);
  const count = messagesOf(s, t.id).length;
  migrateState(s);
  assert.equal(run.status, 'failed');
  assert.equal(t.cursor.leo, 0, 'the read marker was put back');
  assert.equal(t.status, 'open', 'a ticket run never pauses the thread');
  assert.equal(messagesOf(s, t.id).length, count, 'and posts no note in it');
  assert.match(item.history.at(-1)!.text, /interrupted by a server restart/);
});

test('comments: kinds and titles are kept, plain comments stay plain', () => {
  const s = fresh();
  const item = ticket(s, 'leo');
  addComment(item, { from: 'leo', text: 'Need a call', kind: 'decision', title: 'Approve the index?' });
  addComment(item, { from: 'you', text: 'ok', kind: 'comment' });
  assert.equal(item.comments?.[0].kind, 'decision');
  assert.equal(item.comments?.[0].title, 'Approve the index?');
  assert.equal(item.comments?.[1].kind, undefined);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e instanceof Error ? e.message : String(e)}`);
  }
}
assert.equal(failed, 0, `${failed} chat case(s) failed`);
console.log(`\nall ${passed} chat cases pass`);
