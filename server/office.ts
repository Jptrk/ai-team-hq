import { deriveActivities, startsFrom, withSince, type AgentActivity, type ToolKind } from '../shared/activity';
import { isIdle, isLive } from './runner';
import { lastTools } from './runner/liveTools';
import { now, type Project } from './store';

/**
 * What each desk is doing right now, for the Office view. Worked out on every poll and never saved;
 * only "since" is remembered between polls, in memory, so the hover card can say "for 12m".
 */

const previous = new Map<string, Record<string, AgentActivity>>();

/** The sim has no live runs, so it splits busy desks into coding and working by their task, steadily. */
function simTools(p: Project): Record<string, ToolKind> {
  const out: Record<string, ToolKind> = {};
  for (const a of p.state.agents) {
    if (a.isHuman || a.status !== 'working' || !a.currentTask) continue;
    let h = 0;
    for (const ch of a.id + a.currentTask) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    out[`sim:${a.id}`] = h % 2 === 0 ? 'code' : 'other';
  }
  return out;
}

export function officeState(p: Project): Record<string, AgentActivity> {
  const s = p.state;
  const running = new Set(s.runs.filter((r) => r.status === 'running').map((r) => r.id));
  const input = { agents: s.agents, items: s.items, runs: s.runs, threads: s.threads, huddles: s.huddles, lastTool: lastTools(running) };
  const derived = deriveActivities(input);
  if (!isLive() && !isIdle()) {
    const sim = simTools(p);
    for (const [id, d] of Object.entries(derived)) if (d.activity === 'working' && sim[`sim:${id}`] === 'code') d.activity = 'coding';
  }
  const next = withSince(derived, previous.get(p.id), now(), s.items, startsFrom(input));
  previous.set(p.id, next);
  return next;
}
