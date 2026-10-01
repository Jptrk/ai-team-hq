import { useCallback } from 'react';
import type { Decision, ItemStatus, StateResponse } from '../../shared/types';
import { HUDDLE_KIND_LABEL } from '../../shared/huddle';
import { api, type AgentBody, type HuddleBody } from '../api';
import { agentById, ticketKey } from '../util';
import type { Notify } from './useFlags';

interface Opts {
  pid: string | null;
  state: StateResponse | null;
  notify: Notify;
  after: () => Promise<void>;
  openTicket: (key: string) => void;
  openThread: (threadId: string) => void;
  openHuddle: (huddleId: string) => void;
}

/** Everything that changes a project, with flags for the outcome. */
export function useProjectActions({ pid, state, notify, after, openTicket, openThread, openHuddle }: Opts) {
  const nameOf = useCallback((id: string) => (state ? agentById(state.agents, id)?.name : undefined) ?? id, [state]);

  const guard = useCallback(
    async (fn: () => Promise<unknown>, fallback: string) => {
      try {
        await fn();
      } catch (e) {
        notify(e instanceof Error ? e.message : fallback, { tone: 'danger' });
      }
    },
    [notify],
  );

  /** True once the server took the decision, false when it did not go through (the flag says why), so the note box can keep its draft. */
  const decide = useCallback(
    async (id: string, decision: Decision, note?: string, attachments: string[] = [], includeNotes = false): Promise<boolean> => {
      if (!pid || !state) return false;
      const item = state.items.find((i) => i.id === id);
      const owner = item ? nameOf(item.assignee) : 'the desk';
      // Finished and checked: approving signs it off.
      const signOff = decision === 'approve' && Boolean(item?.qa?.ready) && (item?.status === 'signoff' || item?.status === 'needs-you' || item?.status === 'held');
      let ok = false;
      await guard(async () => {
        const { run } = await api.decide(pid, id, decision, note, attachments, includeNotes);
        ok = true;
        const verb =
          signOff ? 'Marked done' : decision === 'approve' ? 'Approved' : decision === 'hold' ? 'On hold' : decision === 'send-back' ? `Sent back to ${owner}` : `Instruction sent to ${owner}`;
        notify(run ? `${verb}. ${owner} is on it.` : verb, { tone: decision === 'approve' ? 'success' : 'info' });
        await after();
      }, 'That did not go through');
      return ok;
    },
    [pid, state, guard, notify, after, nameOf],
  );

  const move = useCallback(
    async (id: string, status: ItemStatus) => {
      if (!pid) return;
      await guard(async () => {
        await api.move(pid, id, status);
        await after();
      }, 'Could not move that');
    },
    [pid, guard, after],
  );

  const runItem = useCallback(
    async (id: string) => {
      if (!pid) return;
      await guard(async () => {
        await api.run(pid, id);
        notify('Queued');
        await after();
      }, 'Could not start that');
    },
    [pid, guard, notify, after],
  );

  /** Throws so the Create dialog can keep its draft and show the error. */
  const instruct = useCallback(
    async (text: string, attachments: string[] = [], includeNotes = false) => {
      if (!pid || !state) return;
      const { item, run } = await api.instruct(pid, text, attachments, includeNotes);
      const key = ticketKey(item, state.project.key);
      notify(`${key} routed to ${nameOf(item.assignee)}${run ? ', working now' : ''}`, {
        tone: 'success',
        action: { label: 'View', onClick: () => openTicket(key) },
      });
      await after();
    },
    [pid, state, notify, after, nameOf, openTicket],
  );

  /** Throws so the caller can keep its draft. */
  const startThread = useCallback(
    async (text: string, itemId?: string, attachments: string[] = []) => {
      if (!pid) return;
      const res = await api.startThread(pid, { text, itemId, attachments });
      const names = res.woke.map(nameOf);
      openThread(res.thread.id);
      notify(names.length ? `Sent to ${names.join(', ')}` : 'Thread started', { tone: 'success' });
      await after();
    },
    [pid, notify, after, nameOf, openThread],
  );

  /** Throws so the comment box can keep its draft. */
  const comment = useCallback(
    async (itemId: string, text: string, attachments: string[] = [], includeNotes = false) => {
      if (!pid) return;
      const { item, run } = await api.comment(pid, itemId, text, attachments, includeNotes);
      const owner = nameOf(item.assignee);
      if (run) notify(`Comment sent. ${owner} will answer.`, { tone: 'success' });
      await after();
    },
    [pid, notify, after, nameOf],
  );

  /** Throws so the editor keeps the draft. Only To do tickets can be edited. */
  const editDescription = useCallback(
    async (itemId: string, summary: string) => {
      if (!pid) return;
      await api.editDescription(pid, itemId, summary);
      notify('Description saved', { tone: 'success' });
      await after();
    },
    [pid, notify, after],
  );

  /** Throws so the caller can show the error. */
  const attachToItem = useCallback(
    async (itemId: string, attachments: string[]) => {
      if (!pid || !attachments.length) return;
      await api.attachToItem(pid, itemId, attachments);
      notify(`Attached ${attachments.length} image${attachments.length === 1 ? '' : 's'}`, { tone: 'success' });
      await after();
    },
    [pid, notify, after],
  );

  const resumeThread = useCallback(
    async (id: string) => {
      if (!pid) return;
      await guard(async () => {
        const res = await api.resumeThread(pid, id);
        notify(res.woke.length ? 'Resumed. Delivering held messages.' : 'Resumed');
        await after();
      }, 'Could not resume');
    },
    [pid, guard, notify, after],
  );

  /** Throws so the add-teammate form can show the error. */
  const addAgent = useCallback(
    async (body: AgentBody) => {
      if (!pid) return;
      const agent = await api.addAgent(pid, body);
      notify(`${agent.name} joined the team`, { tone: 'success' });
      await after();
    },
    [pid, notify, after],
  );

  const setQaDesk = useCallback(
    async (id: string, on: boolean) => {
      if (!pid) return;
      await guard(async () => {
        const agent = await api.updateAgent(pid, id, { qa: on });
        notify(on ? `${agent.name} now checks finished tickets` : `${agent.name} stopped QA. Finished tickets come to you to sign off`);
        await after();
      }, 'Could not change the QA desk');
    },
    [pid, guard, notify, after],
  );

  const makeLead = useCallback(
    async (id: string) => {
      if (!pid) return;
      await guard(async () => {
        const agent = await api.updateAgent(pid, id, { lead: true });
        notify(`${agent.name} is now the lead`);
        await after();
      }, 'Could not change the lead');
    },
    [pid, guard, notify, after],
  );

  const removeAgent = useCallback(
    async (id: string, onDone?: () => void) => {
      if (!pid) return;
      await guard(async () => {
        const name = nameOf(id);
        await api.removeAgent(pid, id);
        onDone?.();
        notify(`${name} left the team`);
        await after();
      }, 'Could not remove');
    },
    [pid, guard, notify, after, nameOf],
  );

  /** Throws so the setup form keeps what you typed. */
  const startHuddle = useCallback(
    async (body: HuddleBody) => {
      if (!pid) return;
      const h = await api.startHuddle(pid, body);
      notify(`${HUDDLE_KIND_LABEL[h.kind]} #${h.number} started`, { tone: 'success' });
      // Load it first, so its page never flashes "Huddle not found".
      await after();
      openHuddle(h.id);
    },
    [pid, notify, after, openHuddle],
  );

  const stopHuddle = useCallback(
    async (id: string) => {
      if (!pid) return;
      await guard(async () => {
        await api.stopHuddle(pid, id);
        notify('Huddle stopped. Resume picks it up where it left off.');
        await after();
      }, 'Could not stop the huddle');
    },
    [pid, guard, notify, after],
  );

  const resumeHuddle = useCallback(
    async (id: string) => {
      if (!pid) return;
      await guard(async () => {
        await api.resumeHuddle(pid, id);
        notify('Huddle resumed');
        await after();
      }, 'Could not resume the huddle');
    },
    [pid, guard, notify, after],
  );

  /** Throws so the box keeps its draft. */
  const steerHuddle = useCallback(
    async (id: string, text: string) => {
      if (!pid) return;
      await api.steerHuddle(pid, id, text);
      await after();
    },
    [pid, after],
  );

  const decideProposal = useCallback(
    async (huddleId: string, proposalId: string, decision: 'approve' | 'decline') => {
      if (!pid || !state) return;
      await guard(async () => {
        const { proposal, item } = await api.decideProposal(pid, huddleId, proposalId, decision);
        if (decision === 'decline') notify('Declined');
        else if (item) {
          const key = ticketKey(item, state.project.key);
          notify(`${key} added to To do for ${nameOf(item.assignee)}`, { tone: 'success', action: { label: 'View', onClick: () => openTicket(key) } });
        } else notify(proposal.type === 'note' ? 'Added to the team notes' : 'Approved', { tone: 'success' });
        await after();
      }, 'That did not go through');
    },
    [pid, state, guard, notify, after, nameOf, openTicket],
  );

  /** Throws so the notes editor keeps the draft. */
  const saveTeamNotes = useCallback(
    async (body: { teamNotes?: string; notesEveryRun?: boolean; base?: string }) => {
      if (!pid) return;
      await api.saveTeamNotes(pid, body);
      notify('teamNotes' in body ? 'Team notes saved' : body.notesEveryRun ? 'Team notes now go into every run' : 'Team notes only go in when you tick the box', { tone: 'success' });
      await after();
    },
    [pid, notify, after],
  );

  return {
    decide,
    move,
    runItem,
    instruct,
    startThread,
    comment,
    attachToItem,
    editDescription,
    resumeThread,
    addAgent,
    makeLead,
    setQaDesk,
    removeAgent,
    guard,
    startHuddle,
    stopHuddle,
    resumeHuddle,
    steerHuddle,
    decideProposal,
    saveTeamNotes,
  };
}

export type ProjectActions = ReturnType<typeof useProjectActions>;
