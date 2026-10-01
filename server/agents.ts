import type { Agent, Attachment, Instruction, State, WorkItem } from '../shared/types';
import { MAX_TEAM } from '../shared/types';
import { titleFrom } from '../shared/plainText';
import { slug } from './paths';
import { AGENT_COLORS, assignSeats } from './seed';
import { now, today, uid, type Project } from './store';

/** The desk that catches instructions nobody else matches. */
export function leadOf(agents: Agent[]): Agent | undefined {
  return agents.find((a) => a.lead && !a.isHuman) ?? agents.find((a) => !a.isHuman && a.status !== 'off') ?? agents.find((a) => !a.isHuman);
}

/** Every desk @mentioned in the text, in order, without repeats. Instructions and chat share this. */
export function mentionsIn(text: string, pool: Agent[]): Agent[] {
  const hits: Agent[] = [];
  for (const m of text.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
    const handle = m[1].toLowerCase();
    const hit = pool.find((a) => a.name.toLowerCase() === handle || a.id === handle);
    if (hit && !hits.includes(hit)) hits.push(hit);
  }
  return hits;
}

/** "@Leo fix the header" goes straight to Leo. */
function mentioned(text: string, pool: Agent[]): Agent | undefined {
  return mentionsIn(text, pool)[0];
}

/** Pick a desk: @mention first, then best skill match, then the lead. */
export function routeInstruction(text: string, agents: Agent[]): { agent: Agent; direct: boolean } | null {
  const pool = agents.filter((a) => !a.isHuman);
  if (pool.length === 0) return null;
  const direct = mentioned(text, pool);
  if (direct) return { agent: direct, direct: true };

  const words = new Set(text.toLowerCase().match(/[a-z0-9-]+/g) ?? []);
  let best: Agent | null = null;
  let bestScore = 0;
  for (const a of pool) {
    if (a.status === 'off') continue;
    const score = a.skills.reduce((n, skill) => n + (words.has(skill) ? 1 : 0), 0);
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  return { agent: best ?? leadOf(agents) ?? pool[0], direct: false };
}

/** Turn a free-text instruction into an in-progress ticket owned by a desk. Null when the team has no agents. */
export function acceptInstruction(p: Project, text: string, attachments: Attachment[] = []): { instruction: Instruction; item: WorkItem } | null {
  const s = p.state;
  const routed = routeInstruction(text, s.agents);
  if (!routed) return null;
  const { agent, direct } = routed;
  const lead = leadOf(s.agents);
  // Titles are plain text everywhere (cards, inbox, search), so formatting and code blocks are stripped.
  const title = titleFrom(text, attachments.length, 80);

  const item: WorkItem = {
    id: uid('wi'),
    number: p.nextNumber(),
    kind: 'fyi',
    status: 'in-progress',
    title,
    summary: text,
    client: 'From your inbox',
    from: 'you',
    assignee: agent.id,
    dated: today(),
    links: [],
    ...(attachments.length ? { attachments } : {}),
    history: [
      {
        ts: now(),
        text: direct
          ? `Sent straight to ${agent.name}`
          : lead && lead.id === agent.id
            ? `No desk matched; ${agent.name} (lead) took it`
            : `Routed to ${agent.name} by ${lead?.name ?? 'the lead'}`,
      },
    ],
  };
  const instruction: Instruction = {
    id: uid('ins'),
    text,
    createdAt: now(),
    status: 'assigned',
    assignedTo: agent.id,
    itemId: item.id,
    ...(attachments.length ? { attachments } : {}),
  };

  s.items.unshift(item);
  s.instructions.unshift(instruction);
  agent.currentTask = title;
  agent.lastActive = now();
  const ref = p.ticket(item);
  if (!direct && lead && lead.id !== agent.id) p.log(lead.id, `Routed ${ref} "${title}" to ${agent.name}`);
  p.log(agent.id, `Picked up ${ref} "${title}"`);
  refreshStatuses(s);
  p.commit();
  return { instruction, item };
}

/** Derive each agent's status from the work they own. Humans and off-shift agents keep theirs. */
export function refreshStatuses(s: State): void {
  for (const a of s.agents) {
    if (a.isHuman || a.status === 'off') continue;
    const mine = s.items.filter((i) => i.assignee === a.id);
    if (mine.some((i) => i.status === 'needs-you')) a.status = 'waiting';
    else if (mine.some((i) => i.status === 'in-progress' || i.status === 'sent-back' || i.status === 'approved')) a.status = 'working';
    else if (mine.some((i) => i.status === 'todo')) a.status = 'working';
    else a.status = 'idle';
  }
}

/** Mark an instruction done once its item is done. Approved is not done yet: the desk is still carrying it out. */
export function settleInstructions(s: State): void {
  for (const ins of s.instructions) {
    if (ins.status === 'done' || !ins.itemId) continue;
    const item = s.items.find((i) => i.id === ins.itemId);
    if (item && item.status === 'done') ins.status = 'done';
  }
}

export function parseSkills(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '';
  return [...new Set(text.toLowerCase().split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /^[a-z0-9-]{2,30}$/.test(s)))].slice(0, 30);
}

