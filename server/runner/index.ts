import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent, Attachment, ItemStatus, Meta, Run, RunReason, RunnerName } from '../../shared/types';
import { refreshStatuses, settleInstructions } from '../agents';
import { clearWaiting, findThread, markRead, needsWake, note, pauseForFailure, unreadFor } from '../chat';
import { rewindCursor } from '../cursor';
import { unansweredImages } from '../comments';
import { claudeConfigDir } from '../mcpCli';
import { clearSignoff, qaDeskOf, queuedQaRun, rerouteQa } from '../qa';
import { now, uid, type Project } from '../store';
import { claudeRunner, MODEL, runCost } from './claude';
import { enqueue } from './queue';
import type { RunHooks, RunInput } from './types';

/**
 * Picks the runner and turns work into queued agent runs:
 *   kickoff()  a desk works a ticket it owns, or the QA desk checks one
 *   deliver()  a desk is woken by a chat message
 *   runHuddleDesk()  a desk takes its turn in a huddle
 * sim    = fake activity from server/sim.ts, no Claude calls
 * claude = real Claude Agent SDK sessions
 */

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const hasLogin = fs.existsSync(path.join(claudeConfigDir(), '.credentials.json'));
const explicit = process.env.HQ_RUNNER;
let warned = false;

/** Which credential the Agent SDK will end up using. */
export function authSource(): 'api-key' | 'claude-login' | 'none' {
  if (hasKey) return 'api-key';
  if (hasLogin) return 'claude-login';
  return 'none';
}

/**
 * sim unless a key is present or HQ_RUNNER=claude is set explicitly.
 * Without a key the Agent SDK uses the Claude Code login on this machine (~/.claude),
 * which spends that subscription's usage. Their account, their call, so it needs the
 * explicit flag rather than happening by default.
 */
export function runnerName(): RunnerName {
  if (explicit === 'sim') return 'sim';
  if (explicit === 'claude') {
    if (authSource() === 'none') {
      if (!warned) {
        warned = true;
        console.warn('[hq] HQ_RUNNER=claude but no ANTHROPIC_API_KEY and no Claude Code login found. Falling back to sim.');
      }
      return 'sim';
    }
    if (authSource() === 'claude-login' && !warned) {
      warned = true;
      console.warn('[hq] No ANTHROPIC_API_KEY. Agents will run on the Claude Code login on this machine and spend that subscription’s usage.');
    }
    return 'claude';
  }
  return hasKey ? 'claude' : 'sim';
}

export function isLive(): boolean {
  return runnerName() === 'claude';
}

export function meta(): Meta {
  return { runner: runnerName(), model: MODEL, liveReady: authSource() !== 'none', auth: authSource() };
}

const controllers = new Map<string, AbortController>();
/** Runs the founder stopped. Their failure is not rewound or paused for a retry. */
const cancelled = new Set<string>();

/**
 * The SDK reports a resumed session's running total, not this run's spend.
 * Turn it into this run's share and remember the new total. extra is a failed first attempt's cost
 * when the run was retried in a fresh session (see dropSession), so both attempts are counted. Exported for tests.
 */
export function charge(
  agent: { sessionId?: string; sessionTotalUsd?: number; spentUsd?: number },
  sessionId: string | undefined,
  total: number | undefined,
  extra = 0,
): number | undefined {
  if (total === undefined && !extra) return undefined;
  const cost = (total === undefined ? 0 : runCost(agent, sessionId, total)) + extra;
  if (sessionId && total !== undefined) {
    agent.sessionId = sessionId;
    agent.sessionTotalUsd = total;
  }
  agent.spentUsd = Number(((agent.spentUsd ?? 0) + cost).toFixed(4));
  return Number(cost.toFixed(4));
}

function hooksFor(p: Project): RunHooks {
  return {
    deliver: (threadId, ids) => void deliver(p, threadId, ids),
    kickoff: (itemId, reason) => void kickoff(p, itemId, reason),
  };
}

function track(p: Project, run: Run): void {
  p.state.runs.unshift(run);
  p.state.runs = p.state.runs.slice(0, 500);
}

function skip(p: Project, run: Run, why: string, failed = false): void {
  run.status = failed ? 'failed' : 'done';
  if (failed) run.error = why;
  else run.summary = `Skipped: ${why}`;
  run.finishedAt = now();
  p.commit();
}

