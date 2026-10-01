import type { Message, Thread } from '../shared/types';

/**
 * A desk's chat run marks the thread read when it starts. If the run then dies (a server
 * restart, an error) before the desk said anything, put its read marker back, so Resume and the
 * next wake show it the same messages again. If the desk did post during the run, its reply
 * stands and nothing is rewound.
 */
export function rewindCursor(t: Thread, messages: Message[], agentId: string, cursorFrom: number | undefined, runStartedAt: string): boolean {
  if (cursorFrom === undefined) return false;
  const replied = messages.some((m) => m.threadId === t.id && m.from === agentId && m.ts >= runStartedAt);
  if (replied) return false;
  const now = t.cursor[agentId] ?? 0;
  if (cursorFrom >= now) return false;
  t.cursor[agentId] = cursorFrom;
  return true;
}
