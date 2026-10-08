import fs from 'node:fs';
import path from 'node:path';
import { isEffortLevel, type EffortLevel } from '../shared/types';

/**
 * Settings for all of HQ, every project: data/settings.json. Read once, then kept in memory.
 * A change is written beside the file and swapped in, so a crash mid-write never leaves half a file.
 */
export interface HqSettings {
  /** How hard Claude works on each desk turn. Unset: the model's own default. */
  effort?: EffortLevel;
  /** You pressed Pause: nothing the team starts on its own runs until you resume. */
  paused?: { at: string };
  /** Claude refused a run: a usage limit (clears by itself at until) or an account problem (waits for Resume). */
  usageHold?: UsageHold;
  /** You signed in to your Claude account from HQ: desks run live on it from the next start, without HQ_RUNNER in .env. */
  claudeLogin?: { at: string };
  /**
   * HQ has gone live here once (or you said yes to the Claude login). Signing out never clears it: from then on the
   * projects are real, so without a login HQ stays idle instead of running the sim, which fakes work in them.
   */
  wentLive?: { at: string };
}

export interface UsageHold {
  kind: 'usage' | 'account';
  at: string;
  text: string;
  until?: string;
}

const FILE = path.resolve(process.cwd(), 'data', 'settings.json');
let current: HqSettings | null = null;

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Keeps only known fields with valid values, so a hand-edited file can't break a run. Exported for tests. */
export function parseSettings(raw: unknown): HqSettings {
  const out: HqSettings = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (isEffortLevel(r.effort)) out.effort = r.effort;
  const paused = r.paused as { at?: unknown } | undefined;
  if (paused && typeof paused === 'object' && isTime(paused.at)) out.paused = { at: paused.at };
  const hold = r.usageHold as Partial<Record<keyof UsageHold, unknown>> | undefined;
  if (hold && typeof hold === 'object' && (hold.kind === 'usage' || hold.kind === 'account') && isTime(hold.at) && typeof hold.text === 'string') {
    out.usageHold = { kind: hold.kind, at: hold.at, text: hold.text.slice(0, 300), ...(isTime(hold.until) ? { until: hold.until } : {}) };
  }
  const login = r.claudeLogin as { at?: unknown } | undefined;
  if (login && typeof login === 'object' && isTime(login.at)) out.claudeLogin = { at: login.at };
  const went = r.wentLive as { at?: unknown } | undefined;
  if (went && typeof went === 'object' && isTime(went.at)) out.wentLive = { at: went.at };
  return out;
}

export function settings(): HqSettings {
  if (!current) {
    try {
      current = parseSettings(JSON.parse(fs.readFileSync(FILE, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[hq] data/settings.json could not be read; using the defaults.');
      current = {};
    }
  }
  return current;
}

function save(next: HqSettings): HqSettings {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);
  current = next;
  return next;
}

/** Sets the effort for every desk run from the next one on. Null goes back to the model's default. */
export function setEffort(effort: EffortLevel | null): HqSettings {
  const next: HqSettings = { ...settings() };
  if (effort) next.effort = effort;
  else delete next.effort;
  return save(next);
}

/** Pause or resume everything the team starts on its own. A usage or account hold is separate (setUsageHold). */
export function setPaused(on: boolean, at = new Date().toISOString()): HqSettings {
  const next: HqSettings = { ...settings() };
  if (on) next.paused = settings().paused ?? { at };
  else delete next.paused;
  return save(next);
}

/** You signed in to your Claude account from HQ (on), or signed out of it (off). */
export function setClaudeLogin(on: boolean, at = new Date().toISOString()): HqSettings {
  const next: HqSettings = { ...settings() };
  if (on) {
    next.claudeLogin = { at };
    next.wentLive ??= { at };
  } else delete next.claudeLogin;
  return save(next);
}

/** HQ started live: noted once, and kept (see HqSettings.wentLive). */
export function noteWentLive(at = new Date().toISOString()): HqSettings {
  const s = settings();
  return s.wentLive ? s : save({ ...s, wentLive: { at } });
}

/** Claude refused a run (or the hold cleared): automatic work waits while it lasts. */
export function setUsageHold(hold: UsageHold | null): HqSettings {
  const next: HqSettings = { ...settings() };
  if (hold) next.usageHold = hold;
  else delete next.usageHold;
  return save(next);
}