/** How a run ended: the desk's full final reply, if it finished, and whether it failed because it was stopped through cancelRun. */
export interface Executed {
  reply?: string;
  cancelled: boolean;
}

/** Run one desk for one job and record the outcome. Shared by every kind of run. */
async function execute(p: Project, run: Run, agent: Agent, input: Omit<RunInput, 'project' | 'run' | 'agent' | 'hooks'>, label: string): Promise<Executed> {
  let reply: string | undefined;
  let stopped = false;
  const controller = new AbortController();
  controllers.set(run.id, controller);
  run.status = 'running';
  run.startedAt = now();
  agent.running = true;
  agent.status = 'working';
  agent.currentTask = label;
  agent.lastActive = now();
  p.commit();

  try {
    const out = await claudeRunner.run({ project: p, run, agent, hooks: hooksFor(p), ...input }, controller.signal);
    run.status = 'done';
    run.costUsd = charge(agent, out.sessionId, out.costUsd, out.extraCostUsd);
    run.turns = out.turns;
    run.summary = out.summary.slice(0, 500);
    reply = out.summary;
  } catch (e) {
    const err = e as Error & { outcome?: { costUsd?: number; turns?: number; sessionId?: string; extraCostUsd?: number } };
    run.status = 'failed';
    run.error = err.message.slice(0, 500);
    run.costUsd = charge(agent, err.outcome?.sessionId, err.outcome?.costUsd, err.outcome?.extraCostUsd);
    run.turns = err.outcome?.turns;
    stopped = cancelled.has(run.id);
    const thread = input.thread ? findThread(p.state, input.thread.id) : undefined;
    // Not answered: the desk sees the same messages again on the next wake. A run the founder stopped stays read.
    const readThreadId = run.threadId ?? run.cursorThread;
    const readThread = readThreadId ? findThread(p.state, readThreadId) : undefined;
    if (readThread && !stopped) rewindCursor(readThread, p.state.messages, agent.id, run.cursorFrom, run.startedAt);
    const failure = `${agent.name}'s run failed: ${run.error}`;
    // A failed reply pauses the thread like a restart does, so Resume tries it again.
    if (input.reason === 'message' && thread) {
      if (stopped) note(p.state, thread, failure);
      else pauseForFailure(p.state, thread, agent.id, failure);
    } else if (input.item) input.item.history.push({ ts: now(), text: `Run failed: ${run.error}` });
    p.log(agent.id, `Hit a problem${input.item ? ` on ${p.ticket(input.item)} "${input.item.title}"` : ''}: ${run.error}`);
    console.error(`[hq] ${p.meta.key} run ${run.id} for ${agent.name} failed:`, err.message);
  } finally {
    controllers.delete(run.id);
    cancelled.delete(run.id);
    run.finishedAt = now();
    agent.running = false;
    agent.lastActive = now();
    if (input.reason === 'message' && input.thread) {
      const thread = findThread(p.state, input.thread.id);
      if (thread && needsWake(p.state, thread, agent.id)) clearWaiting(thread, agent.id);
    }
    settleInstructions(p.state);
    refreshStatuses(p.state);
    p.commit();
  }
  return { reply, cancelled: stopped };
}

/**
 * Why a queued ticket run no longer fits its ticket when its turn comes, or null to run it: decisions made
 * while it waited make it moot. Exported for tests.
 */
export function mootRun(reason: RunReason, status: ItemStatus): string | null {
  // A QA check runs only while the ticket is still in QA.
  if (reason === 'qa') return status === 'qa' ? null : `ticket is ${status}, not in QA`;
  // A comment still gets an answer on any ticket.
  if (reason === 'comment') return null;
  // Your approval is carried out only while the ticket is still approved, not once it moved on (to sign-off, done, back to work).
  if (reason === 'approved') return status === 'approved' ? null : `ticket is ${status}, not approved any more`;
  return ['done', 'approved', 'held', 'qa', 'signoff'].includes(status) ? `ticket is ${status}` : null;
}

export interface KickoffOptions {
  /** Put the team notes in this run's prompt. */
  includeNotes?: boolean;
}

