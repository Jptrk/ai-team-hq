/**
 * Serial queue per desk with a global concurrency cap.
 * One desk never runs two tasks at once; at most HQ_CONCURRENCY desks run in parallel across all projects.
 * Keys are "<project>:<agent>" so the same agent id in two projects gets two queues.
 */

const MAX = Math.max(1, Number(process.env.HQ_CONCURRENCY ?? 2));

const chains = new Map<string, Promise<void>>();
let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX) {
    active += 1;
    return;
  }
  // The releasing job hands its slot straight to us, so `active` does not change here.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

export function enqueue(key: string, job: () => Promise<void>): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await acquire();
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
  return { active, waiting: waiting.length };
}
