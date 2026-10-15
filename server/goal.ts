import { createHash } from 'node:crypto';
import type { Agent, Epic, GoalState, GoalStatus, ProjectMeta, State, WorkItem } from '../shared/types';
import { MAX_BLOCKERS, openBlockers } from '../shared/types';
import { createEpic, epicByRef, epicInputProblem, epicTwin, setBlockers, setEpic, ticketByRef } from './epics';
import { now, today, uid, type Project } from './store';

/**
 * Goal mode: the lead turns the project goal into tickets, straight into To do, for Autopilot to work through.
 *
 * The lead plans in a planning run of its own (read-only, a fresh session each time). It plans when the goal is new,
 * when the team has run out of goal work, and every few hours besides. It says when the goal is reached or blocked;
 * that comes to you in Needs you, and planning waits for you. Caps keep it from flooding the board.
 */

/** New tickets one planning run may make. */
export const GOAL_PER_PLAN = 5;
/** Goal tickets open at once; at the cap the lead does not plan. */
export const GOAL_OPEN_CAP = 8;
/** Out of goal work: the lead plans again, but not more often than this. */
const RESTOCK_MS = 20 * 60_000;
/** With work still open, the lead looks again this often, for anything missing. */
const REVIEW_MS = 6 * 60 * 60_000;
/** Ticket statuses the team can still act on. */
const ACTIONABLE = new Set(['todo', 'in-progress', 'sent-back', 'approved', 'qa']);

export function goalRev(goal: string): string {
  return createHash('sha256').update(goal.trim()).digest('hex').slice(0, 12);
}

/** Where the current goal stands. A new goal (its text changed) starts over. Undefined: no goal text. */
export function goalState(s: State, meta: Pick<ProjectMeta, 'goal'>): GoalState | undefined {
  const goal = meta.goal?.trim();
  if (!goal) return undefined;
  const rev = goalRev(goal);
  if (s.auto.goal?.rev !== rev) s.auto.goal = { rev, status: 'on-track', emptyPlans: 0 };
  return s.auto.goal;
}

const isOpenGoalTicket = (i: WorkItem) => i.origin === 'goal' && i.status !== 'done';

/** Goal tickets not done yet. */
export function openGoalTickets(s: State): WorkItem[] {
  return s.items.filter(isOpenGoalTicket);
}

/** A To do ticket that can't start yet: tickets it is blocked by are not done. */
const isBlocked = (s: State, i: WorkItem) => i.status === 'todo' && openBlockers(i, s.items).length > 0;

/** Waiting on you: a decision, your sign-off, on hold, or left for you by Autopilot. */
const onYou = (i: WorkItem) => i.status === 'needs-you' || i.status === 'signoff' || i.status === 'held' || Boolean(i.autoSkip);

/**
 * The ticket gets done without a new plan: it waits on you, or a desk on shift can work it (and, in To do, its own
 * blockers get done too). One owned by nobody who can work it, or behind such a one, never moves.
 */
function moves(s: State, i: WorkItem, seen = new Set<string>()): boolean {
  if (onYou(i)) return true;
  if (!ACTIONABLE.has(i.status) || seen.has(i.id)) return false;
  if (!s.agents.some((a) => a.id === i.assignee && !a.isHuman && a.status !== 'off')) return false;
  seen.add(i.id);
  return i.status !== 'todo' || openBlockers(i, s.items).every((b) => moves(s, b, seen));
}

/** A blocked To do ticket whose blockers get done: work that comes later, not work that is stuck. */
const waitsOnBlockers = (s: State, i: WorkItem) => isBlocked(s, i) && openBlockers(i, s.items).every((b) => moves(s, b));

/** Goal tickets the team can still act on: not waiting on you or on their blockers, owned by a desk that is not off shift. */
function actionableGoalTickets(s: State): WorkItem[] {
  return openGoalTickets(s).filter(
    (i) => ACTIONABLE.has(i.status) && !i.autoSkip && !isBlocked(s, i) && s.agents.some((a) => a.id === i.assignee && !a.isHuman && a.status !== 'off'),
  );
}

/**
 * Goal tickets waiting on you (a decision, your sign-off, on hold, or left for you by Autopilot), or on blockers that
 * get done: planned work that comes later, so the lead does not plan around it. One behind a blocker nobody can work
 * counts as neither, so the lead plans again (and two plans that add nothing come to you as stalled).
 */
function waitingGoalTickets(s: State): WorkItem[] {
  return openGoalTickets(s).filter((i) => onYou(i) || waitsOnBlockers(s, i));
}

/** The desk that plans: the lead, when there is one on shift. */
export function plannerOf(s: State): Agent | undefined {
  const lead = s.agents.find((a) => a.lead && !a.isHuman);
  return lead && lead.status !== 'off' ? lead : undefined;
}

/**
 * Whether the lead should plan now. Never while it is busy or a plan is already queued, while the goal waits on you
 * (reached, or blocked/stalled until you deal with its ticket), or with the open cap reached. Then: a new goal, the
 * team out of goal work (at most every 20 minutes), or 6 hours since the last plan. Exported for tests.
 */