/** Queue a run for the ticket's owner, or for the QA desk when reason is 'qa'. No-op in sim mode. Returns the Run, or null. */
export function kickoff(p: Project, itemId: string, reason: RunReason, note?: string, images: Attachment[] = [], opts: KickoffOptions = {}): Run | null {
  if (!isLive()) return null;
  const s = p.state;
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return null;
  const agent = reason === 'qa' ? qaDeskOf(s) : s.agents.find((a) => a.id === item.assignee);
  if (!agent || agent.isHuman) return null;
  // One waiting QA check per ticket. A running one is not reused: it may be checking an older round, and its verdict will be refused.
  if (reason === 'qa') {
    const queued = queuedQaRun(s, item.id);
    if (queued) return queued;
  }
  // Comments batch: one queued comment run per desk per ticket answers every new comment when it starts.
  if (reason === 'comment') {
    const queued = s.runs.find((r) => r.agentId === agent.id && r.itemId === item.id && r.reason === 'comment' && r.status === 'queued');
    if (queued) {
      // Any comment in the batch that asked for the team notes gets them.
      if (opts.includeNotes) queued.notes = true;
      return queued;
    }
  }

  const run: Run = { id: uid('run'), agentId: agent.id, itemId: item.id, reason, status: 'queued', startedAt: now(), ...(opts.includeNotes ? { notes: true } : {}) };
  track(p, run);
  item.history.push({ ts: now(), text: `Queued for ${agent.name} (${reason})` });
  p.commit();

  void enqueue(`${p.id}:${agent.id}`, async () => {
    // Re-read through the project each time: a reset swaps p.state for a new object.
    const state = p.state;
    const liveRun = state.runs.find((r) => r.id === run.id);
    const liveAgent = state.agents.find((a) => a.id === agent.id);
    const liveItem = state.items.find((i) => i.id === item.id);
    if (!liveRun) return;
    if (!liveItem) return skip(p, liveRun, 'Ticket disappeared before the run started', true);
    if (reason === 'qa' && !liveAgent?.qa) {
      // The QA desk left or stopped QA before its check: pass the ticket on, to the QA desk now or to your sign-off.
      // Skipped first, so the new check is not taken for this one.
      skip(p, liveRun, liveAgent ? `${liveAgent.name} is no longer the QA desk` : 'Desk was removed before the run started', !liveAgent);
      if (rerouteQa(state, liveItem) === 'qa') kickoff(p, liveItem.id, 'qa');
      p.commit();
      return;
    }
    if (!liveAgent) return skip(p, liveRun, 'Desk was removed before the run started', true);
    const moot = mootRun(reason, liveItem.status);
    if (moot) return skip(p, liveRun, moot);

    // The owner is back on it: it is not waiting on your sign-off any more, so Approve starts a run again. A comment answer changes nothing.
    if (reason !== 'qa' && reason !== 'comment') clearSignoff(liveItem);
    if (liveItem.status === 'todo' && reason !== 'comment') liveItem.status = 'in-progress';
    const thread = liveItem.threadId ? findThread(state, liveItem.threadId) : undefined;
    if (thread) {
      // Remember where the desk had read to, so a run that dies before replying can put it back.
      liveRun.cursorFrom = thread.cursor[liveAgent.id] ?? 0;
      liveRun.cursorThread = thread.id;
      markRead(thread, liveAgent.id);
    }
    const label = reason === 'comment' ? `Answering your comment on ${p.ticket(liveItem)}` : reason === 'qa' ? `QA: ${liveItem.title}` : liveItem.title;
    // A comment run sees the images on every comment it has not answered yet, not only the first one's.
    const runImages = reason === 'comment' ? [...images, ...unansweredImages(liveItem, liveAgent.id)] : images;
    await execute(p, liveRun, liveAgent, { item: liveItem, reason, note, thread, images: runImages, includeNotes: liveRun.notes }, label);
  });

  return run;
}

/** How one desk's huddle turn went. skipped: the huddle was not running when its turn came, or a stop cut it short, so it keeps its place. */
export interface HuddleTurn {
  ran: boolean;
  ok: boolean;
  skipped?: boolean;
  /** The desk's final reply. Used when it never called its huddle tool. */
  reply: string;
  error?: string;
}

/**
 * What a finished huddle run tells the round engine. A run you stopped keeps the desk's place, even
 * when the huddle is running again by the time it ends (Stop, then a quick Resume). Exported for tests.
 */
