import type { Agent, Attachment, ItemStatus, Meta, Run, RunReason, RunnerName, WorkItem } from '../../shared/types';
import { projectProvider } from '../../shared/types';
import { refreshStatuses, settleInstructions } from '../agents';
import { clearWaiting, findThread, markRead, needsWake, note, pauseForFailure, unreadFor } from '../chat';
import { rewindCursor } from '../cursor';
import { unansweredComment, unansweredImages } from '../comments';
import { hasClaudeLogin } from '../claudeAuth';
import { gptOptIn, gptReady, hasChatGptLogin } from '../codexAuth';
import { autoGate, countCost, countStart, globalHold, heldCount, setModelGate, holdItem, holdWake, holdWords, noteAutoFailure, noteAutoSuccess, pauseInfo, pickStarts, queuedAuto, usageHoldExpired, usageHoldFrom, type HeldFor } from '../autopilot';
import { clearSignoff, qaDeskOf, queuedQaRun, rerouteQa } from '../qa';
import { setPaused, settings, setUsageHold } from '../settings';
import { allProjects, now, uid, type Project } from '../store';
import { claudeRunner, MODEL, runCost } from './claude';
import { codexRunner, isGptSession } from './codex';
import { goalState, planDue, plannerOf } from '../goal';
import { CONCURRENCY, enqueue } from './queue';
import type { AgentRunner, RunHooks, RunInput } from './types';
import type { UsageLimit } from './watch';

/**
 * Picks the runner and turns work into queued agent runs:
 *   kickoff()  a desk works a ticket it owns, or the QA desk checks one
 *   deliver()  a desk is woken by a chat message
 *   runHuddleDesk()  a desk takes its turn in a huddle
 * sim  = fake activity from server/sim.ts, no model calls
 * live = real runs, each on its project's model: Claude Agent SDK sessions (claude.ts), or Codex threads on your
 *        ChatGPT login in GPT projects (codex.ts)
 */

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const explicit = process.env.HQ_RUNNER;

/** Which credential the Agent SDK will end up using. Checked each time: you can sign in or out while HQ runs. */
export function authSource(): 'api-key' | 'claude-login' | 'none' {
  if (hasKey) return 'api-key';
  if (hasClaudeLogin()) return 'claude-login';
  return 'none';
}

/** Desks may run on the Claude login: HQ_RUNNER=claude in .env, or you signed in from HQ's Accounts page. */
export function loginOptIn(): boolean {
  return explicit === 'claude' || Boolean(settings().claudeLogin);
}

/** Why a project's model can't run: its login's switch is off, or HQ has no such login. */
type ModelCause = 'claude-off' | 'claude-login' | 'gpt-off' | 'gpt-login';

/** Each cause in full for the page (problem), and in a few words for what waits on it (hold). */
const MODEL_WHY: Record<ModelCause, { problem: string; hold: string }> = {
  'claude-off': {
    problem:
      "This project runs on Claude, but Run desks on my Claude login is off (HQ started without it). On HQ's Accounts page, turn it on, or switch the project to GPT in Project settings.",
    hold: 'this project runs on Claude and Run desks on my Claude login is off',
  },
  'claude-login': {
    problem:
      "This project runs on Claude, but HQ has no Claude login for it. On HQ's Accounts page, sign in to Claude and turn on Run desks on my Claude login, or switch the project to GPT in Project settings.",
    hold: 'this project runs on Claude and HQ has no Claude login for it',
  },
  'gpt-off': {
    problem: "This project runs on GPT, but Run GPT desks on my ChatGPT login is off. Turn it on on HQ's Accounts page, or switch the project to Claude in Project settings.",
    hold: 'this project runs on GPT and Run GPT desks on my ChatGPT login is off',
  },
  'gpt-login': {
    problem:
      "This project runs on GPT, but HQ has no ChatGPT login for it. On HQ's Accounts page, sign in to ChatGPT and turn on Run GPT desks on my ChatGPT login, or switch the project to Claude in Project settings.",
    hold: 'this project runs on GPT and HQ has no ChatGPT login for it',
  },
};

/**
 * A Claude project's desks don't run on Claude now: their work waits (modelProblem). Never with a key. Without one, when:
 *   - Claude was never said yes to (not now, not when HQ started): HQ is live through GPT alone, and a Claude desk
 *     must not quietly spend a Claude login you never opted into; or
 *   - there is no Claude login while GPT desks can run: a refused login would put every desk, GPT ones too, on an
 *     account hold.
 * Otherwise the Claude runner runs as it always did: switching the login off keeps desks on it until HQ restarts,
 * and a lost login is the usual account hold. Pure: exported for tests.
 */
export function claudeBlocked(o: { hasKey: boolean; optIn: boolean; atBoot: boolean; auth: ReturnType<typeof authSource>; gpt: boolean }): boolean {
  if (o.hasKey) return false;
  return (!o.optIn && !o.atBoot) || (o.auth === 'none' && o.gpt);
}

