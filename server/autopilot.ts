import type { Agent, AutoState, AutoStatus, Hold, PauseInfo, ProjectMeta, Run, RunReason, State, Thread, WorkItem } from '../shared/types';
import { autoLimitsOf, localDay } from '../shared/types';
import { clearWaiting, note } from './chat';
import { goalStatusOf } from './goal';
import type { UsageLimit } from './runner/watch';
import { settings, type UsageHold } from './settings';
import { now, type Project } from './store';

/**
 * What the team may start on its own, and what waits.
 *
 * Every start a desk makes for another (a hand-off, a chat wake, a QA check) and every Autopilot start goes through
 * one gate. Closed, the start is held as data: on its ticket (autoHold) or in the project's held chat wakes. Nothing
 * waits in memory, so a restart loses nothing, and releaseHolds() starts it all again once the gate opens.
 * Your own clicks never go through the gate.
 */

/** How long automatic work waits when Claude reports a usage limit without saying when it resets. */
const USAGE_RETRY_MS = 30 * 60_000;

function usageActive(u: UsageHold | undefined, nowMs: number): u is UsageHold {
  return Boolean(u && (u.kind === 'account' || !u.until || Date.parse(u.until) > nowMs));
}

/** Why nothing automatic may start in any project: your Pause, or Claude's refusal while it lasts. */
export function globalHold(nowMs = Date.now()): Hold | null {
  const s = settings();
  if (s.paused) return { kind: 'paused', text: 'HQ is paused' };
  const u = s.usageHold;
  if (usageActive(u, nowMs)) return { kind: u.kind, text: u.text, ...(u.until ? { until: u.until } : {}) };
  return null;
}

