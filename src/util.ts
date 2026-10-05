import type { Agent, AgentStatus, AutoHold, AutoStatus, Comment, EffortLevel, ItemStatus, Meta, PauseInfo, RunReason, WorkItem } from '../shared/types';

/** "15:00" in your time, or "Mon 09:00" when it is not today (a weekly limit). 24-hour, as the server's own texts. */
export function clockTime(iso: string, nowMs = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date(nowMs).toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

const HOLD_START: Partial<Record<RunReason, string>> = { handoff: 'The hand-off', qa: 'The QA check', 'qa-fail': 'The fix after QA', auto: "Autopilot's start" };
const HOLD_WHY: Record<Exclude<AutoHold['why'], 'restart'>, string> = {
  paused: 'HQ is paused',
  usage: "Claude's usage limit was reached",
  account: 'Claude reported an account problem',
  halted: 'Autopilot stopped in this project',
  runs: "this project's runs for today are used up",
  usd: "this project's spend for today is used up",
};

/** The board's count of what the team started on its own today. */
export function autoTodayText(t: Pick<AutoStatus['today'], 'runs' | 'maxRuns' | 'usd' | 'maxUsd'>): string {
  return `Today ${t.runs}/${t.maxRuns} runs · $${t.usd.toFixed(2)} of $${t.maxUsd}`;
}

/** The goal strip's status chip: planning wins while a plan is queued or running. */
export function goalLabel(g: Pick<NonNullable<AutoStatus['goal']>, 'status' | 'planning'>): string {
  if (g.planning) return 'Planning…';
  return { 'on-track': 'On track', reached: 'Reached?', blocked: 'Blocked', stalled: 'Stalled' }[g.status];
}

/** What a held start on a ticket waits for. */
export function holdText(h: Pick<AutoHold, 'reason' | 'why'>): string {
  const what = HOLD_START[h.reason] ?? 'A run';
  if (h.why === 'restart') return `${what} was cut off by a server restart. It starts again by itself.`;
  return `${what} waits: ${HOLD_WHY[h.why]}. It starts by itself once that clears.`;
}

/** The header's paused control, in a few words. */
export function pauseLabel(p: Pick<PauseInfo, 'by' | 'until'>): string {
  if (p.by === 'you') return 'Paused';
  if (p.by === 'account') return 'Account problem';
  return p.until ? `Usage limit · until ${clockTime(p.until)}` : 'Usage limit';
}

/** What the pause means, for its popover and the banner. */
export function pauseText(p: Pick<PauseInfo, 'by' | 'until' | 'reason'>): string {
  if (p.by === 'you') return 'The team starts nothing on its own: no hand-offs, chat replies between desks or QA checks. Your own clicks still work, and runs already going finish.';
  if (p.by === 'account') return `${p.reason ?? 'Claude reported an account problem.'} Nothing the team starts on its own runs until you resume.`;
  return `${p.reason ?? "Claude's usage limit was reached."} Nothing the team starts on its own runs until then${p.until ? `; it carries on by itself at ${clockTime(p.until)}` : ''}.`;
}

export const EFFORT_LABEL: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** The header pill: Sim, or Live with the model. */
export function runnerLabel(meta: Pick<Meta, 'runner' | 'model'>): string {
  return meta.runner === 'claude' ? `Live · ${meta.model}` : 'Sim';
}

/** The pill's effort part, live with a level set; wide windows only. */
export function effortLabel(meta: Pick<Meta, 'runner' | 'effort'>): string {
  return meta.runner === 'claude' && meta.effort ? ` · ${EFFORT_LABEL[meta.effort].toLowerCase()} effort` : '';
}

export function agentById(agents: Agent[], id: string): Agent | undefined {
  return agents.find((a) => a.id === id);
}

export function timeAgo(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** The latest decision a desk asked for on this ticket. Older tickets have none and use the summary. */
export function latestDecision(item: WorkItem): Comment | undefined {
  return [...(item.comments ?? [])].reverse().find((c) => c.kind === 'decision');
}

/** The QA desk's latest verdict on a ticket. */
export function latestQa(item: WorkItem): Comment | undefined {
  return [...(item.comments ?? [])].reverse().find((c) => c.kind === 'qa');
}

/** Finished work waiting for your sign-off, in Sign-off or held there. A held ticket QA gave up on is a decision instead. */
export function awaitsSignoff(item: WorkItem): boolean {
  return item.status === 'signoff' || (item.status === 'held' && Boolean(item.qa?.ready) && !item.qa?.escalated);
}

/** QA's pass on a ticket waiting for your sign-off (held too), only when QA checked it this round. An earlier round's verdict never shows. */
export function signoffVerdict(item: WorkItem): Comment | undefined {
  return awaitsSignoff(item) && item.qa?.result === 'pass' ? latestQa(item) : undefined;
}

/** What the owner said when it last finished the ticket, from its history. */
export function doneSummary(item: WorkItem): string | undefined {
  const done = [...item.history].reverse().find((h) => h.text.startsWith('Done: '));
  return done?.text.slice(6);
}

/** The headline over a ticket that waits on you: a sign-off (QA passed it or not, held or not), a hold, QA giving up, or a decision. */
export function waitingTitle(item: WorkItem, checker?: string): string {
  if (awaitsSignoff(item)) {
    if (item.status === 'held') return 'On hold: finished, waiting for your sign-off';
    return signoffVerdict(item) ? `Passed QA${checker ? ` (${checker})` : ''}. Sign it off` : 'Finished. Check it and sign it off';
  }
  if (item.status === 'held') return 'On hold. Decide when ready';
  return item.qa?.escalated ? 'Failed QA too often. Your call' : 'Needs your decision';
}

/**
 * One line on a ticket in Needs you. A sign-off (held too) shows QA's pass from this round, or what the owner
 * said it finished; a decision shows the desk's ask; anything else its description.
 */
export function waitingSummary(item: WorkItem): string {
  const signoff = awaitsSignoff(item);
  const ask = signoff ? signoffVerdict(item) : latestDecision(item);
  if (ask) return `${ask.title ? `${ask.title}. ` : ''}${ask.text}`;
  if (signoff) return `${item.status === 'held' ? 'Finished, waiting for your sign-off.' : 'Finished. Check it and sign it off.'} ${doneSummary(item) ?? item.summary}`;
  return item.summary;
}

/** GA-12 style ticket reference. */
export function ticketKey(item: { number?: number; id: string }, projectKey: string): string {
  return item.number ? `${projectKey}-${item.number}` : item.id;
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** Strip the quotes Windows "Copy as path" adds. */
export function cleanPath(raw: string): string {
  return raw.trim().replace(/^["']+|["']+$/g, '').trim();
}

/** Same rule as the server: initials for multi-word names, first letters otherwise. */
export function suggestKey(name: string, taken: string[]): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  let key = words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 4);
  key = key.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!key) return '';
  if (!/^[A-Z]/.test(key)) key = `P${key}`;
  if (key.length < 2) key = `${key}PR`.slice(0, 3);
  const used = new Set(taken.map((k) => k.toUpperCase()));
  if (!used.has(key)) return key;
  for (let n = 2; n < 100; n++) {
    const next = `${key.slice(0, 8)}${n}`;
    if (!used.has(next)) return next;
  }
  return key;
}

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'working',
  waiting: 'waiting on you',
  idle: 'idle',
  off: 'off shift',
};

/** Theme-aware: these resolve through the design tokens. */
export const AGENT_STATUS_COLOR: Record<AgentStatus, string> = {
  working: 'var(--status-working)',
  waiting: 'var(--status-waiting)',
  idle: 'var(--status-idle)',
  off: 'var(--status-off)',
};

export const RUNNING_COLOR = 'var(--status-working)';
export const AVATAR_FALLBACK = 'var(--avatar-fallback)';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'accent' | 'danger';

export const ITEM_STATUS_TONE: Record<ItemStatus, Tone> = {
  todo: 'neutral',
  'in-progress': 'info',
  'sent-back': 'info',
  'needs-you': 'accent',
  held: 'warning',
  approved: 'success',
  qa: 'info',
  signoff: 'accent',
  done: 'success',
};

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** White or near-black text, whichever reads better on a data color (agent and project colors). */
export function readableInk(bg: string): string {
  const l = luminance(bg);
  if (l === null) return '#ffffff';
  const onWhite = 1.05 / (l + 0.05);
  if (onWhite >= 4.5) return '#ffffff';
  // #1f2018 (the dark theme surface) where it reads well; mid-tone colors need pure black to reach 4.5:1.
  const onInk = (l + 0.05) / ((luminance('#1f2018') ?? 0) + 0.05);
  if (onInk >= 4.5) return '#1f2018';
  return (l + 0.05) / 0.05 >= onWhite ? '#000000' : '#ffffff';
}

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  todo: 'to do',
  'in-progress': 'in progress',
  'needs-you': 'needs you',
  approved: 'approved',
  held: 'on hold',
  'sent-back': 'sent back',
  qa: 'in QA',
  signoff: 'sign-off',
  done: 'done',
};

export const AGENT_ORDER: Record<AgentStatus, number> = { waiting: 0, working: 1, idle: 2, off: 3 };