/**
 * sim unless a key is present, or you opted in to the Claude login (loginOptIn) and there is one, or GPT desks may
 * run on a ChatGPT login (gpt: opted in and signed in). Without a key the Agent SDK uses the Claude Code login on
 * this machine (~/.claude), which spends that subscription's usage. Their account, their call, so it needs an
 * explicit yes rather than happening by default. The same goes for the ChatGPT plan. HQ_RUNNER=sim always wins.
 * Pure: exported for tests.
 */
export function pickRunner(o: { explicit?: string; hasKey: boolean; optIn: boolean; auth: ReturnType<typeof authSource>; gpt?: boolean }): RunnerName {
  if (o.explicit === 'sim') return 'sim';
  if (o.hasKey) return 'live';
  if ((o.optIn || o.explicit === 'claude') && o.auth !== 'none') return 'live';
  return o.gpt ? 'live' : 'sim';
}

/**
 * HQ can't go live (no login, or you turned the Claude login off), but these projects are real: you said yes to the
 * login, or HQ has gone live here before (wentLive, which signing out never clears). It doesn't fall back to the sim,
 * which fakes work inside every project (tickets, Needs you items, chat, activity). Desks stay idle until HQ can go
 * live. Only HQ_RUNNER=sim runs the sim then. Pure: exported for tests.
 */
export function pickIdle(o: { runner: RunnerName; explicit?: string; optIn: boolean; wentLive: boolean }): boolean {
  return o.runner === 'sim' && o.explicit !== 'sim' && (o.optIn || o.explicit === 'claude' || o.wentLive);
}

let chosen: RunnerName | null = null;
let idle = false;
/** Claude desks were allowed when the runner was picked (boot): a key, or a yes to the Claude login. See claudeBlocked. */
let claudeAtBoot = false;

/** Picked once, at the first ask (boot): the sim, the demo seed and Autopilot's sweep are set up for one mode. */
export function runnerName(): RunnerName {
  if (chosen) return chosen;
  const optIn = loginOptIn();
  const gpt = gptReady();
  claudeAtBoot = hasKey || optIn;
  chosen = pickRunner({ explicit, hasKey, optIn, auth: authSource(), gpt });
  idle = pickIdle({ runner: chosen, explicit, optIn: optIn || gptOptIn(), wentLive: Boolean(settings().wentLive) });
  if (explicit !== 'sim' && !hasKey && optIn) {
    console.warn(
      authSource() !== 'none'
        ? '[hq] No ANTHROPIC_API_KEY. Claude desks will run on the Claude login on this machine and spend that subscription’s usage.'
        : chosen === 'live'
          ? "[hq] No ANTHROPIC_API_KEY and no Claude login: Claude desks can't run until you sign in from HQ's Accounts page. GPT desks run on your ChatGPT login."
          : "[hq] Live mode is on but there is no ANTHROPIC_API_KEY and no Claude login. Desks stay idle (no sim: it would fake work in your projects). Sign in from HQ's Accounts page, then restart HQ.",
    );
  }
  if (explicit !== 'sim' && gpt) console.warn('[hq] GPT desks will run on the ChatGPT login in HQ’s Codex and spend that plan’s usage.');
  return chosen;
}

/** Claude desks were allowed when HQ started (a key, or a yes to the Claude login): switching it off then keeps them on it until a restart. */
export function claudeAtStart(): boolean {
  runnerName();
  return claudeAtBoot;
}

/** Picked with the runner: no login to go live on, and no sim either (see pickIdle). */
export function isIdle(): boolean {
  return !testRunner && runnerName() === 'sim' && idle;
}

/** Tests only: act as an idle HQ (see pickIdle), which a test process can't otherwise reach after its runner is picked. */
export function setIdleForTests(on: boolean): void {
  idle = on;
}

/** Idle: what you start waits on its ticket or thread, as held work does, and begins once HQ is live (releaseHolds). */
const LOGIN_HOLD: HeldFor = { kind: 'login', text: 'HQ has no login to run desks on' };

/** Why a run can't start now: idle, or sim. */
export function notLiveText(): string {
  return isIdle()
    ? "HQ has no login to run desks on. On HQ's Accounts page, sign in to Claude or ChatGPT and turn on running desks on it, then restart HQ."
    : "Live runner is off. Go live from HQ's Accounts page.";
}

/**
 * Idle, or the project's model can't run (also when your start was already queued): your start waits on its ticket
 * with what you gave it, and starts as your own click once it can (releaseYours). A comment answer never takes the
 * place of a held start of yours for the work: the answer follows it.
 */
function holdYours(item: WorkItem, reason: RunReason, note: string | undefined, images: Attachment[], includeNotes: boolean, why: HeldFor = LOGIN_HOLD): void {
  if (reason === 'comment' && item.autoHold?.mine) return;
  // The same start again (say, a second Instruct): your latest note and images, or the earlier ones when it has none.
  const prev = item.autoHold?.mine && item.autoHold.reason === reason ? item.autoHold : undefined;
  holdItem(item, reason, why, undefined, undefined, true);
  const hold = item.autoHold!;
  const keptNote = note || prev?.note;
  const keptImages = images.length ? images : (prev?.images ?? []);
  if (keptNote) hold.note = keptNote;
  if (keptImages.length) hold.images = keptImages;
  if (includeNotes || prev?.notes) hold.notes = true;
}

