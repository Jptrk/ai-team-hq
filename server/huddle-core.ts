import { estimateHuddleRuns, HUDDLE_KIND_LABEL, MAX_HUDDLE_DESKS, MAX_HUDDLE_ROUNDS, MAX_HUDDLE_TOPIC, MAX_TEAM_NOTES, MIN_HUDDLE_DESKS } from '../shared/huddle';
import type { Agent, Huddle, HuddleCard, HuddleKind, HuddleLane, HuddleProposal, HuddleSummary, State, WorkItem } from '../shared/types';
import { leadOf } from './agents';
import { now, today, uid, type Project } from './store';

/**
 * Huddles, as pure state: start one, record what desks add, sum up rounds, and turn proposals into
 * tickets or team notes when the founder approves them. No runner here; server/huddles.ts drives rounds.
 */

/** Huddles a project can start per day. 0 turns them off; a value that is not a number means the default 5. */
export function huddlesPerDay(raw: string | undefined): number {
  const n = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 5;
}

export const HUDDLES_PER_DAY = huddlesPerDay(process.env.HQ_HUDDLES_PER_DAY);
export const MAX_NOTES = MAX_TEAM_NOTES;
const MAX_KEPT = 30;
/** Past this, the oldest go even with proposals still waiting, so the 3-second poll stays small. */
const HARD_KEPT = 50;
// 5 + 5 + 5 for a retro, the most any huddle tool takes in one call.
const MAX_CARDS_PER_TURN = 15;
/** Longest text kept from a turn that skipped its tool. */
const MAX_FALLBACK = 1500;
const MAX_FALLBACK_SUMMARY = 3000;
/** Longest team note a huddle can propose. */
const MAX_NOTE_LINE = 300;
const KINDS: HuddleKind[] = ['retro', 'brainstorm', 'planning'];

/** Text cut to at most max characters, with "…" when it was cut. */
export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * A team note as one plain line. Notes go into later system prompts, so a desk must not be able to
 * add headings, quotes or sections through one: newlines become spaces and leading markers go.
 */
