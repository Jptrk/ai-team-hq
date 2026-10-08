import type { Huddle } from '../shared/types';
import {
  advance,
  canStartToday,
  createHuddle,
  findHuddle,
  huddleLabel,
  recordContribution,
  recordFallback,
  recordFallbackSummary,
  recordSummary,
  reopenHuddle,
  stopHuddle,
  summarizedThisRound,
  validateHuddle,
  type ContributionArgs,
  type SummaryArgs,
} from './huddle-core';
import { cancelRun, isIdle, isLive, runHuddleDesk, type HuddleTurn } from './runner';
import { now, uid, type Project } from './store';

/**
 * Runs huddles: each round every desk adds its turn (in parallel, through the normal desk queue),
 * then the facilitator sums up. The last summary carries proposals that wait for the founder.
 * Sim mode answers with canned turns and makes no Claude calls.
 */

type Role = 'participant' | 'facilitator';
export type TurnFn = (p: Project, huddleId: string, agentId: string, role: Role) => Promise<HuddleTurn>;

/** Huddles with a drive loop going, so a resume never starts a second one. */
const driving = new Set<string>();
/** How often each huddle was stopped, so a sim turn knows a stop came in while it was thinking. */
const stops = new Map<string, number>();

const nameOf = (p: Project, id: string) => p.state.agents.find((a) => a.id === id)?.name ?? id;

/** Idle (no Claude login, and no sim): desks can't take a turn, and canned ones would land in a real project. */
const NO_LOGIN = "HQ has no Claude login, so desks can't huddle. On HQ's Claude account page, sign in and turn on Run desks on my Claude login, then restart HQ.";