/** You signed in from HQ while it runs in sim: the next start is live. */
export function restartToGoLive(): boolean {
  return !testRunner && runnerName() === 'sim' && explicit !== 'sim' && ((loginOptIn() && authSource() !== 'none') || gptReady());
}

/** Tests only: desks run on this instead of Claude or Codex, and HQ acts as live. */
let testRunner: AgentRunner | null = null;
export function useRunnerForTests(r: AgentRunner | null): void {
  testRunner = r;
}

export function isLive(): boolean {
  return Boolean(testRunner) || runnerName() === 'live';
}

/** Claude desks can't run now (see claudeBlocked), with what HQ has at this moment. */
function claudeBlockedNow(): boolean {
  return claudeBlocked({ hasKey, optIn: loginOptIn(), atBoot: claudeAtStart(), auth: authSource(), gpt: gptReady() });
}

/**
 * Why this project's desks can't run on its model now, or null, so the page and the holds name the real cause: GPT
 * with its switch off or no ChatGPT login, or Claude blocked (see claudeBlocked) with a login whose switch is off, or
 * none. Live HQ only; never with a test runner.
 */
function modelCause(p: Project): ModelCause | null {
  if (testRunner || !isLive()) return null;
  if (projectProvider(p.meta) === 'gpt') {
    if (gptReady()) return null;
    return hasChatGptLogin() && !gptOptIn() ? 'gpt-off' : 'gpt-login';
  }
  if (!claudeBlockedNow()) return null;
  return authSource() !== 'none' ? 'claude-off' : 'claude-login';
}

/** Why this project's desks can't run on its model now, in full for the page, or null. */
export function modelProblem(p: Project): string | null {
  const cause = modelCause(p);
  return cause ? MODEL_WHY[cause].problem : null;
}

/** The hold for work in a project whose model can't run: it starts by itself once it can. */
function modelHold(p: Project): HeldFor | null {
  const cause = modelCause(p);
  return cause ? { kind: 'model', text: MODEL_WHY[cause].hold } : null;
}
// Automatic work in such a project waits at the same gate as a Pause or a limit (autoGate).
setModelGate((p) => {
  const h = modelHold(p);
  return h ? { kind: 'model', text: h.text } : null;
});

