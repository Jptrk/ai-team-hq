import type { Agent, AgentStatus, Comment, ItemStatus, WorkItem } from '../shared/types';

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
  done: 'done',
};

export const AGENT_ORDER: Record<AgentStatus, number> = { waiting: 0, working: 1, idle: 2, off: 3 };