export function planDue(s: State, meta: Pick<ProjectMeta, 'goalMode' | 'autopilot' | 'goal'>, nowMs = Date.now()): boolean {
  if (!meta.goalMode || !meta.autopilot) return false;
  const g = goalState(s, meta);
  const lead = plannerOf(s);
  if (!g || !lead) return false;
  if (s.runs.some((r) => (r.status === 'queued' || r.status === 'running') && (r.agentId === lead.id || r.reason === 'plan'))) return false;
  // A huddle you started goes first: the lead is in it.
  if (s.huddles.some((h) => h.status === 'running' && (h.facilitator === lead.id || h.participants.includes(lead.id)))) return false;
  if (g.status !== 'on-track') {
    const ticket = s.items.find((i) => i.id === g.statusItemId);
    // Still waiting on you. Marked done after "reached": the goal is met, so planning waits for a new goal.
    // Dealt with any other way (sent back, an instruction): the lead plans again.
    if (ticket && (ticket.status === 'needs-you' || ticket.status === 'held')) return false;
    if (g.status === 'reached' && (!ticket || ticket.status === 'done')) return false;
    g.status = 'on-track';
    g.emptyPlans = 0;
    delete g.statusItemId;
  }
  if (openGoalTickets(s).length >= GOAL_OPEN_CAP) return false;
  if (!g.lastPlanAt) return true;
  const since = nowMs - Date.parse(g.lastPlanAt);
  const actionable = actionableGoalTickets(s).length;
  // Nothing for the team to do, but goal work waits on you: the lead waits with it, instead of planning around you.
  if (actionable === 0 && waitingGoalTickets(s).length > 0) return false;
  if (actionable === 0 && since >= RESTOCK_MS) return true;
  return since >= REVIEW_MS;
}

/** A title as compared for duplicates: case, spacing and punctuation do not count. */
const titleKey = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** New epics one planning run may make. */
export const GOAL_EPICS_PER_PLAN = 2;

export interface GoalTicketArgs {
  to: string;
  title: string;
  brief: string;
  /** An epic's key (GA-14) or title to file it under. */
  epic?: string;
  /** Keys of tickets that must be done before it starts (GA-12), tickets planned earlier in the same run included. */
  blocked_by?: string[];
}

/**
 * One ticket the lead plans for the goal: straight into To do for a desk (the lead itself included), tagged Goal.
 * made: tickets this planning run made so far. A string is why it was refused, in words for the lead. Exported for tests.
 */
export function createGoalTicket(p: Project, leadId: string, args: GoalTicketArgs, made: number): WorkItem | string {
  const s = p.state;
  if (made >= GOAL_PER_PLAN) return `You already planned ${GOAL_PER_PLAN} tickets this time. Stop here and call goal_status.`;
  const open = openGoalTickets(s);
  if (open.length >= GOAL_OPEN_CAP) return `${GOAL_OPEN_CAP} goal tickets are open already. Stop here and call goal_status; plan more once some are done.`;
  const name = args.to.trim().replace(/^@/, '').toLowerCase();
  const owner = s.agents.find((a) => a.isHuman);
  if (['founder', 'you', owner?.name.toLowerCase(), owner?.id].includes(name)) {
    return `Goal tickets go to desks. For something only ${owner?.name ?? 'the founder'} can do, call goal_status with blocked.`;
  }
  const desk = ['me', 'myself'].includes(name) ? s.agents.find((a) => a.id === leadId) : s.agents.find((a) => !a.isHuman && (a.name.toLowerCase() === name || a.id === name));
  if (!desk) return `No desk called "${args.to}". Desks: ${s.agents.filter((a) => !a.isHuman).map((a) => a.name).join(', ')}.`;
  if (desk.status === 'off') return `${desk.name} is off shift. Pick a desk that is working.`;
  const key = titleKey(args.title);
  const twin = open.find((i) => titleKey(i.title) === key);
  if (twin) return `${p.ticket(twin)} "${twin.title}" is already open for that. Plan something else, or stop.`;
  // The epic and the blockers are checked before anything is made, so a bad one makes no ticket.
  const epic = args.epic?.trim() ? epicByRef(p, args.epic) : undefined;
  if (args.epic?.trim() && !epic) {
    const known = s.epics.slice(0, 10).map((e) => `${p.ticket(e)} "${e.title}"`);
    return `No epic "${args.epic}". ${known.length ? `Epics: ${known.join(', ')}.` : 'There are none yet.'} Make one with create_epic first, or leave epic out.`;
  }
  const blockers: WorkItem[] = [];
  for (const ref of args.blocked_by ?? []) {
    if (!ref.trim()) continue;
    const b = ticketByRef(p, ref);
    if (!b) return `No ticket "${ref}" to be blocked by. Use a ticket key from the board, like ${p.meta.key}-12.`;
    if (!blockers.includes(b)) blockers.push(b);
  }
  if (blockers.length > MAX_BLOCKERS) return `A ticket can be blocked by at most ${MAX_BLOCKERS} tickets.`;
  const lead = s.agents.find((a) => a.id === leadId);
  const item: WorkItem = {
    id: uid('wi'),
    number: p.nextNumber(),
    kind: 'fyi',
    status: 'todo',
    title: args.title.trim().slice(0, 120),
    summary: args.brief.trim(),
    client: 'Goal',
    from: leadId,
    assignee: desk.id,
    dated: today(),
    links: [],
    history: [{ ts: now(), text: `Planned by ${lead?.name ?? 'the lead'} for the goal` }],
    origin: 'goal',
  };
  s.items.unshift(item);
  const by = lead?.name ?? 'the lead';
  if (epic) setEpic(p, item, epic, by);
  // A new ticket blocks nothing yet, so its blockers can't make a loop.
  if (blockers.length) setBlockers(p, item, blockers.map((b) => b.id), by);
  p.log(leadId, `Planned ${p.ticket(item)} "${item.title}" for ${desk.name}${desk.id === leadId ? ' (own desk)' : ''}`);
  return item;
}