export function meta(): Meta {
  const s = settings();
  return {
    runner: testRunner ? 'live' : runnerName(),
    model: MODEL,
    effort: s.effort ?? null,
    gpt: { optedIn: gptOptIn(), ready: gptReady(), model: s.gptModel ?? null, effort: s.gptEffort ?? null },
    paused: pauseInfo(),
    held: allProjects().reduce((n, p) => n + heldCount(p), 0),
    liveReady: authSource() !== 'none' || gptReady(),
    claudeReady: testRunner ? true : !claudeBlockedNow(),
    auth: authSource(),
    restartToGoLive: restartToGoLive(),
    simByEnv: explicit === 'sim',
    optedIn: loginOptIn(),
    idle: isIdle(),
  };
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

/** What a running desk starts for others is the team's own: held while HQ is paused or a limit is hit. */
function hooksFor(p: Project): RunHooks {
  return {
    deliver: (threadId, ids) => void deliver(p, threadId, ids, { auto: true }),
    kickoff: (itemId, reason) => void kickoff(p, itemId, reason, undefined, [], { auto: true }),
    held: () => {
      const hold = autoGate(p);
      return hold ? holdWords(hold) : null;
    },
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
  // The team's own run counts toward the project's daily limit as it starts.
  if (run.auto) countStart(p.state);
  agent.running = true;
  agent.status = 'working';
  agent.currentTask = label;
  agent.lastActive = now();
  p.commit();

  try {
    const provider = projectProvider(p.meta);
    if (provider === 'gpt') run.provider = 'gpt';
    // A desk whose project switched models can't resume the other model's session: it starts a new one.
    if (agent.sessionId && (provider === 'gpt') !== isGptSession(agent)) {
      agent.sessionId = agent.sessionTotalUsd = agent.sessionAt = agent.sessionKey = undefined;
      agent.sessionTokens = agent.sessionBaseTokens = undefined;
    }
    // Starts wait while the project's model can't run, queued ones too (at their turn in kickoff and deliver). What
    // gets here anyway (a huddle turn) fails plainly, with the reason.
    const problem = modelProblem(p);
    if (problem) throw new Error(problem);
    const runner = testRunner ?? (provider === 'gpt' ? codexRunner : claudeRunner);
    const out = await runner.run({ project: p, run, agent, hooks: hooksFor(p), ...input }, controller.signal);
    run.status = 'done';
    run.costUsd = charge(agent, out.sessionId, out.costUsd, out.extraCostUsd);
    run.turns = out.turns;
    run.summary = out.summary.slice(0, 500);
    reply = out.summary;
    // Autopilot's own run went fine: the failure count starts over. Any run that worked on a ticket takes it off Autopilot's skip list.
    if (run.auto && (run.reason === 'auto' || run.reason === 'plan')) noteAutoSuccess(p);
    if (input.item?.autoSkip && input.reason !== 'comment' && input.reason !== 'message') delete input.item.autoSkip;
    // Closed out, then Claude's limit stopped it: what the team starts next still waits for the limit.
    if (out.usage) {
      try {
        limitRefused(out.usage);
      } catch (e) {
        console.error(`[hq] ${p.meta.key} usage hold:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    const err = e as Error & { outcome?: { costUsd?: number; turns?: number; sessionId?: string; extraCostUsd?: number }; usage?: UsageLimit };
    run.status = 'failed';
    run.error = err.message.slice(0, 500);
    run.costUsd = charge(agent, err.outcome?.sessionId, err.outcome?.costUsd, err.outcome?.extraCostUsd);
    run.turns = err.outcome?.turns;
    stopped = cancelled.has(run.id);
    // Claude refused (usage limit, account): automatic work everywhere waits, and the team's own start waits with it.
    if (err.usage) {
      try {
        limitRefused(err.usage);
      } catch (e) {
        console.error(`[hq] ${p.meta.key} usage hold:`, e instanceof Error ? e.message : e);
      }
    }
    const hold = err.usage && run.auto ? autoGate(p) : null;
    const thread = input.thread ? findThread(p.state, input.thread.id) : undefined;
    // Not answered: the desk sees the same messages again on the next wake. A run the founder stopped stays read.
    const readThreadId = run.threadId ?? run.cursorThread;
    const readThread = readThreadId ? findThread(p.state, readThreadId) : undefined;
    if (readThread && !stopped) rewindCursor(readThread, p.state.messages, agent.id, run.cursorFrom, run.startedAt);
    const failure = `${agent.name}'s run failed: ${run.error}`;
    // A failed reply pauses the thread like a restart does, so Resume tries it again.
    if (input.reason === 'message' && thread) {
      if (hold) holdWake(p, thread, agent.id, hold, run.restarts);
      else if (stopped) note(p.state, thread, failure);
      else pauseForFailure(p.state, thread, agent.id, failure);
    } else if (input.item) {
      if (hold) holdItem(input.item, input.reason, hold, run.restarts);
      else input.item.history.push({ ts: now(), text: `Run failed: ${run.error}` });
    }
    // Autopilot's own run failed: it leaves the ticket for you, and 3 in a row stop it here. Your Stop is no strike.
    // A hand-off, chat or QA run that fails stays as it always was: a line on the ticket, a paused thread.
    if (run.auto && !hold && (run.reason === 'auto' || run.reason === 'plan')) {
      noteAutoFailure(p, run.reason === 'auto' ? input.item : undefined, stopped ? 'Stopped by you.' : `Its run failed: ${run.error}`, !stopped);
    }
    // A plan that Claude's limit stopped never planned: the lead plans again once the limit clears.
    if (input.reason === 'plan' && err.usage) replan(p);
    p.log(agent.id, `Hit a problem${input.item ? ` on ${p.ticket(input.item)} "${input.item.title}"` : ''}: ${run.error}`);
    console.error(`[hq] ${p.meta.key} run ${run.id} for ${agent.name} failed:`, err.message);
  } finally {
    controllers.delete(run.id);
    cancelled.delete(run.id);
    run.finishedAt = now();
    if (run.auto) countCost(p.state, run);
    agent.running = false;
    agent.lastActive = now();
    if (input.reason === 'message' && input.thread) {
      const thread = findThread(p.state, input.thread.id);
      if (thread && needsWake(p.state, thread, agent.id)) clearWaiting(thread, agent.id);
    }
    settleInstructions(p.state);
    refreshStatuses(p.state);
    p.commit();
    // A desk is free again: held work may start. Never let that break the run's own bookkeeping.
    try {
      autoTick(p);
    } catch (e) {
      console.error(`[hq] ${p.meta.key} autopilot:`, e instanceof Error ? e.message : e);
    }
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
  // Autopilot starts a ticket from To do; in progress only when a restart cut its run off.
  if (reason === 'auto') return status === 'todo' || status === 'in-progress' ? null : `ticket is ${status}`;
  return ['done', 'approved', 'held', 'qa', 'signoff'].includes(status) ? `ticket is ${status}` : null;
}

export interface KickoffOptions {
  /** Put the team notes in this run's prompt. */
  includeNotes?: boolean;
  /** The team started it, not you: held while HQ is paused or a limit is hit. */
  auto?: boolean;
  /** Times a restart cut this start off before. */
  restarts?: number;
  /** When this start was first held: a released start held again keeps its place and adds no history line. */
  heldAt?: string;
}

/** Queue a run for the ticket's owner, or for the QA desk when reason is 'qa'. No-op in sim mode; held while idle. Returns the Run, or null (also when held). */
export function kickoff(p: Project, itemId: string, reason: RunReason, note?: string, images: Attachment[] = [], opts: KickoffOptions = {}): Run | null {
  if (!isLive() && !isIdle()) return null;
  const s = p.state;
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return null;
  const agent = reason === 'qa' ? qaDeskOf(s) : s.agents.find((a) => a.id === item.assignee);
  if (!agent || agent.isHuman) return null;
  if (!isLive()) {
    holdYours(item, reason, note, images, Boolean(opts.includeNotes));
    p.commit();
    return null;
  }
  // The project's model can't run: your start waits like one made while idle; the team's own waits at the gate below.
  const noModel = opts.auto ? null : modelHold(p);
  if (noModel) {
    holdYours(item, reason, note, images, Boolean(opts.includeNotes), noModel);
    p.commit();
    return null;
  }
  // One waiting QA check per ticket. A running one is not reused: it may be checking an older round, and its verdict will be refused.
  if (reason === 'qa') {
    const queued = queuedQaRun(s, item.id);
    if (queued) {
      // You asked for the check yourself: the one already waiting is yours now, so a Pause never holds it.
      if (!opts.auto) {
        delete queued.auto;
        delete queued.restarts;
        delete item.autoHold;
      }
      return queued;
    }
  }
  if (opts.auto) {
    // The team's own start waits on its ticket while HQ is paused or a limit is hit. Queued ones count as started.
    const hold = autoGate(p, Date.now(), queuedAuto(p));
    if (hold) {
      holdItem(item, reason, hold, opts.restarts, opts.heldAt);
      p.commit();
      return null;
    }
  } else if (reason !== 'comment') {
    // You put someone on it: whatever was held or skipped for it is yours now.
    delete item.autoHold;
    delete item.autoSkip;
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

  const run: Run = {
    id: uid('run'),
    agentId: agent.id,
    itemId: item.id,
    reason,
    status: 'queued',
    startedAt: now(),
    ...(opts.includeNotes ? { notes: true } : {}),
    ...(opts.auto ? { auto: true as const } : {}),
    ...(opts.restarts ? { restarts: opts.restarts } : {}),
  };
  track(p, run);
  item.history.push({ ts: now(), text: `Queued for ${agent.name} (${reason})` });
  p.commit();

  // Held by a Pause, or gone, before its turn: it never takes a slot.
  const gone = () => p.state.runs.find((r) => r.id === run.id)?.status !== 'queued';
  void enqueue(
    `${p.id}:${agent.id}`,
    async () => {
      // Re-read through the project each time: a reset swaps p.state for a new object.
      const state = p.state;
      const liveRun = state.runs.find((r) => r.id === run.id);
      const liveAgent = state.agents.find((a) => a.id === agent.id);
      const liveItem = state.items.find((i) => i.id === item.id);
      // Gone, or held by a Pause while it waited.
      if (!liveRun || liveRun.status !== 'queued') return;
      if (!liveItem) return skip(p, liveRun, 'Ticket disappeared before the run started', true);
      if (reason === 'qa' && !liveAgent?.qa) {
        // The QA desk left or stopped QA before its check: pass the ticket on, to the QA desk now or to your sign-off.
        // Skipped first, so the new check is not taken for this one.
        skip(p, liveRun, liveAgent ? `${liveAgent.name} is no longer the QA desk` : 'Desk was removed before the run started', !liveAgent);
        if (rerouteQa(state, liveItem) === 'qa') kickoff(p, liveItem.id, 'qa', undefined, [], { auto: liveRun.auto });
        p.commit();
        return;
      }
      if (!liveAgent) return skip(p, liveRun, 'Desk was removed before the run started', true);
      const moot = mootRun(reason, liveItem.status);
      if (moot) return skip(p, liveRun, moot);
      // The gate again: HQ may have been paused, or a limit hit, while this waited.
      const hold = liveRun.auto ? autoGate(p) : null;
      if (hold) {
        holdItem(liveItem, reason, hold, liveRun.restarts);
        return skip(p, liveRun, `held: ${hold.text}`);
      }
      // Yours, and the project's model stopped being able to run while it waited: it waits on its ticket, not fails.
      const noModel = liveRun.auto ? null : modelHold(p);
      if (noModel) {
        holdYours(liveItem, reason, note, images, Boolean(liveRun.notes), noModel);
        return skip(p, liveRun, `held: ${noModel.text}`);
      }

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
    },
    { skip: gone, first: !opts.auto },
  );

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
    // You started the huddle: its turns wait ahead of the team's own starts for a slot.
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
    }, { first: true });
  } catch (e) {
    turn = { ran: false, ok: false, reply: '', error: (e as Error).message };
  }
  return turn;
}

export interface DeliverOptions {
  /** A desk woke a teammate, not you: held while HQ is paused or a limit is hit. */
  auto?: boolean;
  /** Times a restart cut this wake off before. */
  restarts?: number;
}

/**
 * Wake desks for a chat message. One queued run per desk per thread; that run reads every
 * unread message when it starts. No-op in sim mode, where server/sim.ts answers instead.
 */
export function deliver(p: Project, threadId: string, ids: string[], opts: DeliverOptions = {}): Run[] {
  const s = p.state;
  const t = findThread(s, threadId);
  if (!t || (!isLive() && !isIdle())) return [];
  const queued: Run[] = [];
  for (const id of ids) {
    const agent = s.agents.find((a) => a.id === id && !a.isHuman);
    if (!agent || t.status === 'closed') {
      clearWaiting(t, id);
      continue;
    }
    // Idle: your message waits like a held wake (one note per desk per thread), and the desk answers once HQ is live.
    if (!isLive()) {
      if (needsWake(s, t, id)) holdWake(p, t, id, LOGIN_HOLD, undefined, true);
      continue;
    }
    // The project's model can't run: your message waits the same way. The team's own wakes wait at the gate below.
    const noModel = opts.auto ? null : modelHold(p);
    if (noModel) {
      if (needsWake(s, t, id)) holdWake(p, t, id, noModel, undefined, true);
      continue;
    }
    if (!opts.auto) {
      // You wrote to this desk: a wake held for it here is yours now, and so is a reply already waiting, so a Pause never holds it.
      s.auto.heldWakes = s.auto.heldWakes.filter((w) => !(w.threadId === t.id && w.agentId === id));
      for (const r of s.runs) {
        if (r.status !== 'queued' || r.reason !== 'message' || r.threadId !== t.id || r.agentId !== id) continue;
        delete r.auto;
        delete r.restarts;
      }
    }
    if (!needsWake(s, t, id)) continue;
    const hold = opts.auto ? autoGate(p, Date.now(), queuedAuto(p)) : null;
    if (hold) {
      holdWake(p, t, id, hold, opts.restarts);
      continue;
    }
    const run: Run = {
      id: uid('run'),
      agentId: id,
      itemId: t.itemId,
      threadId: t.id,
      reason: 'message',
      status: 'queued',
      startedAt: now(),
      ...(opts.auto ? { auto: true as const } : {}),
      ...(opts.restarts ? { restarts: opts.restarts } : {}),
    };
    track(p, run);
    queued.push(run);

    const gone = () => p.state.runs.find((r) => r.id === run.id)?.status !== 'queued';
    void enqueue(
      `${p.id}:${id}`,
      async () => {
        const state = p.state;
        const liveRun = state.runs.find((r) => r.id === run.id);
        const liveAgent = state.agents.find((a) => a.id === id);
        const thread = findThread(state, threadId);
        // Held by a Pause while it waited: the held wake carries it.
        if (liveRun && liveRun.status !== 'queued') return;
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
        const hold = liveRun.auto ? autoGate(p) : null;
        if (hold) {
          holdWake(p, thread, id, hold, liveRun.restarts);
          return skip(p, liveRun, `held: ${hold.text}`);
        }
        // Yours, and the project's model stopped being able to run while it waited: the desk answers once it can, and
        // the thread stays open.
        const noModel = liveRun.auto ? null : modelHold(p);
        if (noModel) {
          holdWake(p, thread, id, noModel, undefined, true);
          return skip(p, liveRun, `held: ${noModel.text}`);
        }

        // Remember where the desk had read to, so a run that dies before replying can be retried.
        liveRun.cursorFrom = thread.cursor[id] ?? 0;
        markRead(thread, id);
        const item = thread.itemId ? state.items.find((i) => i.id === thread.itemId) : undefined;
        // Only the founder's images go in inline. Desk images reach teammates as file paths in the messages.
        const images = unread.all.filter((m) => m.from === 'you').flatMap((m) => m.attachments ?? []);
        await execute(p, liveRun, liveAgent, { item, reason: 'message', thread, unread: unread.all, images }, `Replying in "${thread.title}"`);
      },
      { skip: gone, first: !opts.auto },
    );
  }
  p.commit();
  return queued;
}

/** Queued runs the team started, held now: HQ was paused (or Claude refused) while they waited. Running ones finish. */
export function holdQueued(p: Project): number {
  const hold = autoGate(p);
  if (!hold) return 0;
  const s = p.state;
  let n = 0;
  for (const run of s.runs) {
    if (run.status !== 'queued' || !run.auto) continue;
    const thread = run.reason === 'message' && run.threadId ? findThread(s, run.threadId) : undefined;
    const item = run.itemId && run.reason !== 'message' ? s.items.find((i) => i.id === run.itemId) : undefined;
    if (thread) holdWake(p, thread, run.agentId, hold, run.restarts);
    else if (item) holdItem(item, run.reason, hold, run.restarts);
    else if (run.reason === 'plan') replan(p);
    run.status = 'done';
    run.summary = `Skipped: held: ${hold.text}`;
    run.finishedAt = now();
    n++;
  }
  if (n) p.commit();
  return n;
}

const oldestHold = (a: WorkItem, b: WorkItem) => a.autoHold!.at.localeCompare(b.autoHold!.at) || (a.number ?? 0) - (b.number ?? 0);

/**
 * Starts what you gave while HQ was idle, oldest first, as your own clicks: a project's daily limits don't hold them,
 * only HQ's Pause or Claude's usage or account hold, and then each says that is what it waits for. Starts that no longer
 * fit their ticket are dropped; a comment of yours a later start took the place of is answered after it.
 */
function releaseYours(p: Project): number {
  const s = p.state;
  const gate = globalHold() ?? modelHold(p);
  let n = 0;
  let touched = false;
  for (const item of s.items.filter((i) => i.autoHold?.mine).sort(oldestHold)) {
    const hold = item.autoHold!;
    if (gate) {
      touched ||= hold.why !== gate.kind;
      hold.why = gate.kind;
      continue;
    }
    touched = true;
    delete item.autoHold;
    const moot = mootRun(hold.reason, item.status);
    if (moot) {
      item.history.push({ ts: now(), text: `Dropped a held start: ${moot}` });
      continue;
    }
    if (kickoff(p, item.id, hold.reason, hold.note, hold.images ?? [], { includeNotes: hold.notes })) n++;
    if (hold.reason !== 'comment' && unansweredComment(item, item.assignee)) kickoff(p, item.id, 'comment');
  }
  for (const wake of s.auto.heldWakes.filter((w) => w.mine).sort((a, b) => a.at.localeCompare(b.at))) {
    if (gate) {
      touched ||= wake.why !== gate.kind;
      wake.why = gate.kind;
      continue;
    }
    const thread = findThread(s, wake.threadId);
    // A paused thread keeps its held wake until it is open again; a closed one drops it.
    if (thread?.status === 'paused') continue;
    touched = true;
    s.auto.heldWakes = s.auto.heldWakes.filter((w) => w !== wake);
    if (!thread || thread.status === 'closed') continue;
    if (unreadFor(s, thread, wake.agentId).addressed.length === 0) continue;
    n += deliver(p, thread.id, [wake.agentId]).length;
  }
  if (touched) p.commit();
  return n;
}

/**
 * Starts what was held here, oldest first, while the gate stays open: ticket starts (again through kickoff, so a
 * gate that closes midway holds the rest again) and chat wakes. Starts that no longer fit their ticket are dropped.
 */
export function releaseHolds(p: Project): number {
  if (!isLive()) return 0;
  const s = p.state;
  let n = releaseYours(p);
  if (autoGate(p)) return n;
  // Oldest hold first; held in the same moment, the older ticket first (items are stored newest first).
  const items = s.items.filter((i) => i.autoHold && !i.autoHold.mine).sort(oldestHold);
  for (const item of items) {
    // Counting what is already queued, so a start is only taken off hold when it can really start.
    if (autoGate(p, Date.now(), queuedAuto(p))) break;
    const hold = item.autoHold!;
    delete item.autoHold;
    if (hold.reason === 'auto') {
      // Autopilot's own start waits only while Autopilot is on, and starts only into a free slot, like any pick.
      if (!p.meta.autopilot) {
        item.history.push({ ts: now(), text: "Dropped Autopilot's held start: Autopilot is off" });
        continue;
      }
      if (p.state.auto.halted || freeSlots() === 0) {
        item.autoHold = hold;
        continue;
      }
    }
    const moot = mootRun(hold.reason, item.status);
    if (moot) {
      item.history.push({ ts: now(), text: `Dropped a held start: ${moot}` });
      continue;
    }
    // Held again after all: it keeps its place in line, with no new history line.
    if (kickoff(p, item.id, hold.reason, undefined, [], { auto: true, restarts: hold.restarts, heldAt: hold.at })) n++;
  }
  for (const wake of [...s.auto.heldWakes].sort((a, b) => a.at.localeCompare(b.at))) {
    if (wake.mine) continue;
    if (autoGate(p, Date.now(), queuedAuto(p))) break;
    const thread = findThread(s, wake.threadId);
    // A paused thread keeps its held wake until it is open again; a closed one drops it.
    if (thread?.status === 'paused') continue;
    s.auto.heldWakes = s.auto.heldWakes.filter((w) => w !== wake);
    if (!thread || thread.status === 'closed') continue;
    if (unreadFor(s, thread, wake.agentId).addressed.length === 0) continue;
    n += deliver(p, thread.id, [wake.agentId], { auto: true, restarts: wake.restarts }).length;
  }
  p.commit();
  return n;
}

/**
 * The lead plans the goal (Goal mode): a run of its own, queued like any, as the team's own work. It counts as having
 * planned once queued, so a run that fails does not plan again straight away. Live mode only.
 */
export function runPlan(p: Project, leadId: string): Run | null {
  if (!isLive()) return null;
  const g = goalState(p.state, p.meta);
  if (!g || autoGate(p, Date.now(), queuedAuto(p))) return null;
  const run: Run = { id: uid('run'), agentId: leadId, reason: 'plan', status: 'queued', startedAt: now(), auto: true };
  track(p, run);
  g.lastPlanAt = now();
  p.commit();
  const gone = () => p.state.runs.find((r) => r.id === run.id)?.status !== 'queued';
  void enqueue(
    `${p.id}:${leadId}`,
    async () => {
      const state = p.state;
      const liveRun = state.runs.find((r) => r.id === run.id);
      if (!liveRun || liveRun.status !== 'queued') return;
      const lead = state.agents.find((a) => a.id === leadId && !a.isHuman);
      if (!lead) return skip(p, liveRun, 'Desk was removed before the run started', true);
      if (!p.meta.goalMode || !p.meta.autopilot) return skip(p, liveRun, 'Goal mode was turned off');
      const hold = autoGate(p);
      if (hold) {
        replan(p);
        return skip(p, liveRun, `held: ${hold.text}`);
      }
      await execute(p, liveRun, lead, { reason: 'plan' }, 'Planning toward the goal');
    },
    { skip: gone },
  );
  return run;
}

/** A plan that was held never ran: the lead plans again as soon as it may. */
function replan(p: Project): void {
  const g = p.state.auto.goal;
  if (g) delete g.lastPlanAt;
}

/** Projects being worked through right now, so a pass started from inside another one does not run twice. */
const ticking = new Set<string>();

/** Free run slots across all projects: Autopilot only fills what is idle, so it never queues ahead of your clicks. */
function freeSlots(): number {
  let busy = 0;
  for (const q of allProjects()) busy += q.state.runs.filter((r) => r.status === 'queued' || r.status === 'running').length;
  return Math.max(0, CONCURRENCY - busy);
}

/**
 * One pass of what the team does on its own in a project: held work starts again when it may, then, with Autopilot on,
 * free desks start their oldest To do ticket while there is a free slot and the gate is open.
 */
export function autoTick(p: Project): void {
  if (ticking.has(p.id) || !isLive()) return;
  ticking.add(p.id);
  try {
    releaseHolds(p);
    // Off, or stopped itself after 3 failed runs: no picks and no planning.
    if (!p.meta.autopilot || p.state.auto.halted) return;
    // Goal mode: the lead plans first, and is kept free for it while the plan waits for a slot.
    const reserved = new Set<string>();
    if (p.meta.goalMode && planDue(p.state, p.meta)) {
      const lead = plannerOf(p.state);
      if (lead) {
        reserved.add(lead.id);
        if (freeSlots() > 0) runPlan(p, lead.id);
      }
    }
    for (const pick of pickStarts(p.state, p.meta, freeSlots(), reserved)) {
      if (autoGate(p, Date.now(), queuedAuto(p))) break;
      const item = p.state.items.find((i) => i.id === pick.itemId);
      if (!item || !kickoff(p, pick.itemId, 'auto', undefined, [], { auto: true })) continue;
      item.history.push({ ts: now(), text: 'Started by Autopilot: it was next in To do' });
      p.log(pick.agentId, `Autopilot started ${p.ticket(item)} "${item.title}"`);
    }
  } finally {
    ticking.delete(p.id);
  }
}

/** Runs fn on every project; one project's error never stops the rest. */
function eachProject(what: string, fn: (p: Project) => void): void {
  for (const p of allProjects()) {
    try {
      fn(p);
    } catch (e) {
      console.error(`[hq] ${p.meta.key} ${what}:`, e instanceof Error ? e.message : e);
    }
  }
}

/** Pause: nothing the team starts on its own runs in any project. Queued ones are held now; running ones finish. */
export function pauseAll(): void {
  setPaused(true);
  eachProject('pause', holdQueued);
}

/**
 * Resume clears the reason shown: your Pause if you paused, otherwise Claude's usage or account hold (Resume now).
 * A usage limit that is still on stays after you lift your own Pause, so held work is not sent into it.
 */
export function resumeAll(): void {
  if (settings().paused) setPaused(false);
  else setUsageHold(null);
  eachProject('resume', autoTick);
}

/** Claude or ChatGPT refused a run: hold automatic work everywhere until the limit resets (or you resume, for an account problem). */
function limitRefused(limit: UsageLimit): void {
  const first = !settings().usageHold;
  setUsageHold(usageHoldFrom(limit));
  if (first) console.warn(`[hq] A run was refused: ${limit.text} Automatic work waits${limit.kind === 'account' ? ' until you resume' : ''}.`);
  eachProject('usage hold', holdQueued);
}

/** The minute sweep, live only: a usage limit that has reset clears, and every project gets a pass. One project's error never stops the rest. */
export function autoSweep(nowMs = Date.now()): void {
  if (usageHoldExpired(nowMs)) {
    setUsageHold(null);
    console.info('[hq] Usage limit reset: held work starts again.');
  }
  for (const p of allProjects()) {
    try {
      autoTick(p);
    } catch (e) {
      console.error(`[hq] ${p.meta.key} autopilot:`, e instanceof Error ? e.message : e);
    }
  }
}

export function cancelRun(runId: string): boolean {
  const c = controllers.get(runId);
  if (!c) return false;
  cancelled.add(runId);
  c.abort();
  return true;
}
