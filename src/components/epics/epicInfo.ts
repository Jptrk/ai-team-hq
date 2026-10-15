import { blockerProblem, epicProgress, openBlockers, type Epic, type EpicProgress, type EpicStatus, type WorkItem } from '../../../shared/types';
import { ticketKey, type Tone } from '../../util';

/** An epic by the key in the URL (GA-14) or its id. Epics share ticket numbers, so a key is one or the other. */
export function epicByKey(epics: Epic[], key: string, projectKey: string): Epic | undefined {
  return epics.find((e) => ticketKey(e, projectKey) === key || e.id === key);
}

export const EPIC_STATUS_LABEL: Record<EpicStatus, string> = { todo: 'to do', 'in-progress': 'in progress', done: 'done' };
export const EPIC_STATUS_TONE: Record<EpicStatus, Tone> = { todo: 'neutral', 'in-progress': 'info', done: 'success' };

/** Epics for the list: open ones first (newest first), done ones after. */
export function sortEpics(epics: Epic[], items: Pick<WorkItem, 'epicId' | 'status'>[]): { epic: Epic; progress: EpicProgress }[] {
  const rows = epics.map((epic) => ({ epic, progress: epicProgress(epic.id, items) }));
  return rows.sort((a, b) => Number(a.progress.status === 'done') - Number(b.progress.status === 'done') || b.epic.number - a.epic.number);
}

/** "5 of 7 done", or "No tickets yet". */
export function progressText(p: Pick<EpicProgress, 'total' | 'done'>): string {
  return p.total ? `${p.done} of ${p.total} done` : 'No tickets yet';
}

/** The progress bar's parts, as whole percents that add up to 100 (or all 0 with no tickets). */
export function progressParts(p: Pick<EpicProgress, 'total' | 'done' | 'active'>): { done: number; active: number; todo: number } {
  if (!p.total) return { done: 0, active: 0, todo: 0 };
  const done = Math.round((p.done / p.total) * 100);
  const active = Math.min(100 - done, Math.round((p.active / p.total) * 100));
  return { done, active, todo: 100 - done - active };
}

/** "Blocked by GA-3 and GA-5", for a card's tag, or null when nothing open blocks it (or it is done). */
export function blockedTitle(item: Pick<WorkItem, 'status' | 'blockedBy'>, items: WorkItem[], projectKey: string): string | null {
  if (item.status === 'done') return null;
  const keys = openBlockers(item, items).map((b) => ticketKey(b, projectKey));
  if (!keys.length) return null;
  return `Blocked by ${keys.length === 1 ? keys[0] : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`}: it starts once ${keys.length === 1 ? 'that is' : 'they are'} done`;
}

/** Tickets that may be added as blockers of this one: not done, not itself or one already there, and none that would make a loop. Newest first. */
export function blockerChoices(item: Pick<WorkItem, 'id' | 'blockedBy'>, items: WorkItem[]): WorkItem[] {
  const current = item.blockedBy ?? [];
  return items.filter(
    (i) => i.id !== item.id && i.status !== 'done' && !current.includes(i.id) && blockerProblem(item.id, [...current, i.id], items, () => '') === null,
  );
}

/** Tickets that may join this epic: not done and not in it already. Newest first. */
export function epicTicketChoices(epicId: string, items: WorkItem[]): WorkItem[] {
  return items.filter((i) => i.epicId !== epicId && i.status !== 'done');
}
