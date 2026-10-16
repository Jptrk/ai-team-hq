import type { Epic, HuddleEpic, HuddleProposalSummary, WorkItem } from '../../../shared/types';

/** One ticket a planning proposal comes after: the ticket it became once approved, or else its proposal's title. */
export interface AfterPart {
  title: string;
  /** Its ticket, once that proposal is approved. */
  item?: WorkItem;
}

/**
 * What a ticket proposal comes after, in the facilitator's order. Declined ones drop out, and so do approved ones whose
 * ticket was deleted: neither will block it.
 */
export function proposalAfter(pr: Pick<HuddleProposalSummary, 'after'>, siblings: HuddleProposalSummary[], items: WorkItem[]): AfterPart[] {
  const parts: AfterPart[] = [];
  for (const id of pr.after ?? []) {
    const x = siblings.find((y) => y.id === id);
    if (!x || x.status === 'declined') continue;
    if (x.status === 'pending') {
      parts.push({ title: x.title });
      continue;
    }
    const item = x.itemId ? items.find((i) => i.id === x.itemId) : undefined;
    if (item) parts.push({ title: x.title, item });
  }
  return parts;
}

/** A title as the server compares epics for duplicates (server/epics.ts titleKey): case, spacing and punctuation don't count. */
const titleKey = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Where a planning huddle's epic stands. made: approving made it (or found it). existing: an epic of that title is
 * already there, and tickets will join it. new: it is made with the first ticket approved in it. Null once you
 * deleted it: no more tickets join it.
 */
export function huddleEpicState(planned: HuddleEpic | undefined, epics: Epic[]): { kind: 'made' | 'existing' | 'new'; title: string; epic?: Epic } | null {
  if (!planned) return null;
  if (planned.epicId) {
    const epic = epics.find((e) => e.id === planned.epicId);
    return epic ? { kind: 'made', title: epic.title, epic } : null;
  }
  const twin = epics.find((e) => titleKey(e.title) === titleKey(planned.title));
  return twin ? { kind: 'existing', title: twin.title, epic: twin } : { kind: 'new', title: planned.title };
}

/** The epic a ticket proposal goes in, or null when it is in none (or you deleted the epic). */
export function proposalEpic(pr: Pick<HuddleProposalSummary, 'inEpic'>, planned: HuddleEpic | undefined, epics: Epic[]): { title: string; epic?: Epic } | null {
  if (!pr.inEpic) return null;
  const state = huddleEpicState(planned, epics);
  return state && (state.epic ? { title: state.title, epic: state.epic } : { title: state.title });
}
