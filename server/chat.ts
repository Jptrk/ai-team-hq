import type { Agent, Attachment, Message, State, Thread, WorkItem } from '../shared/types';
import { mentionsIn, routeInstruction } from './agents';
import { addComment } from './comments';
import { limit } from './limits';
import { finishWork } from './qa';
import { now, today, uid } from './store';

/**
 * Chat between desks, and Patrick. Pure state logic: no runner, no Claude calls.
 * Callers save the project and wake the desks this returns.
 *
 * The loop guard: every desk woken by another desk counts one hop. After hopLimit() hops
 * the thread pauses and holds further messages until Patrick posts or resumes.
 */

/** Desk-to-desk messages a thread takes before it pauses (Accounts page, or HQ_CHAT_HOP_LIMIT). */
export const hopLimit = (): number => limit('chatHops');
export const MAX_SENDS_PER_RUN = 3;
export const MAX_RECIPIENTS = 3;
const MAX_MESSAGES = 1500;

export interface Limits {
  hopLimit: number;
  dailyCap: number;
  today: string;
}

export const defaultLimits = (): Limits => ({ hopLimit: hopLimit(), dailyCap: limit('chatDailyWakes'), today: today() });

/** A problem to show the caller as-is (a desk's tool result, or an API error). */
export class ChatError extends Error {}

export function findThread(s: State, id: string): Thread | undefined {
  return s.threads.find((t) => t.id === id);
}

export function createThread(s: State, init: { title: string; createdBy: string; itemId?: string }): Thread {
  const at = now();
  const thread: Thread = {
    id: uid('th'),
    title: init.title.slice(0, 80),
    itemId: init.itemId,
    createdBy: init.createdBy,
    participants: init.createdBy === 'hq' ? [] : [init.createdBy],
    status: 'open',
    agentHops: 0,
    count: 0,
    cursor: {},
    waiting: [],
    youSeen: 0,
    createdAt: at,
    updatedAt: at,
  };
  s.threads.unshift(thread);
  return thread;
}

/** The ticket's thread, created the first time someone discusses it. */
export function threadForItem(s: State, item: WorkItem, ref: string, createdBy: string): Thread {
  const existing = item.threadId ? findThread(s, item.threadId) : undefined;
  if (existing) return existing;
  const thread = createThread(s, { title: `${ref}: ${item.title}`, createdBy, itemId: item.id });
  item.threadId = thread.id;
  return thread;
}

export function messagesOf(s: State, threadId: string): Message[] {
  return s.messages.filter((m) => m.threadId === threadId);
}

function addParticipant(t: Thread, id: string): void {
  if (id !== 'hq' && !t.participants.includes(id)) t.participants.push(id);
}

/** One-line preview text, so a message that is only images still says something. */
export function previewText(text: string, attachments?: Attachment[]): string {
  if (text.trim()) return text;
  const n = attachments?.length ?? 0;
  return n === 0 ? '' : n === 1 ? 'Sent an image' : `Sent ${n} images`;
}

function append(s: State, t: Thread, msg: Pick<Message, 'from' | 'to' | 'text'> & Partial<Pick<Message, 'undelivered' | 'runId' | 'attachments'>>): Message {
  t.count += 1;
  const message: Message = { id: uid('msg'), threadId: t.id, n: t.count, ts: now(), ...msg };
  if (!message.undelivered?.length) delete message.undelivered;
  if (!message.attachments?.length) delete message.attachments;
  s.messages.push(message);
  if (s.messages.length > MAX_MESSAGES) s.messages = s.messages.slice(-MAX_MESSAGES);
  addParticipant(t, msg.from);
  for (const id of msg.to) addParticipant(t, id);
  if (msg.from !== 'hq') t.last = { from: msg.from, to: msg.to, text: previewText(msg.text, message.attachments).slice(0, 200), ts: message.ts };
  t.updatedAt = message.ts;
  // The author has obviously seen everything up to their own message.
  if (msg.from === 'you') t.youSeen = t.count;
  else if (msg.from !== 'hq') t.cursor[msg.from] = Math.max(t.cursor[msg.from] ?? 0, t.count);
  return message;
}

/** A system note. `undelivered` holds desks for Resume to wake. */
export function note(s: State, t: Thread, text: string, undelivered?: string[]): Message {
  return append(s, t, { from: 'hq', to: [], text, undelivered });
}

/** A desk's reply failed: pause the thread if it is open, and hold the desk so Resume wakes it again. */
export function pauseForFailure(s: State, t: Thread, agentId: string, text: string): Message {
  if (t.status === 'open') {
    t.status = 'paused';
    t.pausedReason = 'failed';
  }
  return note(s, t, text, [agentId]);
}

