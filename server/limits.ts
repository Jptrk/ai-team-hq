import { LIMIT_KEYS, LIMITS, checkLimit, isLimitKey, limitFromEnv, limitText, type LimitKey, type LimitSpec, type LimitsPatch, type LimitsResponse, type LimitValue } from '../shared/limits';
import type { WatchLimits } from './runner/watch';
import { settings } from './settings';

/**
 * The limits in force now, read on every use: a change on the Accounts page counts from the next check, with no
 * restart. Yours wins, then .env, then HQ's default (shared/limits.ts).
 */

function current(key: LimitKey): LimitValue {
  const env = limitFromEnv(key, process.env[LIMITS[key].env]);
  const fallback = env ?? LIMITS[key].default;
  const fallbackSource = env === null ? 'default' : 'env';
  const yours = settings().limits?.[key];
  return yours === undefined ? { value: fallback, source: fallbackSource, fallback, fallbackSource } : { value: yours, source: 'you', fallback, fallbackSource };
}

export function limit(key: LimitKey): number {
  return current(key).value;
}

/** Every limit, where it comes from, and what it goes back to. For the Accounts page. */
export function limitsView(): LimitsResponse {
  return Object.fromEntries(LIMIT_KEYS.map((key) => [key, current(key)])) as LimitsResponse;
}

/** When a run stops for going quiet, waiting on a tool, or running too long. */
export function watchLimits(): WatchLimits {
  return { idleMs: limit('runIdleMs'), toolIdleMs: limit('toolIdleMs'), capMs: limit('runTimeoutMs') };
}

/**
 * The body that changes limits (PATCH /api/limits), checked: every value in range, or null to go back. A count must
 * be whole: 0.9 huddles a day would save as 0, which turns huddles off.
 */
export function readLimitsPatch(body: Record<string, unknown>): { patch?: LimitsPatch; error?: string } {
  const patch: LimitsPatch = {};
  for (const [key, v] of Object.entries(body)) {
    if (!isLimitKey(key)) return { error: `Unknown limit "${key}"` };
    if (v === null) {
      patch[key] = null;
      continue;
    }
    const spec: LimitSpec = LIMITS[key];
    const whole = spec.unit === 'count';
    const n = whole && typeof v === 'number' && !Number.isInteger(v) ? null : checkLimit(key, v);
    if (n === null) {
      return { error: `${spec.label} must be a ${whole ? 'whole ' : ''}number from ${limitText(key, spec.min)} to ${limitText(key, spec.max)}` };
    }
    patch[key] = n;
  }
  if (!Object.keys(patch).length) return { error: 'Nothing to change' };
  return { patch };
}
