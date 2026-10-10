/**
 * HQ's limits: how far desks go on their own before HQ stops a run or waits for you. For every project.
 *
 * Each limit has HQ's default, can be set in .env (its `env` name), and can be set on the Accounts page.
 * Yours from the Accounts page wins, then .env, then the default. Server and page read the same list.
 */

export const LIMIT_GROUPS = ['chat', 'team', 'claude', 'gpt', 'time'] as const;
export type LimitGroup = (typeof LIMIT_GROUPS)[number];

/** count: a whole number. usd: dollars, to the cent. ms: a time, kept in milliseconds and shown in minutes. */
export type LimitUnit = 'count' | 'usd' | 'ms';

export interface LimitSpec {
  env: string;
  group: LimitGroup;
  label: string;
  hint: string;
  unit: LimitUnit;
  default: number;
  min: number;
  max: number;
}

const MIN = 60_000;

export const LIMITS = {
  chatHops: {
    env: 'HQ_CHAT_HOP_LIMIT',
    group: 'chat',
    label: 'Desk-to-desk messages per thread',
    hint: 'A thread pauses after this many messages between desks, until you reply or resume. Your message starts the count again.',
    unit: 'count',
    default: 6,
    min: 1,
    max: 100,
  },
  chatDailyWakes: {
    env: 'HQ_CHAT_DAILY_RUNS',
    group: 'chat',
    label: 'Desk-to-desk messages per project per day',
    hint: 'Past this, threads pause until tomorrow or until you resume.',
    unit: 'count',
    default: 30,
    min: 1,
    max: 2000,
  },
  concurrency: {
    env: 'HQ_CONCURRENCY',
    group: 'team',
    label: 'Desks running at once',
    hint: 'Across all projects. The rest wait for a free slot; your own runs go first.',
    unit: 'count',
    default: 2,
    min: 1,
    max: 16,
  },
  huddlesPerDay: {
    env: 'HQ_HUDDLES_PER_DAY',
    group: 'team',
    label: 'Huddles per project per day',
    hint: 'Each huddle takes several desk runs. 0 turns huddles off.',
    unit: 'count',
    default: 5,
    min: 0,
    max: 50,
  },
  qaMaxFixes: {
    env: 'HQ_QA_MAX_FIXES',
    group: 'team',
    label: 'Fixes after a failed QA check',
    hint: 'Dev-team projects: after this many fixes, a ticket that fails QA again comes to you.',
    unit: 'count',
    default: 2,
    min: 0,
    max: 20,
  },
  claudeTicketTurns: {
    env: 'HQ_MAX_TURNS',
    group: 'claude',
    label: 'Turns per ticket run',
    hint: 'Ticket and QA runs.',
    unit: 'count',
    default: 40,
    min: 1,
    max: 1000,
  },
  claudeTicketUsd: {
    env: 'HQ_MAX_BUDGET_USD',
    group: 'claude',
    label: 'Budget per ticket run',
    hint: "Ticket and QA runs. Claude's own cost estimate: on a subscription it stops a runaway run, it is not a charge.",
    unit: 'usd',
    default: 3,
    min: 0.1,
    max: 1000,
  },
  claudeReplyTurns: {
    env: 'HQ_MSG_MAX_TURNS',
    group: 'claude',
    label: 'Turns per chat reply',
    hint: 'Chat replies and huddle turns.',
    unit: 'count',
    default: 12,
    min: 1,
    max: 1000,
  },
  claudeReplyUsd: {
    env: 'HQ_MSG_MAX_BUDGET_USD',
    group: 'claude',
    label: 'Budget per chat reply',
    hint: 'Chat replies and huddle turns.',
    unit: 'usd',
    default: 1,
    min: 0.1,
    max: 1000,
  },
  claudePlanTurns: {
    env: 'HQ_PLAN_MAX_TURNS',
    group: 'claude',
    label: 'Turns per planning run',
    hint: "Goal mode: the lead's planning run.",
    unit: 'count',
    default: 20,
    min: 1,
    max: 1000,
  },
  claudePlanUsd: {
    env: 'HQ_PLAN_MAX_BUDGET_USD',
    group: 'claude',
    label: 'Budget per planning run',
    hint: "Goal mode: the lead's planning run.",
    unit: 'usd',
    default: 1.5,
    min: 0.1,
    max: 1000,
  },
  gptTicketCalls: {
    env: 'HQ_GPT_MAX_TOOL_CALLS',
    group: 'gpt',
    label: 'Tool calls per ticket run',
    hint: 'Ticket, QA and huddle runs. GPT runs spend your ChatGPT plan, so HQ caps them by tool calls, not dollars.',
    unit: 'count',
    default: 80,
    min: 1,
    max: 1000,
  },
  gptReplyCalls: {
    env: 'HQ_GPT_MSG_MAX_TOOL_CALLS',
    group: 'gpt',
    label: 'Tool calls per chat reply',
    hint: 'Chat replies.',
    unit: 'count',
    default: 24,
    min: 1,
    max: 1000,
  },
  gptPlanCalls: {
    env: 'HQ_GPT_PLAN_MAX_TOOL_CALLS',
    group: 'gpt',
    label: 'Tool calls per planning run',
    hint: "Goal mode: the lead's planning run.",
    unit: 'count',
    default: 40,
    min: 1,
    max: 1000,
  },
  runIdleMs: {
    env: 'HQ_RUN_IDLE_MS',
    group: 'time',
    label: 'Quiet limit',
    hint: 'A run stops after this long with no word from the model.',
    unit: 'ms',
    default: 8 * MIN,
    min: MIN,
    max: 240 * MIN,
  },
  toolIdleMs: {
    env: 'HQ_TOOL_IDLE_MS',
    group: 'time',
    label: 'Tool call limit',
    hint: 'How long a run may wait on one tool call before it stops.',
    unit: 'ms',
    default: 20 * MIN,
    min: MIN,
    max: 480 * MIN,
  },
  runTimeoutMs: {
    env: 'HQ_RUN_TIMEOUT_MS',
    group: 'time',
    label: 'Whole run',
    hint: 'The most one run may take, however busy.',
    unit: 'ms',
    default: 40 * MIN,
    min: 5 * MIN,
    max: 1440 * MIN,
  },
} as const satisfies Record<string, LimitSpec>;

