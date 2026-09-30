import type { Agent, Message, Run, RunReason, RunnerName, Thread, WorkItem } from '../../shared/types';
import type { Project } from '../store';

/** Passed in by the queue so the runner can wake desks without importing it (no cycle). */
export interface RunHooks {
  deliver(threadId: string, ids: string[]): void;
  kickoff(itemId: string, reason: RunReason): void;
}

export interface RunInput {
  project: Project;
  run: Run;
  agent: Agent;
  /** The ticket: owned by the desk for ticket runs; the thread's ticket for message runs. */
  item?: WorkItem;
  reason: RunReason;
  /** Founder's note attached to a send-back or instruct decision. */
  note?: string;
  /** Message runs: the thread that woke the desk. Ticket runs: the ticket's thread, if any. */
  thread?: Thread;
  /** Message runs: every message the desk had not seen yet. */
  unread?: Message[];
  hooks: RunHooks;
}

export interface RunOutcome {
  summary: string;
  costUsd: number;
  turns: number;
  sessionId?: string;
}

export interface AgentRunner {
  name: RunnerName;
  run(input: RunInput, signal: AbortSignal): Promise<RunOutcome>;
}
