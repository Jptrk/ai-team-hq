import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent, Attachment, Meta, Run, RunReason, RunnerName } from '../../shared/types';
import { refreshStatuses, settleInstructions } from '../agents';
import { clearWaiting, findThread, markRead, needsWake, note, pauseForFailure, unreadFor } from '../chat';
import { rewindCursor } from '../cursor';
import { unansweredImages } from '../comments';
import { now, uid, type Project } from '../store';
import { claudeRunner, MODEL } from './claude';
import { enqueue } from './queue';
import type { RunHooks, RunInput } from './types';

/**
 * Picks the runner and turns work into queued agent runs:
 *   kickoff()  a desk works a ticket it owns
 *   deliver()  a desk is woken by a chat message
 * sim    = fake activity from server/sim.ts, no Claude calls
 * claude = real Claude Agent SDK sessions
 */

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const hasLogin = fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));
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
 * Turn it into this run's share and remember the new total.
 */
function charge(agent: { sessionId?: string; sessionTotalUsd?: number; spentUsd?: number }, sessionId: string | undefined, total: number | undefined): number | undefined {
  if (total === undefined) return undefined;
  const sameSession = Boolean(sessionId && agent.sessionId && sessionId === agent.sessionId);
  const cost = Math.max(0, total - (sameSession ? (agent.sessionTotalUsd ?? 0) : 0));
  if (sessionId) {
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

/** Run one desk for one job and record the outcome. Shared by ticket runs and message runs. */
async function execute(p: Project, run: Run, agent: Agent, input: Omit<RunInput, 'project' | 'run' | 'agent' | 'hooks'>, label: string): Promise<void> {
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
    run.costUsd = charge(agent, out.sessionId, out.costUsd);
    run.turns = out.turns;
    run.summary = out.summary.slice(0, 500);
  } catch (e) {
    const err = e as Error & { outcome?: { costUsd?: number; turns?: number; sessionId?: string } };
    run.status = 'failed';
    run.error = err.message.slice(0, 500);
    run.costUsd = charge(agent, err.outcome?.sessionId, err.outcome?.costUsd);
    run.turns = err.outcome?.turns;
    const stopped = cancelled.has(run.id);
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
}

/** Queue a run for the ticket's owner. No-op in sim mode. Returns the Run, or null. */
export function kickoff(p: Project, itemId: string, reason: RunReason, note?: string, images: Attachment[] = []): Run | null {
  if (!isLive()) return null;
  const s = p.state;
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return null;
  const agent = s.agents.find((a) => a.id === item.assignee);
  if (!agent || agent.isHuman) return null;
  // Comments batch: one queued comment run per desk per ticket answers every new comment when it starts.
  if (reason === 'comment') {
    const queued = s.runs.find((r) => r.agentId === agent.id && r.itemId === item.id && r.reason === 'comment' && r.status === 'queued');
    if (queued) return queued;
  }

  const run: Run = { id: uid('run'), agentId: agent.id, itemId: item.id, reason, status: 'queued', startedAt: now() };
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
    if (!liveAgent) return skip(p, liveRun, 'Desk was removed before the run started', true);
    if (!liveItem) return skip(p, liveRun, 'Ticket disappeared before the run started', true);
    // Decisions made while queued make the run moot. A comment still gets an answer on any ticket.
    if (reason !== 'approved' && reason !== 'comment' && ['done', 'approved', 'held'].includes(liveItem.status)) return skip(p, liveRun, `ticket is ${liveItem.status}`);

    if (liveItem.status === 'todo' && reason !== 'comment') liveItem.status = 'in-progress';
    const thread = liveItem.threadId ? findThread(state, liveItem.threadId) : undefined;
    if (thread) {
      // Remember where the desk had read to, so a run that dies before replying can put it back.
      liveRun.cursorFrom = thread.cursor[liveAgent.id] ?? 0;
      liveRun.cursorThread = thread.id;
      markRead(thread, liveAgent.id);
    }
    const label = reason === 'comment' ? `Answering your comment on ${p.ticket(liveItem)}` : liveItem.title;
    // A comment run sees the images on every comment it has not answered yet, not only the first one's.
    const runImages = reason === 'comment' ? [...images, ...unansweredImages(liveItem, liveAgent.id)] : images;
    await execute(p, liveRun, liveAgent, { item: liveItem, reason, note, thread, images: runImages }, label);
  });

  return run;
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