export type LimitKey = keyof typeof LIMITS;
export const LIMIT_KEYS = Object.keys(LIMITS) as LimitKey[];

export const isLimitKey = (v: unknown): v is LimitKey => typeof v === 'string' && Object.hasOwn(LIMITS, v);

/** Rounded the way the limit is kept: whole counts, cents, whole milliseconds. */
export function roundLimit(key: LimitKey, n: number): number {
  const unit: LimitUnit = LIMITS[key].unit;
  if (unit === 'usd') return Math.round(n * 100) / 100;
  if (unit === 'ms') return Math.round(n);
  return Math.floor(n);
}

/**
 * A value for this limit as it is kept, or null when it isn't a number in the limit's range. A count is rounded
 * down, as in a hand-edited data/settings.json; the API refuses a count that isn't whole before it gets here.
 */
export function checkLimit(key: LimitKey, v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const spec: LimitSpec = LIMITS[key];
  const n = roundLimit(key, v);
  return n >= spec.min && n <= spec.max ? n : null;
}

/**
 * This limit as .env sets it, or null when it isn't set. Junk means not set; a number outside the range is pulled
 * into it, as HQ always did with a 0 or a negative (a time of 0 or less means not set).
 */
export function limitFromEnv(key: LimitKey, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  const spec: LimitSpec = LIMITS[key];
  if (!Number.isFinite(n) || (spec.unit === 'ms' && n <= 0)) return null;
  return Math.min(spec.max, Math.max(spec.min, roundLimit(key, n)));
}

/** A limit's value in words, in the unit the Accounts page shows it in: "6", "$1.5", "8 minutes", "1 minute". */
export function limitText(key: LimitKey, n: number): string {
  const unit: LimitUnit = LIMITS[key].unit;
  if (unit === 'usd') return `$${n}`;
  if (unit === 'ms') {
    const m = Math.round((n / 60_000) * 100) / 100;
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  return String(n);
}

/**
 * The .env limits HQ can't take as written, one line each, for the startup log: what .env says, what HQ does with
 * it, and the value that counts. Junk, or a time of 0 or less, is ignored; a number out of range, or a count that
 * isn't whole, is pulled in. yours: the limits set on the Accounts page, which win over .env.
 */
export function envLimitWarnings(env: Record<string, string | undefined>, yours: Partial<Record<LimitKey, number>> = {}): string[] {
  const out: string[] = [];
  for (const key of LIMIT_KEYS) {
    const spec: LimitSpec = LIMITS[key];
    const raw = env[spec.env];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    const got = limitFromEnv(key, raw);
    const kept = roundLimit(key, n);
    const why =
      got === null
        ? Number.isFinite(n)
          ? 'is 0 or less'
          : 'is not a number'
        : kept < spec.min
          ? `is under ${limitText(key, spec.min)}`
          : kept > spec.max
            ? `is over ${limitText(key, spec.max)}`
            : spec.unit === 'count' && !Number.isInteger(n)
              ? 'is not a whole number'
              : null;
    if (!why) continue;
    const did = got === null ? 'HQ ignores it' : `HQ takes it as ${limitText(key, got)}`;
    const own = yours[key];
    const counts = own !== undefined ? `${limitText(key, own)}, set on the Accounts page` : got === null ? `${limitText(key, spec.default)}, HQ's default` : limitText(key, got);
    out.push(`${spec.env}=${raw.trim()} in .env ${why}, so ${did}. ${spec.label}: ${counts}.`);
  }
  return out;
}

/** Where a limit's value comes from: you on the Accounts page, .env, or HQ's default. */
export type LimitSource = 'you' | 'env' | 'default';

export interface LimitValue {
  value: number;
  source: LimitSource;
  /** What it goes back to without yours: .env's value, or the default. */
  fallback: number;
  fallbackSource: Exclude<LimitSource, 'you'>;
}

export type LimitsResponse = Record<LimitKey, LimitValue>;

/** The body that changes limits: a value, or null to go back to .env or the default. */
export type LimitsPatch = Partial<Record<LimitKey, number | null>>;