export function noteLine(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  // "#", ">" and list markers like "-", "*", "1." at the start, stacked or not.
  const marker = /^(?:#+|>+|[-*+](?=\s)|\d{1,3}[.)](?=\s))\s*/;
  while (marker.test(t)) t = t.replace(marker, '');
  return capText(t, MAX_NOTE_LINE);
}

export interface HuddleInput {
  kind: HuddleKind;
  topic: string;
  participants: string[];
  rounds: number;
  includeNotes: boolean;
}

export const huddleLabel = (h: Pick<Huddle, 'kind' | 'number'>) => `${HUDDLE_KIND_LABEL[h.kind]} #${h.number}`;

/** A desk by id or name, as a desk might write it ("Leo", "@leo"). */
export function deskByName(s: State, name: string | undefined): Agent | undefined {
  const key = (name ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!key) return undefined;
  return s.agents.find((a) => !a.isHuman && (a.id.toLowerCase() === key || a.name.toLowerCase() === key));
}

/** Check a request to start a huddle. The input, ready to use, or a reason it cannot start. */
export function validateHuddle(s: State, raw: unknown): { input: HuddleInput; facilitator: string } | string {
  const body = (raw ?? {}) as Record<string, unknown>;
  const kind = body.kind as HuddleKind;
  if (!KINDS.includes(kind)) return 'Pick a kind: retro, brainstorm or planning.';
  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  if (topic.length < 3 || topic.length > MAX_HUDDLE_TOPIC) return `The topic must be 3-${MAX_HUDDLE_TOPIC} characters.`;
  if (!Array.isArray(body.participants) || !body.participants.every((x) => typeof x === 'string')) return 'participants must be a list of desk ids.';
  const participants = [...new Set(body.participants as string[])];
  for (const id of participants) {
    const a = s.agents.find((x) => x.id === id);
    if (!a || a.isHuman) return `${id} is not a desk on this project.`;
    if (a.status === 'off') return `${a.name} is off shift.`;
  }
  if (participants.length < MIN_HUDDLE_DESKS || participants.length > MAX_HUDDLE_DESKS) return `Pick ${MIN_HUDDLE_DESKS}-${MAX_HUDDLE_DESKS} desks.`;
  const rounds = Number(body.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_HUDDLE_ROUNDS) return `Rounds must be 1-${MAX_HUDDLE_ROUNDS}.`;
  const includeNotes = body.includeNotes === true;
  // The lead sums up when it is in the huddle. Otherwise the first desk picked does.
  const lead = leadOf(s.agents);
  const facilitator = lead && participants.includes(lead.id) ? lead.id : participants[0];
  return { input: { kind, topic, participants, rounds, includeNotes }, facilitator };
}

/** Null when another huddle can start today, or why not. */
export function canStartToday(s: State, day = today(), cap = HUDDLES_PER_DAY): string | null {
  if (s.huddleDay.day !== day) s.huddleDay = { day, started: 0 };
  if (cap <= 0) return 'Huddles are turned off (HQ_HUDDLES_PER_DAY=0).';
  return s.huddleDay.started >= cap ? `This project already ran ${cap} huddles today. That is the daily limit (HQ_HUDDLES_PER_DAY).` : null;
}

/** Drop the oldest huddles past `keep`, only those `ok` lets go. Never one that is running. */
function dropOldest(s: State, keep: number, ok: (h: Huddle) => boolean): void {
  while (s.huddles.length > keep) {
    const old = [...s.huddles].reverse().findIndex((x) => x.status !== 'running' && ok(x));
    if (old === -1) break;
    s.huddles.splice(s.huddles.length - 1 - old, 1);
  }
}

export function createHuddle(s: State, input: HuddleInput, facilitator: string): Huddle {
  const ts = now();
  s.huddleSeq = (s.huddleSeq ?? 0) + 1;
  s.huddleDay.started += 1;
  const h: Huddle = {
    id: uid('hud'),
    number: s.huddleSeq,
    kind: input.kind,
    topic: input.topic,
    status: 'running',
    facilitator,
    participants: input.participants,
    rounds: input.rounds,
    round: 1,
    phase: 'contribute',
    waiting: [...input.participants],
    includeNotes: input.includeNotes,
    estimate: estimateHuddleRuns(input.participants.length, input.rounds),
    usedRuns: 0,
    entries: [],
    cards: [],
    proposals: [],
    createdAt: ts,
    updatedAt: ts,
  };
  s.huddles.unshift(h);
  // Keep the newest. Up to HARD_KEPT, never drop one that still has proposals waiting on you.
  dropOldest(s, MAX_KEPT, (x) => !x.proposals.some((p) => p.status === 'pending'));
  dropOldest(s, HARD_KEPT, () => true);
  return h;
}

export function findHuddle(s: State, id: string): Huddle | undefined {
  return s.huddles.find((h) => h.id === id);
}

/** The 3-second poll carries huddles without their board and transcript, and decided proposals without their text. */
export function stripHuddle(h: Huddle): HuddleSummary {
  const { entries, cards, proposals, ...rest } = h;
  return {
    ...rest,
    proposals: proposals.map(({ text, ...pr }) => (pr.status === 'pending' ? { ...pr, text } : pr)),
    entryCount: entries.length,
    cardCount: cards.length,
  };
}

export function pendingProposals(s: State): number {
  return s.huddles.reduce((n, h) => n + h.proposals.filter((p) => p.status === 'pending').length, 0);
}

export function summarizedThisRound(h: Huddle): boolean {
  return h.entries.some((e) => e.kind === 'summary' && e.round === h.round);
}

const touch = (h: Huddle) => {
  h.updatedAt = now();
};

// ---------- contributions ----------

export interface ContributionArgs {
  went_well?: string[];
  didnt?: string[];
  try?: string[];
  ideas?: { title: string; why?: string }[];
  tasks?: { title: string; owner?: string; detail?: string }[];
  note?: string;
}

const LANE_TITLE: Record<HuddleLane, string> = { 'went-well': 'Went well', didnt: 'Did not go well', try: 'Try next', idea: 'Ideas', task: 'Tasks' };
const NEEDS: Record<HuddleKind, string> = {
  retro: 'Add at least one item to went_well, didnt or try.',
  brainstorm: 'Add at least one idea.',
  planning: 'Add at least one task.',
};

/** Record a desk's turn. Null when it went in, or why it did not. */
export function recordContribution(s: State, h: Huddle, agentId: string, args: ContributionArgs): string | null {
  if (h.status !== 'running' || h.phase !== 'contribute') return 'This huddle is not taking contributions right now.';
  if (!h.participants.includes(agentId)) return 'You are not in this huddle.';
  if (!h.waiting.includes(agentId)) return 'You already added your contribution this round. You can stop now.';
  const card = (lane: HuddleLane, title: string, detail?: string, owner?: string): HuddleCard => ({
    id: uid('card'),
    round: h.round,
    by: agentId,
    lane,
    title: title.trim(),
    ...(detail?.trim() ? { detail: detail.trim() } : {}),
    ...(owner ? { owner } : {}),
  });
  const cards: HuddleCard[] = [];
  if (h.kind === 'retro') {
    for (const t of args.went_well ?? []) if (t.trim()) cards.push(card('went-well', t));
    for (const t of args.didnt ?? []) if (t.trim()) cards.push(card('didnt', t));
    for (const t of args.try ?? []) if (t.trim()) cards.push(card('try', t));
  } else if (h.kind === 'brainstorm') {
    for (const i of args.ideas ?? []) if (i.title?.trim()) cards.push(card('idea', i.title, i.why));
  } else {
    for (const t of args.tasks ?? []) if (t.title?.trim()) cards.push(card('task', t.title, t.detail, deskByName(s, t.owner)?.id));
  }
  const note = args.note?.trim() ?? '';
  if (!cards.length) return note ? NEEDS[h.kind] : `${NEEDS[h.kind]} A note on its own is not enough.`;
  const kept = cards.slice(0, MAX_CARDS_PER_TURN);
  h.cards.push(...kept);
  const byLane = new Map<HuddleLane, HuddleCard[]>();
  for (const c of kept) byLane.set(c.lane, [...(byLane.get(c.lane) ?? []), c]);
  // Blocks apart by a blank line, so a list never swallows the next heading.
  const blocks: string[] = [];
  if (note) blocks.push(note);
  for (const [lane, list] of byLane) {
    const items = list.map((c) => `- ${c.title}${c.detail ? ` — ${c.detail}` : ''}${c.owner ? ` (owner: ${s.agents.find((a) => a.id === c.owner)?.name ?? c.owner})` : ''}`);
    blocks.push([`**${LANE_TITLE[lane]}**`, ...items].join('\n'));
  }
  h.entries.push({ id: uid('hen'), round: h.round, from: agentId, kind: 'contribution', text: blocks.join('\n\n'), ts: now() });
  h.waiting = h.waiting.filter((id) => id !== agentId);
  touch(h);
  return null;
}

/** A desk's turn ended without the tool: keep what it said, or say its run failed. Either way it is done for the round. */
export function recordFallback(h: Huddle, agentId: string, text: string, failed: boolean): void {
  if (!h.waiting.includes(agentId)) return;
  const t = capText(text.trim(), MAX_FALLBACK);
  if (t || failed) h.entries.push({ id: uid('hen'), round: h.round, from: agentId, kind: failed ? 'note' : 'contribution', text: t || 'No contribution this round.', ts: now() });
  h.waiting = h.waiting.filter((id) => id !== agentId);
  touch(h);
}

// ---------- the facilitator's summary ----------

export interface SummaryArgs {
  summary: string;
  tickets?: { title: string; owner?: string; brief: string }[];
  notes?: string[];
  pick?: { title: string; reason: string };
}

/** Record the facilitator's round summary; on the last round, its proposals too. Null when it went in, or why not. */
export function recordSummary(s: State, h: Huddle, agentId: string, args: SummaryArgs): string | null {
  if (h.status !== 'running' || h.phase !== 'summarize') return 'This huddle is not waiting for a summary right now.';
  if (agentId !== h.facilitator) return 'Only the facilitator sums up a round.';
  if (summarizedThisRound(h)) return 'This round is already summed up. You can stop now.';
  const summary = args.summary?.trim();
  if (!summary) return 'Write the summary.';
  h.entries.push({ id: uid('hen'), round: h.round, from: agentId, kind: 'summary', text: summary, ts: now() });
  if (h.round >= h.rounds) {
    for (const t of (args.tickets ?? []).slice(0, 8)) {
      if (!t.title?.trim()) continue;
      h.proposals.push({ id: uid('prop'), type: 'ticket', title: t.title.trim(), text: (t.brief ?? '').trim(), owner: deskByName(s, t.owner)?.id ?? h.facilitator, status: 'pending' });
    }
    for (const n of (args.notes ?? []).slice(0, 5)) {
      const line = noteLine(n ?? '');
      if (line) h.proposals.push({ id: uid('prop'), type: 'note', title: line.slice(0, 80), text: line, status: 'pending' });
    }
    if (h.kind === 'brainstorm' && args.pick?.title?.trim()) h.pick = { title: args.pick.title.trim(), reason: (args.pick.reason ?? '').trim() };
  }
  touch(h);
  return null;
}

/** The facilitator's turn ended without the tool: its reply becomes the summary. */
export function recordFallbackSummary(h: Huddle, text: string): boolean {
  const t = capText(text.trim(), MAX_FALLBACK_SUMMARY);
  if (!t) return false;
  h.entries.push({ id: uid('hen'), round: h.round, from: h.facilitator, kind: 'summary', text: t, ts: now() });
  touch(h);
  return true;
}

/** After a summary: the next round, or done. */
export function advance(h: Huddle): void {
  if (h.round < h.rounds) {
    h.round += 1;
    h.phase = 'contribute';
    h.waiting = [...h.participants];
  } else {
    h.phase = 'done';
    h.status = 'done';
    h.waiting = [];
    h.finishedAt = now();
  }
  touch(h);
}

export function addSteer(h: Huddle, text: string): void {
  h.entries.push({ id: uid('hen'), round: h.round, from: 'you', kind: 'steer', text: text.trim(), ts: now() });
  touch(h);
}

export function stopHuddle(h: Huddle, reason: NonNullable<Huddle['stopReason']>): void {
  if (h.status !== 'running') return;
  h.status = 'stopped';
  h.stopReason = reason;
  touch(h);
}

/**
 * Pick up where it stopped: the same round, only the desks that still owe their turn. A desk whose
 * turn failed still owes it. Desks removed from the team drop out; a new facilitator steps in if needed.
 */
export function reopenHuddle(s: State, h: Huddle): string | null {
  if (h.status !== 'stopped') return 'Only a stopped huddle can be resumed.';
  const isDesk = (id: string) => s.agents.some((a) => a.id === id && !a.isHuman);
  const participants = h.participants.filter(isDesk);
  if (!participants.length) return 'Every desk in this huddle has left the team. Start a new huddle instead.';
  h.participants = participants;
  if (!participants.includes(h.facilitator)) {
    const lead = leadOf(s.agents);
    h.facilitator = lead && participants.includes(lead.id) ? lead.id : participants[0];
    const name = s.agents.find((a) => a.id === h.facilitator)?.name ?? h.facilitator;
    h.entries.push({ id: uid('hen'), round: h.round, from: 'hq', kind: 'note', text: `The facilitator left the team, so ${name} facilitates from here.`, ts: now() });
  }
  if (h.phase === 'contribute') {
    const added = new Set(h.entries.filter((e) => e.round === h.round && e.kind === 'contribution').map((e) => e.from));
    h.waiting = participants.filter((id) => !added.has(id));
  } else h.waiting = h.waiting.filter(isDesk);
  h.status = 'running';
  h.stopReason = undefined;
  touch(h);
  return null;
}

// ---------- proposals ----------

/** The team notes with one more lesson at the end, as a single list line. */
export function appendNote(notes: string, text: string, source: string, day = today()): string {
  const head = notes.trim() ? notes.trimEnd() : '# Team notes';
  return `${head}\n- ${noteLine(text)} _(${source}, ${day})_\n`;
}

/**
 * Null when an edit to the team notes can be saved, or why not: the notes changed since the edit
 * started (a huddle note was approved meanwhile), so saving would quietly drop that change.
 * No base means an old client that does not send one; it saves as before.
 */
export function notesConflict(current: string, base: string | undefined): string | null {
  if (base === undefined) return null;
  const norm = (t: string) => t.replace(/\s+$/, '');
  return norm(current) === norm(base)
    ? null
    : 'The team notes changed while you were editing (a huddle note was approved). Copy your text, press Cancel, and edit again.';
}

/** Approve or decline one proposal. Approving a ticket adds it to To do; approving a note adds it to the team notes. */
export function decideProposal(p: Project, h: Huddle, proposalId: string, decision: 'approve' | 'decline'): { proposal: HuddleProposal; item?: WorkItem } | string {
  const s = p.state;
  const proposal = h.proposals.find((x) => x.id === proposalId);
  if (!proposal) return 'That proposal is not on this huddle.';
  if (proposal.status !== 'pending') return `Already ${proposal.status}.`;
  if (decision === 'decline') {
    proposal.status = 'declined';
    proposal.decidedAt = now();
    touch(h);
    return { proposal };
  }
  if (proposal.type === 'note') {
    const next = appendNote(s.teamNotes, proposal.text, `from ${huddleLabel(h)}`);
    if (next.length > MAX_NOTES) return `The team notes would be over ${MAX_NOTES} characters. Trim them on the Team notes page first.`;
    s.teamNotes = next;
    proposal.status = 'approved';
    proposal.decidedAt = now();
    touch(h);
    return { proposal };
  }
  const owner = s.agents.find((a) => a.id === proposal.owner && !a.isHuman) ?? s.agents.find((a) => a.id === h.facilitator);
  const item: WorkItem = {
    id: uid('wi'),
    number: p.nextNumber(),
    kind: 'fyi',
    status: 'todo',
    title: proposal.title.slice(0, 120),
    summary: proposal.text,
    client: huddleLabel(h),
    from: h.facilitator,
    assignee: owner?.id ?? 'you',
    dated: today(),
    links: [],
    history: [{ ts: now(), text: `Proposed in ${huddleLabel(h)} "${h.topic.slice(0, 80)}", approved by you` }],
  };
  s.items.unshift(item);
  proposal.status = 'approved';
  proposal.itemId = item.id;
  proposal.decidedAt = now();
  touch(h);
  p.log('you', `Approved ${p.ticket(item)} "${item.title}" from ${huddleLabel(h)}`);
  return { proposal, item };
}

// ---------- prompt ----------

const GUIDE: Record<HuddleKind, string> = {
  retro:
    'Look back at the work on this project: tickets, threads, decisions, your memory.md. Add what went well, what did not, and what to try next. Be specific: name tickets (like KEY-12), decisions and moments. One to three items per column is plenty.',
  brainstorm: 'Add two to five distinct ideas for the topic, each with one line on why it could work. Build on ideas from earlier rounds instead of repeating them.',
  planning:
    'Break the goal into concrete tasks for this team. Each task: a title that starts with a verb, the desk that should own it, and one line on what done looks like. Only tasks this team can actually do.',
};

/** The prompt for one desk's turn in a huddle: the topic, the brief for its role, and everything said so far. */
export function huddlePromptText(p: Project, h: Huddle, agentId: string, role: 'participant' | 'facilitator'): string {
  const s = p.state;
  const nameOf = (id: string) =>
    id === 'you' ? (s.agents.find((a) => a.isHuman)?.name ?? 'The founder') : id === 'hq' ? 'HQ' : (s.agents.find((a) => a.id === id)?.name ?? id);
  const founder = nameOf('you');
  const lines = [
    `# ${huddleLabel(h)}: ${h.topic}`,
    `Round ${h.round} of ${h.rounds}. Desks: ${h.participants.map(nameOf).join(', ')}. Facilitator: ${nameOf(h.facilitator)}.`,
    `${founder} started this huddle. It is for talking, not doing: nothing changes until ${founder} approves it.`,
  ];
  if (h.kind !== 'brainstorm') {
    const recent = s.items.slice(0, 12).map((i) => `- ${p.ticket(i)} ${i.title} (${i.status}, ${nameOf(i.assignee)})`);
    if (recent.length) lines.push('', '## Recent tickets', ...recent);
  }
  // Everything said so far, newest kept when it is long. Each entry is quoted under its speaker,
  // so a label a desk writes inside its own text stays visibly inside its quote.
  const said: string[] = [];
  for (let r = 1; r <= h.round; r++) {
    const inRound = h.entries.filter((e) => e.round === r);
    if (!inRound.length) continue;
    said.push(`### Round ${r}`, '');
    for (const e of inRound) {
      const who = e.kind === 'summary' ? `Summary by ${nameOf(e.from)}` : e.kind === 'steer' ? `${founder} (note to the team)` : nameOf(e.from);
      said.push(`**${who}:**`, ...e.text.split('\n').map((l) => `> ${l}`.trimEnd()), '');
    }
  }
  let transcript = said.join('\n').trimEnd();
  if (transcript.length > 12_000) {
    // Cut at a line start, so no quoted text loses its "> ".
    const tail = transcript.slice(-12_000);
    transcript = `[earlier rounds trimmed]\n${tail.slice(tail.indexOf('\n') + 1)}`;
  }
  if (transcript) lines.push('', '## So far', transcript);
  lines.push('');
  if (role === 'participant') {
    lines.push(`## Your turn`, GUIDE[h.kind]);
    if (h.round > 1) lines.push('React to the last summary: agree, push back, add what is missing. Do not repeat what you already said.');
    lines.push('Add your contribution once with huddle_contribute, then stop. Keep the note to one short paragraph.');
  } else {
    lines.push(
      '## Your turn: sum up this round',
      'Write a short markdown summary: the themes, where desks agree, open disagreements, and who said what when it matters.',
    );
    if (h.round >= h.rounds) {
      lines.push(
        `This is the last round. Also propose, only where the discussion supports it: tickets (title, owner desk, brief) for the action items worth doing, and notes: short lessons worth keeping in the team notes.${h.kind === 'brainstorm' ? ' Pick the strongest idea and say why.' : ''} ${founder} approves each one.`,
      );
    } else lines.push('More rounds follow, so no tickets or notes yet.');
    lines.push('Call huddle_summarize once, then stop.');
  }
  return lines.join('\n');
}