function addWaiting(t: Thread, ids: string[]): void {
  for (const id of ids) if (!t.waiting.includes(id)) t.waiting.push(id);
}

export function clearWaiting(t: Thread, id: string): void {
  t.waiting = t.waiting.filter((w) => w !== id);
}

export interface Recipients {
  agents: Agent[];
  founder: boolean;
  errors: string[];
}

/** Turn names from a desk's send_message into this project's desks. Patrick counts as "founder". */
export function resolveRecipients(s: State, fromId: string, names: string[]): Recipients {
  const owner = s.agents.find((a) => a.isHuman);
  const founderNames = new Set(['founder', 'you', 'patrick', owner?.name.toLowerCase(), owner?.id].filter(Boolean) as string[]);
  const out: Recipients = { agents: [], founder: false, errors: [] };
  const desks = s.agents.filter((a) => !a.isHuman);
  for (const raw of names) {
    const name = raw.trim().replace(/^@/, '').toLowerCase();
    if (!name) continue;
    if (founderNames.has(name)) {
      out.founder = true;
      continue;
    }
    const hit = desks.find((a) => a.name.toLowerCase() === name || a.id === name);
    if (!hit) {
      out.errors.push(`No teammate called "${raw}". Teammates: ${desks.map((a) => a.name).join(', ')}.`);
      continue;
    }
    if (hit.id === fromId) {
      out.errors.push('You cannot message yourself.');
      continue;
    }
    if (hit.status === 'off') {
      out.errors.push(`${hit.name} is off shift.`);
      continue;
    }
    if (!out.agents.includes(hit)) out.agents.push(hit);
  }
  if (out.agents.length > MAX_RECIPIENTS) out.errors.push(`Message at most ${MAX_RECIPIENTS} teammates at once.`);
  return out;
}

function rollDay(s: State, day: string): void {
  if (s.chat.day !== day) s.chat = { day, wakes: 0 };
}

function pause(s: State, t: Thread, reason: NonNullable<Thread['pausedReason']>, limits: Limits): void {
  if (t.status === 'paused') return;
  t.status = 'paused';
  t.pausedReason = reason;
  note(
    s,
    t,
    reason === 'hop-limit'
      ? `Paused after ${limits.hopLimit} desk-to-desk message${limits.hopLimit === 1 ? '' : 's'}. Patrick can reply or resume.`
      : `Paused: the team hit today's limit of ${limits.dailyCap} desk-to-desk message${limits.dailyCap === 1 ? '' : 's'}. Patrick can resume.`,
  );
}

/** Why a desk-to-desk wake would be held right now, or null if it can go through. */
export function canWake(s: State, t: Thread, limits: Limits = defaultLimits()): 'closed' | 'paused' | 'hop-limit' | 'daily-cap' | null {
  if (t.status === 'closed') return 'closed';
  if (t.status === 'paused') return 'paused';
  rollDay(s, limits.today);
  if (t.agentHops >= limits.hopLimit) return 'hop-limit';
  if (s.chat.wakes >= limits.dailyCap) return 'daily-cap';
  return null;
}

export interface Posted {
  message: Message;
  /** Desks to wake now. */
  deliver: string[];
  paused: boolean;
}

/**
 * A desk posts. The message is always saved. Each desk recipient is one hop; past the
 * limit (or the daily cap) the thread pauses and the rest are held as undelivered.
 */
export function postAgentMessage(s: State, t: Thread, from: string, to: string[], text: string, limits: Limits = defaultLimits(), attachments?: Attachment[]): Posted {
  if (t.status === 'closed') throw new ChatError('This thread is closed.');
  rollDay(s, limits.today);
  const deliver: string[] = [];
  const held: string[] = [];
  let pauseWith: NonNullable<Thread['pausedReason']> | null = null;
  for (const id of to) {
    if (id === 'you') continue;
    if (t.status === 'paused' || pauseWith) held.push(id);
    else if (t.agentHops >= limits.hopLimit) {
      pauseWith = 'hop-limit';
      held.push(id);
    } else if (s.chat.wakes >= limits.dailyCap) {
      pauseWith = 'daily-cap';
      held.push(id);
    } else {
      t.agentHops += 1;
      s.chat.wakes += 1;
      deliver.push(id);
    }
  }
  const message = append(s, t, { from, to, text, undelivered: held, attachments });
  if (pauseWith) pause(s, t, pauseWith, limits);
  addWaiting(t, deliver);
  return { message, deliver, paused: t.status === 'paused' };
}

