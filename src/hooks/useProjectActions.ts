import { useCallback } from 'react';
import type { Decision, ItemStatus, StateResponse } from '../../shared/types';
import { api, type AgentBody } from '../api';
import { agentById, ticketKey } from '../util';
import type { Notify } from './useFlags';

interface Opts {
  pid: string | null;
  state: StateResponse | null;
  notify: Notify;
  after: () => Promise<void>;
  openTicket: (key: string) => void;
  openThread: (threadId: string) => void;
}

/** Everything that changes a project, with flags for the outcome. */
export function useProjectActions({ pid, state, notify, after, openTicket, openThread }: Opts) {
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

  const decide = useCallback(
    async (id: string, decision: Decision, note?: string) => {
      if (!pid || !state) return;
      const item = state.items.find((i) => i.id === id);
      const owner = item ? nameOf(item.assignee) : 'the desk';
      await guard(async () => {
        const { run } = await api.decide(pid, id, decision, note);
        const verb =
          decision === 'approve' ? 'Approved' : decision === 'hold' ? 'On hold' : decision === 'send-back' ? `Sent back to ${owner}` : `Instruction sent to ${owner}`;
        notify(run ? `${verb}. ${owner} is on it.` : verb, { tone: decision === 'approve' ? 'success' : 'info' });
        await after();
      }, 'That did not go through');
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
    async (text: string) => {
      if (!pid || !state) return;
      const { item, run } = await api.instruct(pid, text);
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
    async (text: string, itemId?: string) => {
      if (!pid) return;
      const res = await api.startThread(pid, { text, itemId });
      const names = res.woke.map(nameOf);
      openThread(res.thread.id);
      notify(names.length ? `Sent to ${names.join(', ')}` : 'Thread started', { tone: 'success' });
      await after();
    },
    [pid, notify, after, nameOf, openThread],
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

  return { decide, move, runItem, instruct, startThread, resumeThread, addAgent, makeLead, removeAgent, guard };
}

export type ProjectActions = ReturnType<typeof useProjectActions>;
