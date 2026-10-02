import type { Agent, Run, Thread, WorkItem } from './types';

/**
 * What each desk is doing right now, for the Office view. Derived on every poll, never stored.
 *
 *   off      status is off
 *   chatting in a running huddle, or in a desk-to-desk chat that is waiting on a reply
 *            (a desk answering you also counts, with no partner: it stays at its desk)
 *   coding   mid-run, and the last tool wrote or edited a file in the project folder
 *   working  mid-run otherwise, or has work in progress or queued
 *   waiting  has something in Needs you, and is not mid-run on something else
 *   idle     none of the above
 */
export type Activity = 'coding' | 'working' | 'chatting' | 'idle' | 'waiting' | 'off';

export interface AgentActivity {
  activity: Activity;
  /** When this activity started, as far as HQ has seen. */
  since: string;
  /** Chatting: the other desks in the chat or huddle. Empty when the desk is answering you. */
  with?: string[];
  huddleId?: string;
}

/** What a live run's last tool did: wrote code in the project folder, or anything else. */
export type ToolKind = 'code' | 'other';

export interface ActivityInput {
  agents: Agent[];
  items: WorkItem[];
  runs: Run[];
  threads: Thread[];
  huddles: { id: string; status: string; participants: string[]; facilitator: string; createdAt?: string }[];
  /** Per running run id: what its last tool did. */
  lastTool: Record<string, ToolKind | undefined>;
}

type Derived = Omit<AgentActivity, 'since'>;

/** Each agent's newest running run. */
function runningRuns(runs: Run[]): Map<string, Run> {
  const out = new Map<string, Run>();
  for (const r of runs) {
    if (r.status !== 'running') continue;
    const prev = out.get(r.agentId);
    if (!prev || r.startedAt > prev.startedAt) out.set(r.agentId, r);
  }
  return out;
}

export function deriveActivities(input: ActivityInput): Record<string, Derived> {
  const desks = input.agents.filter((a) => !a.isHuman);
  const isDesk = new Set(desks.map((a) => a.id));
  const out: Record<string, Derived> = {};
  const runningOf = runningRuns(input.runs);

  // Everyone in a running huddle sits at the meeting table, not only the desk whose turn it is.
  for (const h of input.huddles) {
    if (h.status !== 'running') continue;
    // Off-shift desks sit it out, even if they were invited.
    const members = [...new Set([h.facilitator, ...h.participants])].filter((id) => isDesk.has(id) && desks.find((a) => a.id === id)!.status !== 'off');
    for (const id of members) {
      if (out[id]) continue;
      out[id] = { activity: 'chatting', with: members.filter((m) => m !== id), huddleId: h.id };
    }
  }

  // A desk-to-desk chat is a pair from the moment one desk is woken to answer another until it has.
  for (const t of input.threads) {
    if (t.status !== 'open' || t.waiting.length === 0) continue;
    const from = t.last?.from;
    for (const replier of t.waiting) {
      if (!isDesk.has(replier) || out[replier]) continue;
      const repliersRun = runningOf.get(replier);
      // Woken but still queued behind other work: it isn't talking yet.
      if (!repliersRun || repliersRun.threadId !== t.id) continue;
      const partners = partnersOf(t, replier, isDesk);
      out[replier] = { activity: 'chatting', with: partners };
      const partner = partners.length === 1 ? partners[0] : undefined;
      if (!partner || out[partner]) continue;
      const partnerAgent = desks.find((a) => a.id === partner)!;
      const partnerRun = runningOf.get(partner);
      // The partner joins the pair unless it's off or busy with something else.
      if (partnerAgent.status !== 'off' && (!partnerRun || partnerRun.threadId === t.id)) out[partner] = { activity: 'chatting', with: [replier] };
    }
  }

  for (const a of desks) {
    if (out[a.id]) continue;
    if (a.status === 'off') {
      out[a.id] = { activity: 'off' };
      continue;
    }
    const run = runningOf.get(a.id);
    if (run) {
      // A message run in a thread with only you: the desk answers from its own desk.
      if (run.reason === 'message') out[a.id] = { activity: 'chatting', with: [] };
      else out[a.id] = { activity: input.lastTool[run.id] === 'code' ? 'coding' : 'working' };
      continue;
    }
    const mine = input.items.filter((i) => i.assignee === a.id);
    if (mine.some((i) => i.status === 'needs-you')) out[a.id] = { activity: 'waiting' };
    else if (mine.some((i) => i.status === 'in-progress' || i.status === 'sent-back' || i.status === 'approved' || i.status === 'todo')) out[a.id] = { activity: 'working' };
    else out[a.id] = { activity: 'idle' };
  }
  // Off beats everything: an off-shift desk is never drawn at the table.
  for (const a of desks) if (a.status === 'off') out[a.id] = { activity: 'off' };
  return out;
}