function lastDeskSpeaker(s: State, t: Thread): string | undefined {
  const msgs = messagesOf(s, t.id);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const from = msgs[i].from;
    if (from !== 'you' && from !== 'hq' && s.agents.some((a) => a.id === from && !a.isHuman)) return from;
  }
  return undefined;
}

/**
 * Patrick posts. Never counts as a hop: it resets the counter and reopens the thread.
 * Wakes the @mentioned desks; with none, the last desk that spoke, or the router's pick.
 */
export function postFounderMessage(s: State, t: Thread, text: string, attachments?: Attachment[]): Posted {
  const desks = s.agents.filter((a) => !a.isHuman && a.status !== 'off');
  let targets = mentionsIn(text, desks).map((a) => a.id);
  if (targets.length === 0) {
    const last = lastDeskSpeaker(s, t);
    if (last && desks.some((a) => a.id === last)) targets = [last];
    else {
      const routed = routeInstruction(text, s.agents);
      if (routed) targets = [routed.agent.id];
    }
  }
  targets = targets.slice(0, MAX_RECIPIENTS);
  if (t.status !== 'open') {
    t.status = 'open';
    t.pausedReason = undefined;
  }
  t.agentHops = 0;
  const message = append(s, t, { from: 'you', to: targets, text, attachments });
  addWaiting(t, targets);
  return { message, deliver: targets, paused: false };
}

/** Reopen a paused thread and deliver what was held. Those deliveries count toward the fresh limit. */
export function resumeThread(s: State, t: Thread, limits: Limits = defaultLimits()): string[] {
  if (t.status === 'closed') throw new ChatError('This thread is closed. Post in it to reopen it.');
  t.status = 'open';
  t.pausedReason = undefined;
  t.agentHops = 0;
  rollDay(s, limits.today);
  const held: string[] = [];
  for (const m of messagesOf(s, t.id)) {
    for (const id of m.undelivered ?? []) if (!held.includes(id)) held.push(id);
    delete m.undelivered;
  }
  const deliver = held.filter((id) => s.agents.some((a) => a.id === id && !a.isHuman && a.status !== 'off'));
  t.agentHops += deliver.length;
  note(s, t, deliver.length ? `Resumed by Patrick. Delivering to ${deliver.map((id) => s.agents.find((a) => a.id === id)?.name ?? id).join(', ')}.` : 'Resumed by Patrick.');
  addWaiting(t, deliver);
  return deliver;
}

export function closeThread(s: State, t: Thread): void {
  if (t.status === 'closed') return;
  t.status = 'closed';
  t.pausedReason = undefined;
  t.waiting = [];
  note(s, t, 'Closed by Patrick.');
}

/** Messages a desk has not been shown yet, and the ones addressed to it. */
export function unreadFor(s: State, t: Thread, agentId: string): { all: Message[]; addressed: Message[] } {
  const seen = t.cursor[agentId] ?? 0;
  const all = messagesOf(s, t.id).filter((m) => m.n > seen && m.from !== agentId);
  return { all, addressed: all.filter((m) => m.to.includes(agentId)) };
}

export function markRead(t: Thread, agentId: string): void {
  t.cursor[agentId] = t.count;
}

/** One queued run per desk per thread: it reads every unread message when it starts. */
export function needsWake(s: State, t: Thread, agentId: string): boolean {
  return !s.runs.some((r) => r.reason === 'message' && r.threadId === t.id && r.agentId === agentId && r.status === 'queued');
}

export interface SettleInput {
  mode: 'ticket' | 'message';
  agentId: string;
  itemId?: string;
  threadId?: string;
  raised: boolean;
  finished: boolean;
  /** The desk posted to the thread it was woken for during this run. */
  sentToThread: boolean;
  /** Desks messaged during a ticket run; the ticket waits for them. */
  awaiting: string[];
  /** Who spoke to the desk in the messages that woke it ('you' and/or desk ids). */
  askedBy: string[];
  summary: string;
  /** Ticket runs: why the desk ran. A reply to your comment never closes the ticket. */
  reason?: string;
  /** The desk commented on its ticket during this run. */
  commented?: boolean;
  /** Dev-team projects: a finished ticket goes to QA instead of Done. */
  qa: boolean;
  /** The project's sign-off setting: a finished ticket waits for your sign-off instead of Done. */
  signoff: boolean;
}

