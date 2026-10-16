/**
 * Chat core: recipients, the loop limit, messages that need no reply, the back-and-forth check, founder posts,
 * resume, batching, and end-of-run settle.
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
  ECHO_LIMIT,
  closeThread,
  createThread,
  messagesOf,
  needsNoReply,
  needsWake,
  newSince,
  noticeHandoff,
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
    auto: { usage: { day: '2026-10-01', runs: 0, usd: 0 }, failStreak: 0, heldWakes: [] },
    company: { name: 'Test', ownerId: 'you', timezone: 'UTC' },
    agents: [
      desk('you', 'Patrick', { isHuman: true }),
      desk('dylan', 'Dylan', { lead: true, skills: ['plan'] }),
      desk('leo', 'Leo', { skills: ['frontend'] }),
      desk('sam', 'Sam', { skills: ['backend'] }),
      desk('ivy', 'Ivy', { status: 'off' }),
    ],
    items: [],
    epics: [],
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
    // Questions, so the back-and-forth check (statements only) stays out of it.
    const r = postAgentMessage(s, t, from, [to], `q${i}?`, L);
    assert.deepEqual(r.deliver, [to], `message ${i + 1} should deliver`);
  }
  assert.equal(t.agentHops, 6);
  assert.equal(t.status, 'open');
  const seventh = postAgentMessage(s, t, 'leo', ['sam'], 'q7?', L);
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

test('daily cap: Autopilot projects have none; the hop limit still pauses', () => {
  const s = fresh();
  s.chat.wakes = 500;
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  const auto: Limits = { ...L, hopLimit: 2, dailyCap: Infinity };
  assert.deepEqual(postAgentMessage(s, t, 'leo', ['sam'], '1', auto).deliver, ['sam']);
  assert.deepEqual(postAgentMessage(s, t, 'sam', ['leo'], '2', auto).deliver, ['leo']);
  const third = postAgentMessage(s, t, 'leo', ['sam'], '3', auto);
  assert.deepEqual(third.deliver, []);
  assert.equal(t.pausedReason, 'hop-limit');
});

test('no reply needed: what the sender says, or plain thanks, is spotted; a question or a condition is not', () => {
  const quiet = [
    'My next substantive CG-9 update will be QA findings, clearance or a new blocker. No reply needed; leave this thread idle until then.',
    "Good, a comment on GI-2 is the right place for it. You're done on my side. **No reply needed.**",
    'Shipped. No response is needed.',
    'Nothing changed here, no need to respond.',
    "Logged it. Please don't reply.",
    'Thanks!',
    'Thanks, Sam.',
    '@Sam got it, thanks',
    '**Noted.**',
    'OK. Will do.',
  ];
  for (const text of quiet) assert.equal(needsNoReply(text, ['Sam', 'Leo']), true, text);
  assert.equal(needsNoReply('Will do.', ['Will']), true, 'a desk named Will');
  const wakes = [
    'Can you check the build? No reply needed if it passes.',
    'No reply needed if the build is green; otherwise send me the log.',
    'No reply needed — if QA fails, fix it first.',
    'The client wrote "no reply needed", but we should answer them.',
    "Don't reply to the client yet.",
    'Thanks, the endpoint is /orders.',
    'Done. The cart page is in src/cart.tsx.',
    'Build and hand off CG-15 to Amara.',
    'CG-9 remains paused for CG-8 slice QA. No changes.',
    '',
  ];
  for (const text of wakes) assert.equal(needsNoReply(text, ['Sam', 'Leo']), false, text);
});

test('no reply needed: saved and shown, but nobody is woken; the desk reads it next time, and Resume never delivers it', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  const said = postAgentMessage(s, t, 'leo', ['sam'], 'CG-9 stays paused for QA. No reply needed; leave this thread idle until then.', L);
  assert.deepEqual(said.deliver, []);
  assert.equal(said.message.noReply, true);
  assert.equal(said.message.undelivered, undefined);
  assert.equal(t.agentHops, 0);
  assert.equal(s.chat.wakes, 0);
  assert.deepEqual(t.waiting, [], 'nobody shows as typing');
  const flagged = postAgentMessage(s, t, 'leo', ['sam'], 'The cart page is live on staging.', L, { needsReply: false });
  assert.deepEqual(flagged.deliver, [], 'needs_reply: false');
  assert.equal(flagged.message.noReply, true);
  assert.deepEqual(unreadFor(s, t, 'sam').addressed.map((m) => m.n), [1, 2], 'Sam sees both next time Sam runs here');
  assert.equal(postAgentMessage(s, t, 'leo', ['you'], 'Thanks!', L).message.noReply, undefined, 'only desks are woken, so only a desk message is marked');
  // A paused thread holds what would wake a desk, not what needs no reply.
  t.status = 'paused';
  t.pausedReason = 'hop-limit';
  assert.equal(postAgentMessage(s, t, 'sam', ['leo'], 'Noted.', L).message.undelivered, undefined);
  assert.deepEqual(resumeThread(s, t, L), []);
  // A question always wakes.
  assert.deepEqual(postAgentMessage(s, t, 'leo', ['sam'], 'Thanks. Can you add the totals row?', L).deliver, ['sam']);
});

test('no reply needed: a desk that may be waiting on the sender is woken anyway', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  // Leo asked, so Sam's "OK." is the answer Leo waits for.
  postAgentMessage(s, t, 'leo', ['sam'], 'Can I rename the cart table? Blocked until you confirm.', L);
  const ok = postAgentMessage(s, t, 'sam', ['leo'], 'OK.', L);
  assert.deepEqual(ok.deliver, ['leo']);
  assert.equal(ok.message.noReply, undefined);
  // Answered now: thanks and notes after it wake nobody.
  assert.deepEqual(postAgentMessage(s, t, 'leo', ['sam'], 'Thanks!', L).deliver, []);
  assert.deepEqual(postAgentMessage(s, t, 'sam', ['leo'], 'Renamed in the schema too.', L, { needsReply: false }).deliver, []);
  // The owner of the thread's open ticket may be waiting on any teammate: woken even with needs_reply: false.
  const item = ticket(s, 'leo');
  const t2 = createThread(s, { title: 'SA-1', createdBy: 'leo', itemId: item.id });
  assert.deepEqual(postAgentMessage(s, t2, 'sam', ['leo'], 'Migration is in. No reply needed.', L).deliver, ['leo']);
  assert.deepEqual(postAgentMessage(s, t2, 'sam', ['leo'], 'Seed data is in.', L, { needsReply: false }).deliver, ['leo']);
  // The owner's own thanks still wakes nobody, and once the ticket is done, nobody waits.
  assert.deepEqual(postAgentMessage(s, t2, 'leo', ['sam'], 'Thanks!', L).deliver, []);
  item.status = 'done';
  assert.deepEqual(postAgentMessage(s, t2, 'sam', ['leo'], 'Docs are in too. No reply needed.', L).deliver, []);
});

/** Two desks trading statements, like the CG-9 thread: "still paused for QA, no changes", back and forth. */
const ECHOES = [
  'CG-9 remains paused until the slice blockers are resolved. Copy stays Draft.',
  'No new implementation request. CG-9 stays paused and copy stays Draft.',
  'CG-9 remains paused for slice QA. No implementation changes.',
  'No new implementation request. CG-9 stays paused for slice QA; copy remains Draft.',
  'CG-9 is paused for slice QA; copy remains Draft. No changes.',
  'No new task or clearance. CG-9 remains paused for slice QA.',
  'CG-9 stays paused pending slice QA.',
];
/** An Autopilot project with the hop limit at its 100 maximum: neither the hop limit nor a daily cap stops the loop. */
const LOOSE: Limits = { hopLimit: 100, dailyCap: Infinity, today: '2026-10-01' };