/**
 * An epic the lead makes while planning, to group the goal tickets it plans. made: epics this planning run made so
 * far. An epic of the same title is not made twice: its key comes back instead. A string is why it was refused, in
 * words for the lead. Exported for tests.
 */
export function createGoalEpic(p: Project, leadId: string, args: { title: string; brief?: string }, made: number): { epic: Epic; existed: boolean } | string {
  const twin = epicTwin(p.state, args.title);
  if (twin) return { epic: twin, existed: true };
  if (made >= GOAL_EPICS_PER_PLAN) return `You already made ${GOAL_EPICS_PER_PLAN} epics this time. File tickets under one of them.`;
  const problem = epicInputProblem({ title: args.title, summary: args.brief ?? '' }, true);
  if (problem) return problem;
  return { epic: createEpic(p, leadId, { title: args.title, summary: args.brief }), existed: false };
}

const STATUS_TITLE: Record<Exclude<GoalStatus, 'on-track'>, string> = {
  reached: 'Goal reached?',
  blocked: 'Goal blocked',
  stalled: 'Goal planning stalled',
};

/**
 * The lead's word on the goal. reached or blocked (or stalled, from HQ) opens a ticket in Needs you, where Approve
 * marks it done; planning waits until you deal with it, and after reached until you change the goal.
 */
export function recordGoalStatus(p: Project, leadId: string, status: GoalStatus, note: string): void {
  const s = p.state;
  const g = goalState(s, p.meta);
  if (!g) return;
  g.status = status;
  g.note = note.trim().slice(0, 600) || undefined;
  if (status === 'on-track') return;
  const goal = (p.meta.goal ?? '').replace(/\s+/g, ' ').trim();
  const item: WorkItem = {
    id: uid('wi'),
    number: p.nextNumber(),
    kind: 'review',
    status: 'needs-you',
    title: `${STATUS_TITLE[status]} ${goal.length > 70 ? `${goal.slice(0, 69)}…` : goal}`,
    summary: g.note ?? '',
    client: 'Goal',
    from: leadId,
    assignee: leadId,
    dated: today(),
    links: [],
    history: [{ ts: now(), text: status === 'stalled' ? 'Two plans in a row made nothing while the team had nothing to do' : `${s.agents.find((a) => a.id === leadId)?.name ?? 'The lead'} said the goal is ${status}` }],
    // Approve marks it done: nothing is left for a desk to do. No Goal tag: it is about the goal, not work toward it.
    qa: { fails: 0, ready: true },
  };
  s.items.unshift(item);
  g.statusItemId = item.id;
  p.log(leadId, `${STATUS_TITLE[status]} ${p.ticket(item)} waits for you`);
}

/**
 * A planning run ended. made: tickets it planned. Two plans in a row that made nothing while the team had nothing to
 * do (saying "on track" is not progress; reached or blocked already came to you): planning stalled, and you are told.
 */
export function finishPlan(p: Project, leadId: string, made: number): void {
  const g = goalState(p.state, p.meta);
  if (!g) return;
  if (made > 0 || g.status !== 'on-track' || actionableGoalTickets(p.state).length > 0) {
    g.emptyPlans = 0;
    return;
  }
  g.emptyPlans += 1;
  if (g.emptyPlans >= 2 && g.status === 'on-track') recordGoalStatus(p, leadId, 'stalled', 'The lead planned twice without adding work, and the team has nothing left to do for the goal. Change the goal, or tell the lead what to do next.');
}

/** For the board's goal strip. */
export function goalStatusOf(p: Project): { status: GoalStatus; planning: boolean; note?: string; lastPlanAt?: string; open: number; cap: number } | undefined {
  if (!p.meta.goalMode) return undefined;
  const g = goalState(p.state, p.meta);
  if (!g) return undefined;
  return {
    status: g.status,
    planning: p.state.runs.some((r) => r.reason === 'plan' && (r.status === 'queued' || r.status === 'running')),
    ...(g.note ? { note: g.note } : {}),
    ...(g.lastPlanAt ? { lastPlanAt: g.lastPlanAt } : {}),
    open: openGoalTickets(p.state).length,
    cap: GOAL_OPEN_CAP,
  };
}
