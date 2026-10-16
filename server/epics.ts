import type { Epic, RunReason, State, WorkItem } from '../shared/types';
import { blockerProblem, EPIC_COLORS, MAX_DESCRIPTION, MAX_EPIC_TITLE, openBlockers } from '../shared/types';
import { now, uid, type Project } from './store';

/**
 * Epics and blockers.
 *
 * An epic groups tickets (WorkItem.epicId); its status and progress come from them (epicProgress). A ticket can be
 * blocked by other tickets (WorkItem.blockedBy): until each is done, Autopilot skips it, and a start you, a hand-off
 * or a released hold make waits on the ticket (runner/index.ts) and begins by itself once they are done. Loops are
 * refused, so a chain always has a ticket that can start.
 */

/** Starts that do the ticket's work from the beginning: these wait for its blockers. Comments, QA checks and your decisions on work under way don't. */
const BLOCKED_STARTS = new Set<RunReason>(['auto', 'manual', 'handoff', 'instruction']);

/** Whether this start has to wait for the ticket's blockers. */
export function waitsForBlockers(reason: RunReason): boolean {
  return BLOCKED_STARTS.has(reason);
}

/** "GA-3", or "GA-3 and GA-5": the tickets still blocking this one, by key. Empty when nothing blocks it. */
export function blockerKeys(p: Project, item: WorkItem): string {
  const keys = openBlockers(item, p.state.items).map((b) => p.ticket(b));
  return keys.length <= 1 ? (keys[0] ?? '') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`;
}

/** Why a start of this kind can't begin now because of the ticket's blockers, in words for its history and the page, or null. */
export function blockedText(p: Project, item: WorkItem, reason: RunReason): string | null {
  if (!waitsForBlockers(reason)) return null;
  const keys = blockerKeys(p, item);
  if (!keys) return null;
  return `blocked by ${keys}, not done yet`;
}

/** A title as compared for duplicates: case, spacing and punctuation do not count. */
export const titleKey = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function findEpic(s: State, id: string): Epic | undefined {
  return s.epics.find((e) => e.id === id);
}

/** An epic by its key (GA-14, or 14), its id, or its title, for desks that name one. */
export function epicByRef(p: Project, ref: string): Epic | undefined {
  const r = ref.trim();
  const num = /^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d+)$/.exec(r);
  if (num && (!num[1] || num[1].toUpperCase() === p.meta.key.toUpperCase())) {
    const n = Number(num[2]);
    const hit = p.state.epics.find((e) => e.number === n);
    if (hit) return hit;
  }
  return p.state.epics.find((e) => e.id === r) ?? p.state.epics.find((e) => titleKey(e.title) === titleKey(r));
}

/** A ticket by its key (GA-12, or 12) or id, for desks that name one. */
export function ticketByRef(p: Project, ref: string): WorkItem | undefined {
  const r = ref.trim();
  const num = /^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d+)$/.exec(r);
  if (num && (!num[1] || num[1].toUpperCase() === p.meta.key.toUpperCase())) {
    const n = Number(num[2]);
    const hit = p.state.items.find((i) => i.number === n);
    if (hit) return hit;
  }
  return p.state.items.find((i) => i.id === r);
}

export interface EpicInput {
  title: string;
  summary?: string;
}

/** Why an epic's title or description won't do, or null. */
export function epicInputProblem(input: { title?: unknown; summary?: unknown }, requireTitle: boolean): string | null {
  if (input.title !== undefined || requireTitle) {
    if (typeof input.title !== 'string' || !input.title.trim()) return 'Give the epic a title.';
    if (input.title.trim().length > MAX_EPIC_TITLE) return `An epic's title can be at most ${MAX_EPIC_TITLE} characters.`;
  }
  if (input.summary !== undefined) {
    if (typeof input.summary !== 'string') return 'The description must be text.';
    if (input.summary.trim().length > MAX_DESCRIPTION) return `The description can be at most ${MAX_DESCRIPTION} characters.`;
  }
  return null;
}