test(`back-and-forth: two desks sending each other ${ECHO_LIMIT} messages in a row without a question pause the thread, whatever the hop limit`, () => {
  const s = fresh();
  const t = createThread(s, { title: 'CG-9', createdBy: 'leo' });
  for (let i = 0; i < ECHO_LIMIT - 1; i++) {
    const [from, to] = i % 2 ? ['sam', 'leo'] : ['leo', 'sam'];
    assert.deepEqual(postAgentMessage(s, t, from, [to], ECHOES[i], LOOSE).deliver, [to], `message ${i + 1} wakes ${to}`);
  }
  const last = postAgentMessage(s, t, 'sam', ['leo'], ECHOES[ECHO_LIMIT - 1], LOOSE);
  assert.deepEqual(last.deliver, []);
  assert.deepEqual(last.message.undelivered, ['leo'], 'held for Resume');
  assert.equal(t.status, 'paused');
  assert.equal(t.pausedReason, 'echo');
  assert.equal(t.agentHops, ECHO_LIMIT - 1);
  assert.match(messagesOf(s, t.id).at(-1)!.text, new RegExp(`^Paused: Sam and Leo sent each other ${ECHO_LIMIT} messages in a row without a question\\. Patrick can reply or resume\\.$`));
  // Resume delivers it and starts the count again.
  assert.deepEqual(resumeThread(s, t, LOOSE), ['leo']);
  assert.deepEqual(postAgentMessage(s, t, 'leo', ['sam'], ECHOES[0], LOOSE).deliver, ['sam']);
  assert.equal(t.status, 'open');
});