export interface NewAgent {
  name: string;
  role: string;
  skills: string[];
  lead?: boolean;
}

export function addAgent(p: Project, input: NewAgent): Agent | string {
  const s = p.state;
  if (s.agents.length >= MAX_TEAM) return `The office has ${MAX_TEAM} desks. Remove someone first.`;
  const base = slug(input.name) || 'agent';
  let id = base;
  for (let n = 2; id === 'you' || s.agents.some((a) => a.id === id); n++) id = `${base}-${n}`;
  const used = new Set(s.agents.map((a) => a.color));
  const agent: Agent = {
    id,
    name: input.name,
    role: input.role,
    desk: `${input.role} desk`,
    status: 'idle',
    color: AGENT_COLORS.find((c) => !used.has(c)) ?? AGENT_COLORS[s.agents.length % AGENT_COLORS.length],
    seat: { col: -1, row: -1 },
    currentTask: 'Waiting for the first instruction',
    lastActive: now(),
    skills: input.skills,
  };
  if (input.lead) for (const a of s.agents) a.lead = false;
  agent.lead = input.lead || !s.agents.some((a) => a.lead && !a.isHuman) || undefined;
  s.agents.push(agent);
  assignSeats(s.agents);
  p.log(agent.id, `${agent.name} joined as ${agent.role}`);
  p.commit();
  return agent;
}

/** Remove a desk. Their open tickets go to the lead. Their workspace folder stays on disk. */
export function removeAgent(p: Project, id: string): string | null {
  const s = p.state;
  const agent = s.agents.find((a) => a.id === id);
  if (!agent) return 'agent not found';
  if (agent.isHuman) return 'You cannot remove yourself';
  if (agent.running) return `${agent.name} is running. Wait for the run to finish.`;

  s.agents = s.agents.filter((a) => a.id !== id);
  for (const c of s.connections) c.desks = c.desks.filter((d) => d !== id);
  for (const t of s.threads) t.waiting = t.waiting.filter((w) => w !== id);
  if (agent.lead) {
    const next = s.agents.find((a) => !a.isHuman);
    if (next) next.lead = true;
  }
  const heir = leadOf(s.agents);
  let moved = 0;
  for (const item of s.items) {
    if (item.assignee !== id || item.status === 'done') continue;
    item.assignee = heir?.id ?? 'you';
    item.history.push({ ts: now(), text: `${agent.name} left the team; moved to ${heir?.name ?? 'you'}` });
    moved++;
  }
  p.log(heir?.id ?? 'you', `${agent.name} left the team${moved ? `; ${moved} open ticket${moved === 1 ? '' : 's'} moved to ${heir?.name ?? 'you'}` : ''}`);
  refreshStatuses(s);
  p.commit();
  return null;
}
