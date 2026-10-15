import type { WorkItem } from '../../../shared/types';
import { ticketKey } from '../../util';

/** Every epic, tickets in no epic, or one epic's tickets (its id). */
export type EpicFilter = '' | 'none' | (string & {});

export interface BoardFilter {
  text: string;
  /** Agent ids; empty = everyone. */
  assignees: string[];
  /** Only tickets waiting on the founder. */
  needsMe: boolean;
  epic: EpicFilter;
}

export const EMPTY_FILTER: BoardFilter = { text: '', assignees: [], needsMe: false, epic: '' };

export function isFiltered(f: BoardFilter): boolean {
  return Boolean(f.text.trim()) || f.assignees.length > 0 || f.needsMe || Boolean(f.epic);
}

export function filterItems(items: WorkItem[], f: BoardFilter, projectKey: string): WorkItem[] {
  const q = f.text.trim().toLowerCase();
  return items.filter((i) => {
    if (f.needsMe && i.status !== 'needs-you' && i.status !== 'held' && i.status !== 'signoff') return false;
    if (f.assignees.length && !f.assignees.includes(i.assignee)) return false;
    if (f.epic === 'none' && i.epicId) return false;
    if (f.epic && f.epic !== 'none' && i.epicId !== f.epic) return false;
    if (q) {
      const hay = `${ticketKey(i, projectKey)} ${i.title} ${i.client ?? ''} ${i.summary}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
