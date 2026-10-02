import type { Agent } from './types';

/**
 * Office desk numbers. A desk keeps its number for as long as it's on the team, so people don't
 * swap desks when someone leaves. A newcomer takes the lowest free number. The founder has none.
 * Returns true if anything changed.
 */
export function assignDeskNumbers(agents: Agent[]): boolean {
  let changed = false;
  const taken = new Set<number>();
  for (const a of agents) {
    const n = a.deskNo;
    if (a.isHuman) {
      if (n !== undefined) {
        delete a.deskNo;
        changed = true;
      }
    } else if (n !== undefined && Number.isInteger(n) && n >= 1 && !taken.has(n)) {
      taken.add(n);
    } else if (n !== undefined) {
      delete a.deskNo;
      changed = true;
    }
  }
  for (const a of agents) {
    if (a.isHuman || a.deskNo !== undefined) continue;
    let n = 1;
    while (taken.has(n)) n++;
    a.deskNo = n;
    taken.add(n);
    changed = true;
  }
  return changed;
}

/**
 * The Office's copy of the team with every desk numbered. The server numbers desks, but data from before that
 * (or hand-edited past `max`) may lack one: those take the lowest free numbers, in roster order, so everyone has
 * a desk to sit at and deskSlotsFor counts them. The agents passed in are left as they are.
 */
export function withDeskNumbers(agents: Agent[], max = Infinity): Agent[] {
  const copy = agents.map((a) => ({ ...a }));
  for (const a of copy) if (a.deskNo !== undefined && a.deskNo > max) delete a.deskNo;
  assignDeskNumbers(copy);
  return copy;
}

/** How many desk slots the office needs: the highest desk number in use (at least 1). */
export function deskSlotsFor(agents: Agent[]): number {
  return agents.reduce((max, a) => (!a.isHuman && a.deskNo ? Math.max(max, a.deskNo) : max), 1);
}