/**
 * What happens when a run ends without the expected tool call.
 * Message runs never touch tickets: leftover text becomes the reply. Ticket runs that
 * asked a teammate stay in progress. Returns desks to wake.
 */
export function settleAfterRun(s: State, input: SettleInput, log: (agentId: string, text: string) => void, limits: Limits = defaultLimits()): string[] {
  if (input.mode === 'message') {
    const t = input.threadId ? findThread(s, input.threadId) : undefined;
    const text = input.summary.trim();
    if (!t || t.status === 'closed' || input.sentToThread || !text) return [];
    const to = input.askedBy.filter((id) => id !== input.agentId);
    return postAgentMessage(s, t, input.agentId, to, text.slice(0, 1500), limits).deliver;
  }

  if (input.raised || input.finished) return [];
  const item = input.itemId ? s.items.find((i) => i.id === input.itemId) : undefined;
  if (input.reason === 'comment') {
    // Woken by your comment: answer it, and leave the ticket where it was.
    const text = input.summary.trim();
    if (item && !input.commented && text) addComment(item, { from: input.agentId, text: text.slice(0, 1500) });
    return [];
  }
  // Waiting on you, with QA, waiting for your sign-off, or already done: nothing for the owner's run to close.
  if (!item || item.status === 'needs-you' || item.status === 'qa' || item.status === 'signoff' || item.status === 'done' || item.assignee !== input.agentId) return [];
  if (input.awaiting.length) {
    const names = input.awaiting.map((id) => s.agents.find((a) => a.id === id)?.name ?? id).join(', ');
    item.history.push({ ts: now(), text: `Waiting on ${names} in chat` });
    if (item.status === 'todo') item.status = 'in-progress';
    return [];
  }
  const where = finishWork(s, item, input.summary, { qa: input.qa, signoff: input.signoff });
  log(input.agentId, where === 'done' ? `Finished "${item.title}"` : `Finished "${item.title}", ${where === 'qa' ? 'sent to QA' : 'ready for your sign-off'}`);
  return [];
}

/** A notice posted to the desk that handed a ticket over: the thread, and the desks to wake. */
export interface HandoffNotice {
  threadId: string;
  deliver: string[];
}

function postHandoff(s: State, item: WorkItem, from: string, text: string): HandoffNotice | null {
  const back = item.handoffFrom ? s.agents.find((a) => a.id === item.handoffFrom && !a.isHuman) : undefined;
  const thread = item.threadId ? findThread(s, item.threadId) : undefined;
  // Nobody to tell, or the ticket came back to the desk that handed it over.
  if (!back || back.id === from || !thread || thread.status === 'closed') return null;
  return { threadId: thread.id, deliver: postAgentMessage(s, thread, from, [back.id], text).deliver };
}

/**
 * A handed-off ticket is done: tell the desk that handed it over, in the ticket's thread. Desks to wake, or null.
 * `told`: what it hears instead when it was already told the ticket is finished (noticeFinished), so the
 * notice at Done says it was signed off rather than reporting it done a second time.
 */
export function noticeHandoff(s: State, item: WorkItem, from: string, text: string, told = text): HandoffNotice | null {
  const posted = postHandoff(s, item, from, item.handoffTold ? told : text);
  // Reopened and finished again later, it is told again.
  if (posted) delete item.handoffTold;
  return posted;
}

/**
 * A handed-off ticket's desk finished it (report_done, or a ticket run that ended without it). Done: the desk
 * that handed it over hears it is done. Into QA or your sign-off: it hears now that it is finished and waiting,
 * so it can carry on instead of waiting for your sign-off; once per ticket, and at Done only that it was signed off.
 */
export function noticeFinished(s: State, item: WorkItem, from: string, ref: string, where: 'done' | 'qa' | 'signoff', summary: string): HandoffNotice | null {
  const said = summary.trim().slice(0, 800) || 'Finished.';
  if (where === 'done') return noticeHandoff(s, item, from, `Done with ${ref}: ${said}`);
  if (item.handoffTold) return null;
  const owner = s.agents.find((a) => a.isHuman)?.name ?? 'the founder';
  const checker = where === 'qa' ? s.agents.find((a) => a.id === item.qa?.by)?.name : undefined;
  const waits = where === 'qa' ? `It is with QA${checker ? ` (${checker})` : ''} before it is done` : `It waits for ${owner}'s sign-off before it is done`;
  const posted = postHandoff(s, item, from, `Finished ${ref}: ${said}\n${waits}. You can carry on; you hear again when it is done.`);
  if (posted) item.handoffTold = true;
  return posted;
}
