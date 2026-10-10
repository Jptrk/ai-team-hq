import type { Agent, Attachment, ItemStatus, Run, State, WorkItem } from '../shared/types';
import { addComment } from './comments';
import { limit } from './limits';
import { now } from './store';

/**
 * QA on dev-team projects, and your sign-off on every project, as pure state. A finished ticket goes to
 * the project's QA desk, which passes or fails it. A pass waits for your sign-off; a fail goes back to
 * the owner, until it has failed too often and comes to you. Without QA, a finished ticket waits for
 * your sign-off straight away. With sign-off off, finished (and passed) work is done; a fix of work QA
 * failed still waits for a check, or for you when nobody can check it.
 * The runner wakes the desks; this only moves the ticket.
 */

/** Fixes the owner gets after a QA fail before the ticket comes to you instead (Accounts page, or HQ_QA_MAX_FIXES). */
export const qaMaxFixes = (): number => limit('qaMaxFixes');
/** Changed files kept per ticket. */
const MAX_CHANGED = 50;
const MAX_ISSUES = 10;

export function qaDeskOf(s: State): Agent | undefined {
  return s.agents.find((a) => a.qa && !a.isHuman);
}

/** Make one desk the QA desk, or none. Your pick sticks: a restart never picks one by role again. */
export function setQaDesk(s: State, id: string | null): void {
  for (const a of s.agents) a.qa = !a.isHuman && a.id === id ? true : undefined;
  s.qaPicked = true;
}

/** Who checks this ticket now. Nobody when there is no QA desk, it is off shift, or it did the work itself. */
function checkerFor(s: State, item: WorkItem): Agent | undefined {
  const qa = qaDeskOf(s);
  if (!qa || qa.status === 'off' || qa.id === item.assignee) return undefined;
  return qa;
}

const roundOf = (item: WorkItem) => item.qa?.round ?? 0;

/**
 * Put a ticket in QA: the QA desk checks it, or, with no QA desk free for it, it waits for your sign-off.
 * Each trip is a new round with no verdict yet, so an older check never speaks for this one.
 * Sent here by hand, re-routed or changed after QA, it comes to you even with sign-off off: it was waiting for a check.
 */
export function sendToQa(s: State, item: WorkItem): 'qa' | 'signoff' {
  const { result: _result, by: _by, ...prev } = item.qa ?? { fails: 0 };
  const round = roundOf(item) + 1;
  const qa = checkerFor(s, item);
  if (!qa) {
    item.status = 'signoff';
    item.qa = { ...prev, round, ready: true, escalated: false };
    const desk = qaDeskOf(s);
    item.history.push({
      ts: now(),
      text: !desk
        ? 'Ready for your sign-off: no QA desk on this project'
        : desk.id === item.assignee
          ? `Ready for your sign-off: ${desk.name} is the QA desk and did the work`
          : `Ready for your sign-off: ${desk.name} (QA) is off shift`,
    });
    return 'signoff';
  }
  item.status = 'qa';
  item.qa = { ...prev, round, by: qa.id, ready: false, escalated: false };
  item.history.push({ ts: now(), text: `Sent to QA: ${qa.name}` });
  return 'qa';
}

/** Where finished work goes on a project. */
export interface FinishFlags {
  /** Dev-team projects: the QA desk checks it first. */
  qa: boolean;
  /** The project's sign-off setting: finished work waits for you before Done. */
  signoff: boolean;
}

/** Finished work on a project without QA: it waits for your sign-off. No verdict, so the sign-off shows the owner's summary. */
function awaitSignoff(item: WorkItem): 'signoff' {
  const { result: _result, by: _by, ...prev } = item.qa ?? { fails: 0 };
  item.status = 'signoff';
  item.qa = { ...prev, ready: true, escalated: false };
  item.history.push({ ts: now(), text: 'Ready for your sign-off' });
  return 'signoff';
}

/**
 * A desk finished its ticket. With QA, it goes to the QA desk; with sign-off, to you (straight away when
 * nobody can check it); with neither, it is done. Sign-off off and no QA desk free for it: done unchecked,
 * unless QA failed it last time: then the fix comes to you, since HQ never closes failed work unchecked.
 */
