import type { Agent, HuddleSummary } from '../../../shared/types';
import { agentById, type Tone } from '../../util';

/** How a huddle is doing, in words: a lozenge and one line for the list and the detail view. */
export function huddleStatus(h: HuddleSummary, agents: Agent[]): { label: string; tone: Tone; detail: string } {
  const name = (id: string) => agentById(agents, id)?.name ?? id;
  const round = `Round ${h.round} of ${h.rounds}`;
  if (h.status === 'running') {
    if (h.phase === 'summarize') return { label: 'Running', tone: 'info', detail: `${round}: ${name(h.facilitator)} is summing up` };
    const left = h.waiting.map(name);
    return { label: 'Running', tone: 'info', detail: left.length ? `${round}: waiting on ${left.join(', ')}` : `${round}: wrapping up` };
  }
  if (h.status === 'stopped') {
    const why = h.stopReason === 'restart' ? 'a server restart stopped it' : h.stopReason === 'failed' ? 'a desk run failed' : 'you stopped it';
    return { label: 'Stopped', tone: 'warning', detail: `${round}: ${why}` };
  }
  const pending = h.proposals.filter((p) => p.status === 'pending').length;
  return {
    label: 'Done',
    tone: 'success',
    detail: pending ? `${pending} proposal${pending === 1 ? '' : 's'} waiting for you` : `${h.rounds} round${h.rounds === 1 ? '' : 's'}, all wrapped up`,
  };
}