export function huddleTurnOf(run: Pick<Run, 'status' | 'error'>, out: Executed): HuddleTurn {
  if (out.cancelled) return { ran: true, ok: false, skipped: true, reply: '' };
  return { ran: true, ok: run.status === 'done', reply: out.reply ?? '', error: run.error };
}

/** One desk's turn in a huddle, queued like any other run. Resolves when it finishes or is skipped. Live mode only. */
export async function runHuddleDesk(p: Project, huddleId: string, agentId: string, role: 'participant' | 'facilitator', label: string, includeNotes: boolean): Promise<HuddleTurn> {
  const run: Run = { id: uid('run'), agentId, reason: 'huddle', huddleId, status: 'queued', startedAt: now(), ...(includeNotes ? { notes: true } : {}) };
  track(p, run);
  p.commit();
  let turn: HuddleTurn = { ran: false, ok: false, reply: '', error: 'The run never started' };
  try {
    await enqueue(`${p.id}:${agentId}`, async () => {
      const state = p.state;
      const liveRun = state.runs.find((r) => r.id === run.id);
      if (!liveRun) return;
      const liveAgent = state.agents.find((a) => a.id === agentId && !a.isHuman);
      if (!liveAgent) {
        turn = { ran: false, ok: false, reply: '', error: 'Desk was removed' };
        return skip(p, liveRun, 'Desk was removed before the run started', true);
      }
      const h = state.huddles.find((x) => x.id === huddleId);
      if (!h || h.status !== 'running') {
        turn = { ran: false, ok: false, skipped: true, reply: '' };
        return skip(p, liveRun, 'the huddle was stopped');
      }
      const out = await execute(p, liveRun, liveAgent, { reason: 'huddle', huddle: { id: huddleId, role }, includeNotes }, label);
      turn = huddleTurnOf(liveRun, out);
    });
  } catch (e) {
    turn = { ran: false, ok: false, reply: '', error: (e as Error).message };
  }
  return turn;
}

/**
 * Wake desks for a chat message. One queued run per desk per thread; that run reads every
 * unread message when it starts. No-op in sim mode, where server/sim.ts answers instead.
 */
export function deliver(p: Project, threadId: string, ids: string[]): Run[] {
  const s = p.state;
  const t = findThread(s, threadId);
  if (!t || !isLive()) return [];
  const queued: Run[] = [];
  for (const id of ids) {
    const agent = s.agents.find((a) => a.id === id && !a.isHuman);
    if (!agent || t.status === 'closed') {
      clearWaiting(t, id);
      continue;
    }
    if (!needsWake(s, t, id)) continue;
    const run: Run = { id: uid('run'), agentId: id, itemId: t.itemId, threadId: t.id, reason: 'message', status: 'queued', startedAt: now() };
    track(p, run);
    queued.push(run);

    void enqueue(`${p.id}:${id}`, async () => {
      const state = p.state;
      const liveRun = state.runs.find((r) => r.id === run.id);
      const liveAgent = state.agents.find((a) => a.id === id);
      const thread = findThread(state, threadId);
      const done = (why: string, failed = false) => {
        if (thread) clearWaiting(thread, id);
        if (liveRun) skip(p, liveRun, why, failed);
        else p.commit();
      };
      if (!liveRun || !thread) return done('thread or run is gone', true);
      if (!liveAgent) return done('desk was removed', true);
      if (thread.status === 'closed') return done('thread is closed');
      const unread = unreadFor(state, thread, id);
      if (unread.addressed.length === 0) return done('nothing new for this desk');

      // Remember where the desk had read to, so a run that dies before replying can be retried.
      liveRun.cursorFrom = thread.cursor[id] ?? 0;
      markRead(thread, id);
      const item = thread.itemId ? state.items.find((i) => i.id === thread.itemId) : undefined;
      // Only the founder's images go in inline. Desk images reach teammates as file paths in the messages.
      const images = unread.all.filter((m) => m.from === 'you').flatMap((m) => m.attachments ?? []);
      await execute(p, liveRun, liveAgent, { item, reason: 'message', thread, unread: unread.all, images }, `Replying in "${thread.title}"`);
    });
  }
  p.commit();
  return queued;
}

export function cancelRun(runId: string): boolean {
  const c = controllers.get(runId);
  if (!c) return false;
  cancelled.add(runId);
  c.abort();
  return true;
}