/** Your next local midnight, when today's limits start over. */
export function nextMidnight(nowMs = Date.now()): string {
  const d = new Date(nowMs);
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

/** Today's count of the team's own runs, started over when your local day changed. */
export function usageToday(s: State, nowMs = Date.now()): AutoState['usage'] {
  const day = localDay(new Date(nowMs));
  if (s.auto.usage.day !== day) s.auto.usage = { day, runs: 0, usd: 0 };
  return s.auto.usage;
}

/** A run the team started began: it counts toward today's runs. */
export function countStart(s: State, nowMs = Date.now()): void {
  usageToday(s, nowMs).runs += 1;
}

/** Its estimated cost counts toward the day it started. One that started before midnight adds nothing to the new day. */
export function countCost(s: State, run: Pick<Run, 'startedAt' | 'costUsd'>, nowMs = Date.now()): void {
  if (!run.costUsd) return;
  const u = usageToday(s, nowMs);
  if (localDay(new Date(run.startedAt)) !== u.day) return;
  u.usd = Math.round((u.usd + run.costUsd) * 10_000) / 10_000;
}

/**
 * Why nothing automatic may start in this project, beyond the global hold: today's limits.
 * queued: the team's runs already queued here, counted as started, so a burst of starts can't pass the run limit.
 */
export function projectHold(p: Project, nowMs = Date.now(), queued = 0): Hold | null {
  const limits = autoLimitsOf(p.meta);
  const u = usageToday(p.state, nowMs);
  const until = nextMidnight(nowMs);
  if (u.runs + queued >= limits.runs) return { kind: 'runs', text: `the ${limits.runs} runs the team may start on its own today are used up`, until };
  if (u.usd >= limits.usd) return { kind: 'usd', text: `the $${limits.usd} the team may spend on its own today is used up (estimated)`, until };
  return null;
}

/** Autopilot stopped itself here after 3 failed runs: no picks and no goal planning until you resume it. Hand-offs, chats and QA go on. */
export function haltedHold(p: Project): Hold | null {
  const halted = p.state.auto.halted;
  return halted ? { kind: 'halted', text: `Autopilot stopped here: ${halted.why}` } : null;
}

/** Why the team may not start anything on its own in this project right now, or null when it may. */
export function autoGate(p: Project, nowMs = Date.now(), queued = 0): Hold | null {
  return globalHold(nowMs) ?? projectHold(p, nowMs, queued);
}

/** The team's runs queued in this project and not started yet. */
export function queuedAuto(p: Project): number {
  return p.state.runs.filter((r) => r.auto && r.status === 'queued').length;
}

/** For the board: why the team's own work waits here, today's count, and what waits. */
export function autoStatus(p: Project, nowMs = Date.now()): AutoStatus {
  const hold = autoGate(p, nowMs) ?? haltedHold(p);
  const u = usageToday(p.state, nowMs);
  const limits = autoLimitsOf(p.meta);
  return {
    hold,
    today: { day: u.day, runs: u.runs, usd: u.usd, maxRuns: limits.runs, maxUsd: limits.usd, resetsAt: nextMidnight(nowMs) },
    held: heldCount(p),
    skipped: p.state.items.filter((i) => i.autoSkip && i.status !== 'done').length,
    ...(p.meta.goalMode ? { goal: goalStatusOf(p) } : {}),
  };
}

/** For the page: why HQ holds automatic work, or null. */
export function pauseInfo(nowMs = Date.now()): PauseInfo | null {
  const s = settings();
  if (s.paused) return { by: 'you', at: s.paused.at };
  const u = s.usageHold;
  if (usageActive(u, nowMs)) return { by: u.kind, at: u.at, reason: u.text, ...(u.until ? { until: u.until } : {}) };
  return null;
}

/** A usage limit whose reset time has passed: the sweep clears it and held work starts again. */
export function usageHoldExpired(nowMs = Date.now()): boolean {
  const u = settings().usageHold;
  return Boolean(u && u.kind === 'usage' && u.until && Date.parse(u.until) <= nowMs);
}

/** The hold Claude's refusal puts on automatic work. A usage limit with no reset time is tried again after half an hour. */
export function usageHoldFrom(limit: UsageLimit, nowMs = Date.now()): UsageHold {
  const at = new Date(nowMs).toISOString();
  if (limit.kind === 'account') return { kind: 'account', at, text: limit.text };
  return { kind: 'usage', at, text: limit.text, until: limit.until ?? new Date(nowMs + USAGE_RETRY_MS).toISOString() };
}

const START_WORDS: Partial<Record<RunReason, string>> = {
  handoff: 'the hand-off',
  qa: 'the QA check',
  'qa-fail': 'the fix after QA',
  auto: "Autopilot's start",
};

/** What a start is held for: a gate (Hold), or login while HQ is idle without a Claude login to run on. */
export type HeldFor = Pick<Hold, 'text'> & { kind: Hold['kind'] | 'login' };

/** A hold's words inside a sentence: Claude's limit texts are sentences of their own, so their full stop goes. */
export function holdWords(hold: Pick<Hold, 'text'>): string {
  return hold.text.replace(/\.\s*$/, '');
}

/**
 * Hold a start the team made for this ticket. Held again for the same start, it keeps its place in line and its
 * history line. at: when it was first held, kept when a released start is held again.
 */
export function holdItem(item: WorkItem, reason: RunReason, hold: HeldFor, restarts?: number, at?: string): void {
  const same = item.autoHold?.reason === reason;
  item.autoHold = { reason, at: at ?? (same ? item.autoHold!.at : now()), why: hold.kind, ...(restarts ? { restarts } : {}) };
  if (!same && !at) item.history.push({ ts: now(), text: `Held ${START_WORDS[reason] ?? 'a run'}: ${holdWords(hold)}. It starts when that clears.` });
}

/** Hold a chat wake. The thread says why it waits, once per desk per thread. A desk mid-reply here keeps showing as replying. */
export function holdWake(p: Project, t: Thread, agentId: string, hold: HeldFor, restarts?: number, mine = false): void {
  const s = p.state;
  const replying = s.runs.some((r) => r.status === 'running' && r.reason === 'message' && r.threadId === t.id && r.agentId === agentId);
  if (!replying) clearWaiting(t, agentId);
  const held = s.auto.heldWakes.find((w) => w.threadId === t.id && w.agentId === agentId);
  // Already held here, and said so. Yours now when you wrote while HQ was idle.
  if (held) {
    if (mine) Object.assign(held, { mine: true as const, why: hold.kind });
    return;
  }
  s.auto.heldWakes.push({ threadId: t.id, agentId, at: now(), why: hold.kind, ...(restarts ? { restarts } : {}), ...(mine ? { mine: true as const } : {}) });
  const name = s.agents.find((a) => a.id === agentId)?.name ?? agentId;
  note(s, t, `${name} sees this once it clears: ${holdWords(hold)}.`);
}

/** Ticket statuses that keep a desk busy: it is working that ticket (or was, until a run failed and Autopilot left it). */
const ACTIVE = new Set(['in-progress', 'sent-back', 'approved']);

/**
 * Desks Autopilot may give work to now: not you, not off shift, nothing queued or running, not in a running huddle,
 * no active ticket of their own (one Autopilot gave up on doesn't count), and fewer than 2 of theirs waiting on you.
 * Exported for tests.
 */
export function freeDesks(s: State): Agent[] {
  const busy = new Set(s.runs.filter((r) => r.status === 'queued' || r.status === 'running').map((r) => r.agentId));
  const huddling = new Set(s.huddles.filter((h) => h.status === 'running').flatMap((h) => [h.facilitator, ...h.participants]));
  return s.agents.filter((a) => {
    if (a.isHuman || a.status === 'off' || a.running || busy.has(a.id) || huddling.has(a.id)) return false;
    const mine = s.items.filter((i) => i.assignee === a.id);
    // An active ticket keeps its desk busy, unless Autopilot left it for you or its last run failed (it waits for you).
    if (mine.some((i) => ACTIVE.has(i.status) && !i.autoSkip && s.runs.find((r) => r.itemId === i.id && r.agentId === a.id)?.status !== 'failed')) return false;
    return mine.filter((i) => i.status === 'needs-you').length < 2;
  });
}

/**
 * Autopilot's next starts: each free desk's oldest To do ticket (by number), oldest first across desks, at most
 * slots of them. Not one already held, skipped, or with a run queued. reserved: desks kept free for something else
 * (the lead, when goal planning is due). Exported for tests.
 */
export function pickStarts(s: State, meta: Pick<ProjectMeta, 'autopilot'>, slots: number, reserved: ReadonlySet<string> = new Set()): { agentId: string; itemId: string }[] {
  if (!meta.autopilot || slots <= 0) return [];
  const queuedFor = new Set(s.runs.filter((r) => r.status === 'queued' && r.itemId).map((r) => r.itemId));
  const picks: { agentId: string; itemId: string; number: number }[] = [];
  for (const desk of freeDesks(s)) {
    if (reserved.has(desk.id)) continue;
    let next: WorkItem | undefined;
    for (const i of s.items) {
      if (i.assignee !== desk.id || i.status !== 'todo' || i.autoHold || i.autoSkip || queuedFor.has(i.id)) continue;
      if (!next || (i.number ?? 0) < (next.number ?? 0)) next = i;
    }
    if (next) picks.push({ agentId: desk.id, itemId: next.id, number: next.number ?? 0 });
  }
  return picks
    .sort((a, b) => a.number - b.number)
    .slice(0, slots)
    .map(({ agentId, itemId }) => ({ agentId, itemId }));
}

/** One of Autopilot's own runs (a pick or a plan) failed: it leaves the ticket for you, and 3 failures in a row stop it in this project. */
export function noteAutoFailure(p: Project, item: WorkItem | undefined, why: string, strike = true): void {
  const s = p.state;
  if (item && item.status !== 'done') {
    item.autoSkip = { at: now(), why };
    delete item.autoHold;
  }
  if (!strike) return;
  s.auto.failStreak += 1;
  if (s.auto.failStreak >= 3 && !s.auto.halted) {
    s.auto.halted = { at: now(), why: '3 automatic runs failed in a row' };
    const lead = s.agents.find((a) => a.lead && !a.isHuman) ?? s.agents.find((a) => !a.isHuman);
    if (lead) p.log(lead.id, 'Autopilot stopped in this project after 3 automatic runs failed in a row. It waits for you to resume it.');
  }
}

/** An automatic run finished fine: the failure streak starts over. */
export function noteAutoSuccess(p: Project): void {
  p.state.auto.failStreak = 0;
}

/** You resumed Autopilot in this project after it stopped itself. */
export function resumeProject(p: Project): void {
  delete p.state.auto.halted;
  p.state.auto.failStreak = 0;
}

/** Starts and wakes waiting in this project. */
export function heldCount(p: Project): number {
  return p.state.items.filter((i) => i.autoHold).length + p.state.auto.heldWakes.length;
}