test('back-and-forth: a question, the founder, a third desk or a group message breaks the run', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  // In turn across calls: Leo, Sam, Leo, ...
  let k = 0;
  const trade = (n: number) => {
    for (let i = 0; i < n; i++, k++) postAgentMessage(s, t, k % 2 ? 'sam' : 'leo', [k % 2 ? 'leo' : 'sam'], ECHOES[k % ECHOES.length], LOOSE);
  };
  const breakers: (() => void)[] = [
    () => postAgentMessage(s, t, 'leo', ['sam'], 'Which file holds the totals?', LOOSE),
    () => postFounderMessage(s, t, '@Leo keep going'),
    () => postAgentMessage(s, t, 'sam', ['dylan'], 'Cart API is merged.', LOOSE),
    () => postAgentMessage(s, t, 'leo', ['sam', 'dylan'], 'Cart page is merged.', LOOSE),
    () => postAgentMessage(s, t, 'sam', ['you'], 'Both halves are in.', LOOSE),
  ];
  trade(ECHO_LIMIT - 1);
  for (const brk of breakers) {
    brk();
    trade(ECHO_LIMIT - 1);
    assert.equal(t.status, 'open', `one short of the limit after ${breakers.indexOf(brk) + 1} break(s): still open`);
  }
  trade(1);
  assert.equal(t.pausedReason, 'echo', 'and the next one in a row pauses it');
});

test('back-and-forth: only messages in turn count; one desk sending updates is not one, and messages that woke nobody are skipped', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  for (let i = 0; i < ECHO_LIMIT + 2; i++) assert.deepEqual(postAgentMessage(s, t, 'leo', ['sam'], `Step ${i + 1} done.`, LOOSE).deliver, ['sam']);
  assert.equal(t.status, 'open', 'one way only');
  const t2 = createThread(s, { title: 'T2', createdBy: 'leo' });
  for (let i = 0; i < ECHO_LIMIT - 1; i++) {
    const [from, to] = i % 2 ? ['sam', 'leo'] : ['leo', 'sam'];
    postAgentMessage(s, t2, from, [to], ECHOES[i], LOOSE);
    assert.equal(postAgentMessage(s, t2, from, [to], 'Logged in memory.md too.', LOOSE, { needsReply: false }).message.noReply, true);
  }
  assert.equal(t2.status, 'open');
  postAgentMessage(s, t2, 'sam', ['leo'], ECHOES[ECHO_LIMIT - 1], LOOSE);
  assert.equal(t2.pausedReason, 'echo', 'the quiet ones in between neither count nor break the run');
});

