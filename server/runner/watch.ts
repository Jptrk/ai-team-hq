/**
 * When a desk run is stopped, and why, in words the founder can act on.
 *
 * A run is not stopped for taking long, only for going quiet: every message from Claude restarts the clock. A desk
 * driving Blender or a design tool can work for half an hour, one tool call a minute, and that is fine. What is not
 * fine is nothing at all for minutes on end. A hard cap still ends any run, however busy.
 */

/** Limits for one run, in milliseconds. */
export interface WatchLimits {
  /** Nothing from Claude for this long, with no tool call waiting: stopped. */
  idleMs: number;
  /** Nothing from Claude for this long while a tool call waits for its result (a long script, a slow app): stopped. */
  toolIdleMs: number;
  /** The whole run, however busy. */
  capMs: number;
}

/** A whole number of milliseconds from the environment; junk or nothing gives the fallback. */
function ms(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): WatchLimits {
  return {
    idleMs: ms(env.HQ_RUN_IDLE_MS, 8 * 60_000),
    toolIdleMs: ms(env.HQ_TOOL_IDLE_MS, 20 * 60_000),
    capMs: ms(env.HQ_RUN_TIMEOUT_MS, 40 * 60_000),
  };
}

/** How long one connection tool call may take (HQ_MCP_TOOL_TIMEOUT_MS, 15 minutes). An explicit 0 leaves it to Claude Code. */
export function mcpToolTimeoutFromEnv(v: string | undefined): number {
  if (v !== undefined && v.trim() !== '' && Number(v) === 0) return 0;
  return ms(v, 15 * 60_000);
}

/** Limits that undo the point of the watch, said once at startup. HQ_RUN_TIMEOUT_MS used to be the only limit, at 10 minutes. */
export function limitsWarning(limits: WatchLimits): string | null {
  if (limits.capMs <= 10 * 60_000 || limits.capMs < limits.toolIdleMs) {
    return `HQ_RUN_TIMEOUT_MS is ${duration(limits.capMs)}: that caps every run, however busy, before a quiet tool call (HQ_TOOL_IDLE_MS, ${duration(limits.toolIdleMs)}) would stop it. Raise it or remove it from .env (default 40 minutes).`;
  }
  return null;
}

