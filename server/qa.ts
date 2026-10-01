import type { Agent, Attachment, ItemStatus, Run, State, WorkItem } from '../shared/types';
import { addComment } from './comments';
import { now } from './store';

/**
 * QA on dev-team projects, as pure state. A finished ticket goes to the project's QA desk, which passes
 * or fails it. A pass waits for your sign-off; a fail goes back to the owner, until it has failed too
 * often and comes to you. The runner wakes the desks; this only moves the ticket.
 */

/** Fixes the owner gets after a QA fail before the ticket comes to you instead. */
export const QA_MAX_FIXES = (() => {
  const raw = Number(process.env.HQ_QA_MAX_FIXES);
  return process.env.HQ_QA_MAX_FIXES?.trim() && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 2;
})();
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

/** A desk finished its ticket. With QA on, it goes to QA (or straight to your sign-off); otherwise it is done. */
export function finishWork(s: State, item: WorkItem, summary: string, qaOn: boolean): 'done' | 'qa' | 'signoff' {
  item.history.push({ ts: now(), text: `Done: ${summary.trim().slice(0, 800) || 'Finished without a summary.'}` });
  if (!qaOn) {
    item.status = 'done';
    return 'done';
  }
  return sendToQa(s, item);
}

export interface QaVerdict {
  result: 'pass' | 'fail';
  summary: string;
  issues?: string[];
}

/** Where a verdict sent the ticket: your sign-off, back to the owner, or to you after too many fails. */
export type QaOutcome = 'signoff' | 'rework' | 'escalated';

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

/** Record the QA desk's verdict on a ticket in QA. The outcome, or why it was refused. */
export function recordQaResult(s: State, item: WorkItem, by: string, v: QaVerdict, attachments: Attachment[] = [], round?: number): QaOutcome | string {
  const problem = verdictProblem(item, v, round);
  if (problem) return problem;
  const summary = v.summary.trim();
  const issues = issuesOf(v);
  const name = s.agents.find((a) => a.id === by)?.name ?? by;
  const body = issues.length ? `${summary}\n\n**Issues**\n${issues.map((i) => `- ${i}`).join('\n')}` : summary;
  const prev = item.qa ?? { fails: 0 };
  const images = attachments.length ? { attachments } : {};

  if (v.result === 'pass') {
    item.status = 'signoff';
    item.qa = { ...prev, by, result: 'pass', ready: true, escalated: false };
    addComment(item, { from: by, kind: 'qa', title: 'Passed QA', text: body, ...images });
    item.history.push({ ts: now(), text: `Passed QA (${name}). Ready for your sign-off` });
    return 'signoff';
  }

  const fails = prev.fails + 1;
  if (fails > QA_MAX_FIXES) {
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
  item.history.push({ ts: now(), text: `Failed QA (${name}). Back to the owner, fix ${fails} of ${QA_MAX_FIXES}` });
  return 'rework';
}

/** You sent it back or gave an instruction: it is work again, and QA starts counting fails afresh. */
export function backToWork(item: WorkItem): void {
  if (item.qa) item.qa = { ...item.qa, fails: 0, ready: false, escalated: false };
}

/**
 * It left your sign-off, or QA's escalation, for anything but your Approve or Hold (a new ask, a move,
 * a desk back on it): Approve has to start a run again instead of closing it.
 */
export function clearSignoff(item: WorkItem): void {
  if (item.qa && (item.qa.ready || item.qa.escalated)) item.qa = { ...item.qa, ready: false, escalated: false };
}

/** The work is finished and checked (or QA gave up): Approve closes the ticket instead of starting a run. */
export function closesOnApprove(item: WorkItem): boolean {
  return Boolean(item.qa?.ready) && (item.status === 'signoff' || item.status === 'needs-you' || item.status === 'held');
}

/**
 * You moved a ticket by hand (status menu or drag). Into QA it goes to the QA desk; into sign-off,
 * Approve closes it; on hold it keeps its place; anywhere else it is not waiting on a sign-off.
 * 'qa' when it needs a check now, 'done' when it just became done, else null.
 */
export function moveByHand(s: State, item: WorkItem, next: ItemStatus): 'qa' | 'done' | null {
  if (next === item.status) return null;
  if (next === 'qa') {
    item.history.push({ ts: now(), text: 'Moved to QA by you' });
    return sendToQa(s, item) === 'qa' ? 'qa' : null;
  }
  item.status = next;
  item.history.push({ ts: now(), text: `Moved to ${next} by you` });
  if (next === 'signoff') item.qa = { ...(item.qa ?? { fails: 0 }), ready: true };
  else if (next !== 'held') clearSignoff(item);
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
