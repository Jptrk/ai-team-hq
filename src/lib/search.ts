import type { Agent, WorkItem } from '../../shared/types';
import { plainText } from '../markdown/plainText';
import { ticketKey } from '../util';

export interface SearchHit {
  item: WorkItem;
  key: string;
  score: number;
}

/** Ticket search for the top bar: an exact key wins, then key prefix, title, owner, summary, client. */
export function searchItems(items: WorkItem[], query: string, projectKey: string, agents: Agent[], limit = 8): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const item of items) {
    const key = ticketKey(item, projectKey);
    const k = key.toLowerCase();
    const title = item.title.toLowerCase();
    let score = 0;
    // An exact key always beats everything else combined.
    if (k === q) score += 1000;
    else if (k.startsWith(q)) score += 60;
    if (title.startsWith(q)) score += 50;
    else if (title.includes(q)) score += 40;
    const owner = agents.find((a) => a.id === item.assignee)?.name.toLowerCase() ?? '';
    if (owner && owner.includes(q)) score += 12;
    if ((item.client ?? '').toLowerCase().includes(q)) score += 8;
    if (score === 0 && plainText(item.summary, 400).toLowerCase().includes(q)) score += 10;
    if (score > 0) hits.push({ item, key, score });
  }
  return hits.sort((a, b) => b.score - a.score || (b.item.number ?? 0) - (a.item.number ?? 0)).slice(0, limit);
}
