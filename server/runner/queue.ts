/**
 * Serial queue per desk with a global concurrency cap.
 * One desk never runs two tasks at once; at most HQ_CONCURRENCY desks run in parallel across all projects.
 * Keys are "<project>:<agent>" so the same agent id in two projects gets two queues.
 */

export const CONCURRENCY = Math.max(1, Number(process.env.HQ_CONCURRENCY ?? 2));

const chains = new Map<string, Promise<void>>();
let active = 0;
// Two lines for a free slot, each first come, first served: yours goes before the team's.
const waitingFirst: (() => void)[] = [];
const waiting: (() => void)[] = [];

async function acquire(first: boolean): Promise<void> {
  if (active < CONCURRENCY) {
    active += 1;
    return;
  }
  // The releasing job hands its slot straight to us, so `active` does not change here.
  await new Promise<void>((resolve) => (first ? waitingFirst : waiting).push(resolve));
}

function release(): void {
  const next = waitingFirst.shift() ?? waiting.shift();
  if (next) next();
  else active -= 1;
}

export interface EnqueueOptions {
  /** Checked when the job's turn on its desk comes, before it takes a slot: true drops it (it was held or cancelled meanwhile). */
  skip?: () => boolean;
  /** Your own runs wait ahead of the team's for a free slot. */
  first?: boolean;
}

export function enqueue(key: string, job: () => Promise<void>, opts: EnqueueOptions = {}): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      // A dead job never waits for a slot, so a desk's next job (yours) is not stuck behind it.
      if (opts.skip?.()) return;
      await acquire(Boolean(opts.first));
      try {
        await job();
      } finally {
        release();
      }
    });
  chains.set(key, next);
  return next;
}

export function queueDepth(): { active: number; waiting: number } {
  return { active, waiting: waitingFirst.length + waiting.length };
}