/** A new epic, newest first. from: 'you' or the desk that made it. Takes the next ticket number, so its key is its own. */
export function createEpic(p: Project, from: string, input: EpicInput): Epic {
  const s = p.state;
  const epic: Epic = {
    id: uid('ep'),
    number: p.nextNumber(),
    title: input.title.replace(/\s+/g, ' ').trim().slice(0, MAX_EPIC_TITLE),
    summary: (input.summary ?? '').replace(/\s+$/, ''),
    color: EPIC_COLORS[s.epics.length % EPIC_COLORS.length],
    from,
    createdAt: now(),
  };
  s.epics.unshift(epic);
  p.log(from, `Made epic ${p.ticket(epic)} "${epic.title}"`);
  return epic;
}

/** Another epic already open under this title (case and punctuation aside), for planning that would make it twice. */
export function epicTwin(s: State, title: string): Epic | undefined {
  const key = titleKey(title);
  return s.epics.find((e) => titleKey(e.title) === key);
}

export function updateEpic(p: Project, epic: Epic, patch: Partial<EpicInput>): void {
  if (patch.title !== undefined) epic.title = patch.title.replace(/\s+/g, ' ').trim().slice(0, MAX_EPIC_TITLE);
  if (patch.summary !== undefined) epic.summary = patch.summary.replace(/\s+$/, '');
}

/** Deletes the epic. Its tickets stay on the board, in no epic, each with a line in its history. */
export function deleteEpic(p: Project, epic: Epic): number {
  const s = p.state;
  let n = 0;
  for (const item of s.items) {
    if (item.epicId !== epic.id) continue;
    delete item.epicId;
    item.history.push({ ts: now(), text: `Epic ${p.ticket(epic)} "${epic.title}" was deleted; the ticket stays` });
    n++;
  }
  s.epics = s.epics.filter((e) => e.id !== epic.id);
  const kept = n === 0 ? '' : n === 1 ? '; its ticket stays on the board' : `; its ${n} tickets stay on the board`;
  p.log('you', `Deleted epic ${p.ticket(epic)} "${epic.title}"${kept}`);
  return n;
}

/** Puts the ticket in this epic, or in none (null), with a line in its history. by: who did it, in words ("you", a desk's name). */
export function setEpic(p: Project, item: WorkItem, epic: Epic | null, by: string): void {
  if ((item.epicId ?? null) === (epic?.id ?? null)) return;
  const was = item.epicId ? findEpic(p.state, item.epicId) : undefined;
  if (epic) {
    item.epicId = epic.id;
    item.history.push({ ts: now(), text: `Added to epic ${p.ticket(epic)} "${epic.title}" by ${by}` });
  } else {
    delete item.epicId;
    if (was) item.history.push({ ts: now(), text: `Taken out of epic ${p.ticket(was)} "${was.title}" by ${by}` });
  }
}

/** Why the ticket can't be blocked by these tickets (ids), or null. */
export function blockersProblem(p: Project, item: WorkItem, ids: string[]): string | null {
  return blockerProblem(item.id, ids, p.state.items, (i) => p.ticket(i));
}

/**
 * Sets the tickets that block this one (ids, checked first with blockersProblem). Each one added or taken off gets a
 * line in the ticket's history. by: who did it, in words.
 */
export function setBlockers(p: Project, item: WorkItem, ids: string[], by: string): void {
  const next = [...new Set(ids)];
  const before = item.blockedBy ?? [];
  const added = next.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !next.includes(id));
  if (!added.length && !removed.length) return;
  const keys = (list: string[]) =>
    list
      .map((id) => p.state.items.find((i) => i.id === id))
      .filter((i): i is WorkItem => Boolean(i))
      .map((i) => p.ticket(i))
      .join(', ');
  if (next.length) item.blockedBy = next;
  else delete item.blockedBy;
  if (added.length) item.history.push({ ts: now(), text: `Blocked by ${keys(added)} (set by ${by}): it starts once ${added.length === 1 ? 'that is' : 'those are'} done` });
  if (removed.length && keys(removed)) item.history.push({ ts: now(), text: `No longer blocked by ${keys(removed)} (${by})` });
}