export function finishWork(s: State, item: WorkItem, summary: string, on: FinishFlags): 'done' | 'qa' | 'signoff' {
  item.history.push({ ts: now(), text: `Done: ${summary.trim().slice(0, 800) || 'Finished without a summary.'}` });
  // Dev-team projects: the QA desk checks it, or it comes to you with why nobody could. A fix after a QA fail too.
  if (item.qa?.result === 'fail' || (on.qa && (on.signoff || checkerFor(s, item)))) return sendToQa(s, item);
  if (on.signoff) return awaitSignoff(item);
  item.status = 'done';
  return 'done';
}

export interface QaVerdict {
  result: 'pass' | 'fail';
  summary: string;
  issues?: string[];
}

/** Where a verdict sent the ticket: your sign-off (or Done, with sign-off off), back to the owner, or to you after too many fails. */
export type QaOutcome = 'signoff' | 'done' | 'rework' | 'escalated';

const issuesOf = (v: QaVerdict) => (v.issues ?? []).map((t) => t.trim()).filter(Boolean).slice(0, MAX_ISSUES);

/** Why a verdict cannot go in, or null. Checked before any image is saved. `round`: the QA round the check started in. */
export function verdictProblem(item: WorkItem, v: QaVerdict, round?: number): string | null {
  if (item.status !== 'qa') return `This ticket is not in QA any more (it is ${item.status}). Nothing to record.`;
  // The owner changed it, or it was sent to QA again, while this check was reading the older work.
  if (round !== undefined && round !== roundOf(item)) return 'The ticket changed since this check started; stop now.';
  if (!v.summary.trim()) return 'Write what you checked.';
  if (v.result === 'fail' && !issuesOf(v).length) return 'A fail needs at least one issue the owner can fix: the file, what is wrong, and what you expected.';
  return null;
}

/** Record the QA desk's verdict on a ticket in QA. `signoff`: the project's sign-off setting. The outcome, or why it was refused. */
export function recordQaResult(s: State, item: WorkItem, by: string, v: QaVerdict, attachments: Attachment[] = [], round?: number, signoff = true): QaOutcome | string {
  const problem = verdictProblem(item, v, round);
  if (problem) return problem;
  const summary = v.summary.trim();
  const issues = issuesOf(v);
  const name = s.agents.find((a) => a.id === by)?.name ?? by;
  const body = issues.length ? `${summary}\n\n**Issues**\n${issues.map((i) => `- ${i}`).join('\n')}` : summary;
  const prev = item.qa ?? { fails: 0 };
  const images = attachments.length ? { attachments } : {};

  if (v.result === 'pass') {
    addComment(item, { from: by, kind: 'qa', title: 'Passed QA', text: body, ...images });
    // Sign-off off: a pass is the last step.
    if (!signoff) {
      item.status = 'done';
      item.qa = { ...prev, by, result: 'pass', ready: false, escalated: false };
      item.history.push({ ts: now(), text: `Passed QA (${name}). Done` });
      return 'done';
    }
    item.status = 'signoff';
    item.qa = { ...prev, by, result: 'pass', ready: true, escalated: false };
    item.history.push({ ts: now(), text: `Passed QA (${name}). Ready for your sign-off` });
    return 'signoff';
  }

  const fails = prev.fails + 1;
  const maxFixes = qaMaxFixes();
  if (fails > maxFixes) {
    // Too many rounds: you decide instead of another fix.
    item.status = 'needs-you';
    item.qa = { ...prev, by, fails, result: 'fail', ready: true, escalated: true };
    addComment(item, {
      from: by,
      kind: 'decision',
      title: `Failed QA ${fails} time${fails === 1 ? '' : 's'}: your call`,
      text: `${body}\n\nApprove to accept it as it is, send it back with a note, or hold it.`,
      ...images,
    });
    item.history.push({ ts: now(), text: `Failed QA ${fails} time${fails === 1 ? '' : 's'} (${name}). Waiting for you` });
    return 'escalated';
  }
  item.status = 'sent-back';
  item.qa = { ...prev, by, fails, result: 'fail', ready: false, escalated: false };
  addComment(item, { from: by, kind: 'qa', title: 'Failed QA', text: body, ...images });
  item.history.push({ ts: now(), text: `Failed QA (${name}). Back to the owner, fix ${fails} of ${maxFixes}` });
  return 'rework';
}