test("back-and-forth: HQ's notices of a hand-off or a finished ticket always go through, and start the count again", () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  const item = ticket(s, 'sam');
  item.threadId = t.id;
  item.handoffFrom = 'leo';
  for (let i = 0; i < ECHO_LIMIT - 1; i++) postAgentMessage(s, t, i % 2 ? 'sam' : 'leo', [i % 2 ? 'leo' : 'sam'], ECHOES[i], LOOSE);
  // The finished notice carries the desk's summary, which may say "no reply needed": Leo still hears it.
  const told = noticeHandoff(s, item, 'sam', 'Done with SA-1: built the cart API. No reply needed.', undefined, LOOSE);
  assert.deepEqual(told?.deliver, ['leo']);
  assert.equal(t.status, 'open');
  const notice = messagesOf(s, t.id).at(-1)!;
  assert.equal(notice.noReply, undefined);
  assert.equal(notice.notice, true);
  for (let i = 0; i < ECHO_LIMIT - 1; i++) postAgentMessage(s, t, i % 2 ? 'sam' : 'leo', [i % 2 ? 'leo' : 'sam'], ECHOES[i], LOOSE);
  assert.equal(t.status, 'open', 'the notice ended the run before it');
  postAgentMessage(s, t, 'sam', ['leo'], ECHOES[ECHO_LIMIT - 1], LOOSE);
  assert.equal(t.pausedReason, 'echo');
});

test('new since: what landed after a point, from anyone but the desk itself, whether it was to the desk or not', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  postAgentMessage(s, t, 'leo', ['sam'], 'Before the run.', L);
  const seen = t.count;
  postAgentMessage(s, t, 'sam', ['leo'], 'I made the file.', L, { needsReply: false });
  postAgentMessage(s, t, 'leo', ['sam'], 'Mine.', L);
  postAgentMessage(s, t, 'sam', ['dylan'], 'Not to Leo.', L);
  postFounderMessage(s, t, '@Sam one file only');
  assert.deepEqual(newSince(s, t, 'leo', seen).map((m) => m.text), ['I made the file.', 'Not to Leo.', '@Sam one file only']);
  assert.deepEqual(newSince(s, t, 'leo', t.count), []);
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

test('settle: leftover text in a message run becomes the reply to the founder, and wakes nobody', () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  const wake = settleAfterRun(s, { mode: 'message', agentId: 'sam', threadId: t.id, raised: false, finished: false, sentToThread: false, awaiting: [], askedBy: ['leo', 'you'], summary: 'Endpoint is /orders.', ...NO_CHECKS }, noLog, L);
  assert.deepEqual(wake, []);
  const last = messagesOf(s, t.id).at(-1)!;
  assert.equal(last.from, 'sam');
  assert.deepEqual(last.to, ['you'], 'not to Leo: only send_message reaches a teammate');
  assert.equal(t.agentHops, 0);
});

test("settle: a message run's closing words go to the teammate who woke it only when it asked a question", () => {
  const s = fresh();
  const t = createThread(s, { title: 'T', createdBy: 'leo' });
  postAgentMessage(s, t, 'leo', ['sam'], 'Shipped the cart page. You are done on my side.', L);
  const count = t.count;
  // What desks wrote when they chose not to reply. Posted to the teammate, it woke them, and they did the same back.
  const closing = "I didn't reply: Leo asked nothing, and a message would only wake Leo's desk again.";
  const wake = settleAfterRun(s, { mode: 'message', agentId: 'sam', threadId: t.id, raised: false, finished: false, sentToThread: false, awaiting: [], askedBy: ['leo'], summary: closing, ...NO_CHECKS }, noLog, L);
  assert.deepEqual(wake, []);
  assert.equal(t.count, count, 'nothing posted');
  assert.equal(t.agentHops, 1, 'only the first message woke anyone');
  // A question Sam left unanswered still gets them, so Leo is not left waiting.
  postAgentMessage(s, t, 'leo', ['sam'], 'Which endpoint returns the totals?', L);
  const answer = settleAfterRun(s, { mode: 'message', agentId: 'sam', threadId: t.id, raised: false, finished: false, sentToThread: false, awaiting: [], askedBy: ['leo'], summary: 'GET /cart/totals.', ...NO_CHECKS }, noLog, L);
  assert.deepEqual(answer, ['leo']);
  assert.deepEqual(messagesOf(s, t.id).at(-1)!.to, ['leo']);
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