/** Start the drive loop. A throw in it must not take the server down: log it and stop the huddle as failed. */
function launch(p: Project, id: string, turn: TurnFn): void {
  drive(p, id, turn).catch((e: unknown) => {
    console.error(`[hq] ${p.meta.key} huddle ${id} hit an error:`, e);
    try {
      const h = findHuddle(p.state, id);
      if (h && h.status === 'running') fail(p, h, `HQ hit an error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    } catch (again) {
      console.error(`[hq] ${p.meta.key} could not stop huddle ${id}:`, again);
    }
  });
}

/** Start a huddle and its first round. The new huddle, or why it cannot start (with an HTTP status). */
export function startHuddle(p: Project, raw: unknown, turn: TurnFn = deskTurn): Huddle | { error: string; status: number } {
  const s = p.state;
  const checked = validateHuddle(s, raw);
  if (typeof checked === 'string') return { error: checked, status: 400 };
  const busy = s.huddles.find((h) => h.status === 'running');
  if (busy) return { error: `${huddleLabel(busy)} is still going. Wait for it or stop it first.`, status: 409 };
  const capped = canStartToday(s);
  if (capped) return { error: capped, status: 429 };
  if (turn === deskTurn && isIdle()) return { error: NO_LOGIN, status: 409 };
  const h = createHuddle(s, checked.input, checked.facilitator);
  p.log('you', `Started ${huddleLabel(h)} "${h.topic.slice(0, 80)}" with ${h.participants.map((id) => nameOf(p, id)).join(', ')}`);
  p.commit();
  launch(p, h.id, turn);
  return h;
}

/** Stop a running huddle. Desks mid-turn are cancelled; queued turns are skipped when they come up. */
export function stopHuddleRun(p: Project, id: string): string | null {
  const h = findHuddle(p.state, id);
  if (!h) return 'huddle not found';
  if (h.status !== 'running') return 'This huddle is not running.';
  stopHuddle(h, 'you');
  const key = `${p.id}:${id}`;
  stops.set(key, (stops.get(key) ?? 0) + 1);
  for (const r of p.state.runs) if (r.huddleId === id && r.status === 'running') cancelRun(r.id);
  p.log('you', `Stopped ${huddleLabel(h)}`);
  p.commit();
  return null;
}

/** Pick a stopped huddle back up, from the turns it still owes. */
export function resumeHuddleRun(p: Project, id: string, turn: TurnFn = deskTurn): string | null {
  const s = p.state;
  const h = findHuddle(s, id);
  if (!h) return 'huddle not found';
  const busy = s.huddles.find((x) => x.status === 'running' && x.id !== id);
  if (busy) return `${huddleLabel(busy)} is still going. Wait for it or stop it first.`;
  if (turn === deskTurn && isIdle()) return NO_LOGIN;
  const why = reopenHuddle(s, h);
  if (why) return why;
  p.log('you', `Resumed ${huddleLabel(h)}`);
  p.commit();
  launch(p, id, turn);
  return null;
}

/** Wait for the drive loop to let go of a huddle. For tests. */
export function isDriving(p: Project, id: string): boolean {
  return driving.has(`${p.id}:${id}`);
}

/** Run rounds until the huddle is done, stopped or out of desks that answer. Safe to call twice: the second call returns at once. */
export async function drive(p: Project, id: string, turn: TurnFn = deskTurn): Promise<void> {
  const key = `${p.id}:${id}`;
  if (driving.has(key)) return;
  driving.add(key);
  try {
    for (;;) {
      // Re-read every step: a reset swaps p.state for a new object.
      const h = findHuddle(p.state, id);
      if (!h || h.status !== 'running') return;

      if (h.phase === 'contribute') {
        const round = h.round;
        await Promise.all(
          [...h.waiting].map(async (agentId) => {
            const out = await turn(p, id, agentId, 'participant');
            const live = findHuddle(p.state, id);
            if (!live) return;
            if (out.ran) live.usedRuns += 1;
            // Stopped before or during its turn: it keeps its place for Resume.
            if (out.skipped) return p.commit();
            // A turn without the tool still counts: its reply goes on the transcript, or a note that it failed.
            if (live.status === 'running' && live.round === round) recordFallback(live, agentId, out.reply, !out.ok);
            p.commit();
          }),
        );
        const live = findHuddle(p.state, id);
        if (!live || live.status !== 'running') return;
        // Skipped turns from a stop and a quick resume: run them now.
        if (live.waiting.length) continue;
        if (!live.entries.some((e) => e.round === live.round && e.kind === 'contribution')) {
          fail(p, live, 'No desk managed to add anything this round');
          return;
        }
        live.phase = 'summarize';
        live.updatedAt = now();
        p.commit();
        continue;
      }

      if (h.phase === 'summarize') {
        // The summary landed before a stop or restart cut the run short: no need to sum up again.
        if (summarizedThisRound(h)) {
          wrapRound(p, h);
          continue;
        }
        const out = await turn(p, id, h.facilitator, 'facilitator');
        const live = findHuddle(p.state, id);
        if (!live) return;
        if (out.ran) live.usedRuns += 1;
        if (live.status !== 'running') return p.commit();
        // Stopped mid-turn and resumed before it ended: sum up again.
        if (out.skipped && !summarizedThisRound(live)) {
          p.commit();
          continue;
        }
        if (!summarizedThisRound(live) && !(out.ok && recordFallbackSummary(live, out.reply))) {
          fail(p, live, `${nameOf(p, live.facilitator)} could not sum up the round${out.error ? `: ${out.error}` : ''}`);
          return;
        }
        wrapRound(p, live);
        continue;
      }
      return;
    }
  } finally {
    driving.delete(key);
  }
}

/** The round is summed up: on to the next one, or done. */
function wrapRound(p: Project, h: Huddle): void {
  const last = h.round >= h.rounds;
  advance(h);
  if (last) {
    const waiting = h.proposals.filter((x) => x.status === 'pending').length;
    p.log(h.facilitator, `Wrapped up ${huddleLabel(h)}${waiting ? `: ${waiting} proposal${waiting === 1 ? '' : 's'} waiting for you` : ''}`);
  }
  p.commit();
}

function fail(p: Project, h: Huddle, why: string): void {
  stopHuddle(h, 'failed');
  h.entries.push({ id: uid('hen'), round: h.round, from: 'hq', kind: 'note', text: `${why}. Resume to try again.`, ts: now() });
  p.log(h.facilitator, `${huddleLabel(h)} stopped: ${why}`);
  p.commit();
}

/** The real turn in live mode, a canned one in sim mode. */
const deskTurn: TurnFn = (p, huddleId, agentId, role) => {
  if (!isLive()) return simTurn(p, huddleId, agentId, role);
  const h = findHuddle(p.state, huddleId);
  const label = h ? `${huddleLabel(h)}: ${role === 'facilitator' ? 'summing up' : 'adding thoughts'}` : 'Huddle';
  return runHuddleDesk(p, huddleId, agentId, role, label, Boolean(h?.includeNotes));
};

// ---------- sim ----------

const SIM_DELAY_MS = Number(process.env.HQ_SIM_HUDDLE_MS ?? 900);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A canned turn: a short wait, then a plausible contribution or summary built from the board.
 * Like a live run, a stop during the wait cancels it, even when the huddle was resumed meanwhile.
 */
export async function simTurn(p: Project, huddleId: string, agentId: string, role: Role): Promise<HuddleTurn> {
  const key = `${p.id}:${huddleId}`;
  const stopsBefore = stops.get(key) ?? 0;
  await sleep(SIM_DELAY_MS * (0.6 + Math.random() * 0.8));
  const h = findHuddle(p.state, huddleId);
  if (!h || h.status !== 'running' || (stops.get(key) ?? 0) !== stopsBefore) return { ran: false, ok: false, skipped: true, reply: '' };
  const agent = p.state.agents.find((a) => a.id === agentId && !a.isHuman);
  if (!agent) return { ran: false, ok: false, reply: '', error: 'Desk was removed' };
  const why = role === 'facilitator' ? recordSummary(p.state, h, agentId, simSummary(p, h)) : recordContribution(p.state, h, agentId, simContribution(p, h, agentId));
  p.commit();
  return why ? { ran: true, ok: false, reply: '', error: why } : { ran: true, ok: true, reply: '' };
}

function pickOf<T>(list: T[], seed: number): T {
  return list[Math.abs(seed) % list.length];
}

function simContribution(p: Project, h: Huddle, agentId: string): ContributionArgs {
  const agent = p.state.agents.find((a) => a.id === agentId)!;
  const seed = h.participants.indexOf(agentId) + h.round * 3;
  const ticket = p.state.items[Math.abs(seed) % Math.max(1, p.state.items.length)];
  const ref = ticket ? `${p.ticket(ticket)}` : 'the last ticket';
  const role = agent.role.toLowerCase();
  if (h.kind === 'retro') {
    return {
      went_well: [pickOf([`Hand-off on ${ref} was quick and clear`, `Briefs from you were specific, so ${role} work started fast`, `Screenshots in comments saved a round of back and forth`], seed)],
      didnt: [pickOf([`${ref} waited a day on a question nobody owned`, 'Two desks redid the same research', 'Long threads hid the actual decision'], seed + 1)],
      try: [pickOf(['Name an owner for every open question', 'Put decisions in the first line of a comment', 'Check the team notes before starting'], seed + 2)],
      note: h.round > 1 ? `Agree with the summary. From the ${role} side, the owner gap is the big one.` : undefined,
    };
  }
  if (h.kind === 'brainstorm') {
    return {
      ideas: [
        { title: pickOf(['Weekly highlight reel', 'One-page client portal', 'Template library', 'Office-hours slot'], seed), why: `Fits what ${role} already does well` },
        { title: pickOf(['Short how-to clips', 'Referral perk', 'Status page', 'Monthly digest email'], seed + 1), why: 'Cheap to try and easy to measure' },
      ],
      note: h.round > 1 ? 'Building on the shortlist rather than adding new ones.' : undefined,
    };
  }
  return {
    tasks: [
      { title: pickOf(['Draft the outline', 'List open questions', 'Audit what exists today', 'Write acceptance checks'], seed), owner: agent.name, detail: `Done when it is in reports/ and ${agent.name} posted the link` },
      { title: pickOf(['Set up the review pass', 'Collect examples', 'Estimate the effort', 'Line up the hand-offs'], seed + 1), owner: agent.name },
    ],
  };
}

function simSummary(p: Project, h: Huddle): SummaryArgs {
  const inRound = h.cards.filter((c) => c.round === h.round);
  const top = inRound.slice(0, 3).map((c) => `- ${c.title} (${nameOf(p, c.by)})`);
  const summary = [`**Round ${h.round}:** ${inRound.length} items from ${h.participants.length} desks.`, ...top].join('\n');
  if (h.round < h.rounds) return { summary };
  const actions = inRound.filter((c) => c.lane === 'try' || c.lane === 'task' || c.lane === 'idea').slice(0, 2);
  return {
    summary,
    tickets: actions.map((c) => ({ title: c.title.slice(0, 120), owner: nameOf(p, c.owner ?? c.by), brief: `From ${huddleLabel(h)}. ${c.detail ?? 'Agreed in the huddle.'}` })),
    notes: h.kind === 'retro' ? [inRound.find((c) => c.lane === 'try')?.title ?? 'Name an owner for every open question'] : [],
    ...(h.kind === 'brainstorm' && inRound[0] ? { pick: { title: inRound[0].title, reason: 'Most desks built on it and it is the cheapest to try.' } } : {}),
  };
}