/**
 * You sent it back or gave an instruction: it is work again, and QA starts counting fails afresh.
 * Finished work (waiting for your sign-off, held there, or QA gave up on it) becomes a rework of it, so
 * the desk fixes it and reports it done again instead of raising it. Call it before the status changes.
 */
export function backToWork(item: WorkItem): void {
  if (!item.qa) return;
  const rework = closesOnApprove(item);
  const { reworkOf: _reworkOf, ...prev } = item.qa;
  item.qa = { ...prev, fails: 0, ready: false, escalated: false, ...(rework ? { reworkOf: 'signoff' as const } : {}) };
}

/**
 * It left your sign-off, or QA's escalation, for anything but your Approve or Hold (a new ask, a move,
 * a desk back on it): Approve has to start a run again instead of closing it.
 */
export function clearSignoff(item: WorkItem): void {
  if (item.qa && (item.qa.ready || item.qa.escalated)) item.qa = { ...item.qa, ready: false, escalated: false };
}

/** The work is finished and waits for your sign-off (or QA gave up): Approve closes the ticket instead of starting a run. */
export function closesOnApprove(item: WorkItem): boolean {
  return Boolean(item.qa?.ready) && (item.status === 'signoff' || item.status === 'needs-you' || item.status === 'held');
}

/**
 * You moved a ticket by hand (status menu or drag). Into QA it goes to the QA desk; into sign-off,
 * Approve closes it, with no QA verdict since nobody checked it this way; on hold it keeps its place;
 * anywhere else it is not waiting on a sign-off. 'qa' when it needs a check now, 'done' when it just became done, else null.
 */
export function moveByHand(s: State, item: WorkItem, next: ItemStatus): 'qa' | 'done' | null {
  if (next === item.status) return null;
  if (next === 'qa') {
    item.history.push({ ts: now(), text: 'Moved to QA by you' });
    return sendToQa(s, item) === 'qa' ? 'qa' : null;
  }
  item.status = next;
  item.history.push({ ts: now(), text: `Moved to ${next} by you` });
  if (next === 'signoff') {
    // As awaitSignoff: an older verdict, and who gave it, must not show as this sign-off's.
    const { result: _result, by: _by, ...prev } = item.qa ?? { fails: 0 };
    item.qa = { ...prev, ready: true, escalated: false };
  } else if (next !== 'held') clearSignoff(item);
  return next === 'done' ? 'done' : null;
}

/** The owner changed project files on a ticket in QA or waiting for your sign-off: the last check does not cover them, so it goes back to QA. */
export function changedAfterQa(s: State, item: WorkItem, byName: string): 'qa' | 'signoff' | null {
  if (item.status !== 'qa' && item.status !== 'signoff') return null;
  item.history.push({ ts: now(), text: `Changed after QA by ${byName}; back to QA` });
  return sendToQa(s, item);
}

/**
 * The QA desk changed, stopped or left: a ticket in QA that someone else was checking goes to the QA
 * desk now, or to your sign-off. 'qa' when it needs a check, null when nothing changed.
 */
export function rerouteQa(s: State, item: WorkItem): 'qa' | 'signoff' | null {
  if (item.status !== 'qa') return null;
  const desk = qaDeskOf(s);
  if (desk && item.qa?.by === desk.id) return null;
  return sendToQa(s, item);
}

/** rerouteQa for every ticket. The tickets that now need a check. */
export function rerouteAllQa(s: State): WorkItem[] {
  return s.items.filter((item) => rerouteQa(s, item) === 'qa');
}

/** The QA check already waiting to start on a ticket. A running one is never reused: it may be reading an older round. */
export function queuedQaRun(s: State, itemId: string): Run | undefined {
  return s.runs.find((r) => r.itemId === itemId && r.reason === 'qa' && r.status === 'queued');
}

/** Remember project files a desk changed for this ticket, newest last, without repeats. */
export function noteChangedFiles(item: WorkItem, files: Iterable<string>): void {
  const add = [...files].filter(Boolean);
  if (!add.length) return;
  const kept = (item.changedFiles ?? []).filter((f) => !add.includes(f));
  item.changedFiles = [...kept, ...new Set(add)].slice(-MAX_CHANGED);
}