/**
 * Who a desk answering in thread `t` is talking to. The last poster, if that's another desk. Otherwise (it posted
 * its own reply mid-run, or the last line is an HQ note) the thread's other desks. Nobody only when you posted last
 * and no other desk is in the thread: it is answering you, from its own desk.
 */
function partnersOf(t: Thread, replier: string, isDesk: Set<string>): string[] {
  const from = t.last?.from;
  if (from && from !== replier && isDesk.has(from)) return [from];
  return t.participants.filter((id) => id !== replier && isDesk.has(id));
}

/**
 * When a desk started waiting on you: its oldest Needs-you item, so a restart doesn't reset the clock.
 * Each item's needsYouAt says when it went into Needs you. Items saved before that field fall back to their
 * newest history entry, the step that put them there.
 */
export function waitingSince(items: WorkItem[], agentId: string): string | undefined {
  let oldest: string | undefined;
  for (const i of items) {
    if (i.assignee !== agentId || i.status !== 'needs-you') continue;
    const ts = i.needsYouAt ?? i.history.at(-1)?.ts;
    if (ts && (!oldest || ts < oldest)) oldest = ts;
  }
  return oldest;
}

/**
 * Keep each item's needsYouAt in step with its status: stamped `at` when it goes into Needs you, cleared when it
 * leaves. Later history (a comment run queued, an image attached, a failed run) doesn't move it. The store runs
 * this on every commit, so every path that moves a ticket is covered. `fromHistory`: for items saved before this
 * field, their newest history entry is the best guess at when they went in.
 */
export function stampNeedsYou(items: WorkItem[], at: string, fromHistory = false): void {
  for (const i of items) {
    if (i.status !== 'needs-you') delete i.needsYouAt;
    else i.needsYouAt ??= (fromHistory ? i.history.at(-1)?.ts : undefined) ?? at;
  }
}

/**
 * Keep "since" steady across polls: it changes only when the activity does.
 * `prev` is what the last call returned for this project. `startOf` gives a desk's start from the data (its run,
 * its huddle, its last activity) for the first time HQ sees it, so a restart doesn't reset every clock to now.
 */
export function withSince(
  derived: Record<string, Derived>,
  prev: Record<string, AgentActivity> | undefined,
  now: string,
  items: WorkItem[],
  startOf?: (id: string, d: Derived) => string | undefined,
): Record<string, AgentActivity> {
  const out: Record<string, AgentActivity> = {};
  for (const [id, d] of Object.entries(derived)) {
    const before = prev?.[id];
    const same = before && before.activity === d.activity && before.huddleId === d.huddleId && (before.with ?? []).join() === (d.with ?? []).join();
    let since: string;
    if (d.activity === 'waiting') since = waitingSince(items, id) ?? (same ? before.since : now);
    else if (same) since = before.since;
    else if (!before) since = sooner(startOf?.(id, d), now);
    else since = now;
    out[id] = { ...d, since };
  }
  return out;
}

/**
 * When a desk's state began, from the data, for withSince's first sight of it: its run's start (or, for the half
 * of a pair without a run, its partner's); the huddle's start; otherwise when the desk was last active. Off shift
 * shows no time, so it has none.
 */
export function startsFrom(input: Pick<ActivityInput, 'agents' | 'runs' | 'huddles'>): (id: string, d: Derived) => string | undefined {
  const running = runningRuns(input.runs);
  return (id, d) => {
    if (d.activity === 'off') return undefined;
    if (d.huddleId) return input.huddles.find((h) => h.id === d.huddleId)?.createdAt;
    if (d.activity !== 'idle') {
      const run = running.get(id) ?? (d.activity === 'chatting' && d.with?.length === 1 ? running.get(d.with[0]) : undefined);
      if (run) return run.startedAt;
    }
    return input.agents.find((a) => a.id === id)?.lastActive;
  };
}

/** A start from the data, if it's a real time no later than now. */
function sooner(ts: string | undefined, now: string): string {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) && t <= Date.parse(now) ? ts! : now;
}