/** "8 minutes", "1 minute", "45 seconds". */
export function duration(ms: number): string {
  if (ms < 60_000) {
    const s = Math.max(1, Math.round(ms / 1000));
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  const m = Math.round(ms / 60_000);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** Why a run was stopped. Never words the retry checks look for (budget, session, too large, image). */
export const stopText = {
  idle: (ms: number) => `Stopped: no progress for ${duration(ms)} (HQ_RUN_IDLE_MS)`,
  tool: (ms: number) => `Stopped: a tool call gave no result for ${duration(ms)} (HQ_TOOL_IDLE_MS)`,
  cap: (ms: number) => `Stopped after ${duration(ms)}, the most one run may take (HQ_RUN_TIMEOUT_MS)`,
  you: 'Stopped by you',
};

/**
 * Watches one attempt. touch() on every message from Claude, with the tool calls it starts and finishes; the clock
 * starts again each time. The cap is fixed when the watch starts and no message moves it. Exported for tests.
 */
export class RunWatch {
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private capTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Set<string>();
  /** Why the watch stopped the run, once it has. */
  why: string | null = null;

  /** capMs is what is left of the run's cap: a retry gets only the time the first attempt did not use. */
  constructor(
    private readonly limits: WatchLimits,
    capMs: number,
    private readonly stop: () => void,
  ) {
    this.capTimer = setTimeout(() => this.fire(stopText.cap(limits.capMs)), Math.max(0, capMs));
    this.arm();
  }

  /** A message came from Claude: note the tool calls it started and finished, then start the clock again. */
  touch(started: Iterable<string> = [], finished: Iterable<string> = []): void {
    if (this.why) return;
    for (const id of started) this.pending.add(id);
    for (const id of finished) this.pending.delete(id);
    this.arm();
  }

  /** Tool calls still waiting for a result. */
  get waiting(): number {
    return this.pending.size;
  }

  /** Stops the clocks. Call once the attempt is over, however it ended. */
  clear(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.capTimer) clearTimeout(this.capTimer);
    this.idleTimer = this.capTimer = undefined;
  }

  private arm(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const tool = this.pending.size > 0;
    const ms = tool ? this.limits.toolIdleMs : this.limits.idleMs;
    this.idleTimer = setTimeout(() => this.fire(tool ? stopText.tool(ms) : stopText.idle(ms)), ms);
  }

  private fire(why: string): void {
    if (this.why) return;
    this.why = why;
    this.clear();
    this.stop();
  }
}

/** Claude refused because of a usage limit or an account problem. until: when a usage limit resets, if Claude said. */
export interface UsageLimit {
  kind: 'usage' | 'account';
  until?: string;
  text: string;
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'weekly Opus limit',
  seven_day_sonnet: 'weekly Sonnet limit',
  seven_day_overage_included: 'weekly limit',
  overage: 'extra usage limit',
};

const ACCOUNT_ERRORS: Record<string, string> = {
  authentication_failed: "Claude login failed. Sign in again on HQ's Claude account page, then press Resume.",
  oauth_org_not_allowed: "This Claude login's organization is not allowed here.",
  account_on_hold: 'The Claude account is on hold.',
  verification_required: 'The Claude account needs verifying.',
  billing_error: 'Claude reported a billing problem.',
};

/** "15:00" in this machine's time, or "Mon 09:00" when it is not today (a weekly limit). */
function clock(d: Date, nowMs = Date.now()): string {
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date(nowMs).toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  isUsingOverage?: boolean;
  overageStatus?: string;
}

/**
 * A usage limit or account problem in one SDK message, or null. Reads the subscription's rate_limit_event (rejected,
 * with when it resets) and the account errors an assistant message carries. Not a limit: a rejection that extra usage
 * covers (Claude carries on), and a bare rate_limit error, which is plain throttling unless an event said the quota
 * ran out. Exported for tests.
 */
export function usageLimitOf(msg: unknown, nowMs = Date.now()): UsageLimit | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as { type?: string; error?: string; rate_limit_info?: RateLimitInfo };
  if (m.type === 'rate_limit_event') {
    const info = m.rate_limit_info;
    if (info?.status !== 'rejected') return null;
    if (info.isUsingOverage === true || info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning') return null;
    const name = (info.rateLimitType && LIMIT_NAMES[info.rateLimitType]) || 'usage limit';
    // Seconds or milliseconds since 1970; anything in the past is no reset time at all.
    const at = typeof info.resetsAt === 'number' && info.resetsAt > 0 ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : undefined;
    const until = at && at > nowMs ? new Date(at) : undefined;
    return { kind: 'usage', until: until?.toISOString(), text: `Claude's ${name} reached.${until ? ` It resets at ${clock(until, nowMs)}.` : ''}` };
  }
  if (m.type === 'assistant' && typeof m.error === 'string') {
    const account = ACCOUNT_ERRORS[m.error];
    if (account) return { kind: 'account', text: account };
  }
  return null;
}

/**
 * The limit that explains this attempt after one more message. A rate_limit_event replaces it (a later allowed one
 * clears it); an account problem sets it; nothing else touches it, so the precise limit with its reset time is kept.
 */
export function nextUsage(current: UsageLimit | undefined, msg: unknown, nowMs = Date.now()): UsageLimit | undefined {
  const limit = usageLimitOf(msg, nowMs);
  if ((msg as { type?: string } | null)?.type === 'rate_limit_event') return limit ?? undefined;
  return limit ?? current;
}

/**
 * Why an attempt failed, in words: HQ's watch, your Stop, or Claude's limit, instead of the SDK's "Operation aborted".
 * Out of budget or turns keeps its own words: the retry checks read them, and they are the real cause.
 * usage comes back only when it is the reason. Exported for tests.
 */
export function explainFailure(message: string, why: { watch: string | null; stopped: boolean; usage?: UsageLimit }): { text: string; usage?: UsageLimit } {
  if (why.watch) return { text: why.watch };
  if (why.stopped) return { text: stopText.you };
  if (why.usage && !/maximum budget|maximum number of turns|error_max_/i.test(message)) return { text: why.usage.text, usage: why.usage };
  return { text: message };
}
