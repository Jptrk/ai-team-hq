import fs from 'node:fs';
import path from 'node:path';
import { checkLimit, isLimitKey, type LimitKey, type LimitsPatch } from '../shared/limits';
import { isEffortLevel, PROVIDERS, type EffortLevel, type Provider } from '../shared/types';

/**
 * Settings for all of HQ, every project: data/settings.json. Read once, then kept in memory.
 * A change is written beside the file and swapped in, so a crash mid-write never leaves half a file.
 */
export interface HqSettings {
  /** How hard Claude works on each desk turn. Unset: the model's own default. */
  effort?: EffortLevel;
  /** You pressed Pause: nothing the team starts on its own runs until you resume. */
  paused?: { at: string };
  /**
   * A model refused a run: a usage limit (clears by itself at until) or an account problem (waits for Resume). Kept per
   * model, so ChatGPT's limit holds GPT projects only and Claude's holds Claude projects only.
   */
  usageHolds?: Partial<Record<Provider, UsageHold>>;
  /** You signed in to your Claude account from HQ: desks run live on it from the next start, without HQ_RUNNER in .env. */
  claudeLogin?: { at: string };
  /** You signed in to ChatGPT from HQ (or said yes to its login): GPT desks run on it. */
  chatgptLogin?: { at: string };
  /** The model GPT desks use. Unset: Codex's default. */
  gptModel?: string;
  /** The reasoning effort GPT desks use. Unset: the model's default. */
  gptEffort?: string;
  /**
   * HQ has gone live here once (or you said yes to the Claude login). Signing out never clears it: from then on the
   * projects are real, so without a login HQ stays idle instead of running the sim, which fakes work in them.
   */
  wentLive?: { at: string };
  /** Limits you set on the Accounts page. They win over .env (see shared/limits.ts). */
  limits?: Partial<Record<LimitKey, number>>;
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

/** A GPT model id or effort level as Codex names them: "gpt-6.1-sol", "xhigh". It goes into Codex's settings, so nothing else. Exported for tests. */
export const isGptName = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v);

/** Keeps only known fields with valid values, so a hand-edited file can't break a run. Exported for tests. */
export function parseSettings(raw: unknown): HqSettings {
  const out: HqSettings = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (isEffortLevel(r.effort)) out.effort = r.effort;
  const paused = r.paused as { at?: unknown } | undefined;
  if (paused && typeof paused === 'object' && isTime(paused.at)) out.paused = { at: paused.at };
  const holds: Partial<Record<Provider, UsageHold>> = {};
  const byModel = r.usageHolds as Record<string, unknown> | undefined;
  if (byModel && typeof byModel === 'object') {
    for (const provider of PROVIDERS) {
      const hold = parseHold(byModel[provider]);
      if (hold) holds[provider] = hold;
    }
  }
  // A file from before holds were per model: one hold for everything. Its words say whose limit it was.
  const old = parseHold(r.usageHold);
  if (old) holds[/chatgpt/i.test(old.text) ? 'gpt' : 'claude'] ??= old;
  if (Object.keys(holds).length) out.usageHolds = holds;
  const login = r.claudeLogin as { at?: unknown } | undefined;
  if (login && typeof login === 'object' && isTime(login.at)) out.claudeLogin = { at: login.at };
  const gpt = r.chatgptLogin as { at?: unknown } | undefined;
  if (gpt && typeof gpt === 'object' && isTime(gpt.at)) out.chatgptLogin = { at: gpt.at };
  if (isGptName(r.gptModel)) out.gptModel = r.gptModel;
  if (isGptName(r.gptEffort)) out.gptEffort = r.gptEffort;
  const went = r.wentLive as { at?: unknown } | undefined;
  if (went && typeof went === 'object' && isTime(went.at)) out.wentLive = { at: went.at };
  const limits = r.limits as Record<string, unknown> | undefined;
  if (limits && typeof limits === 'object') {
    const kept: Partial<Record<LimitKey, number>> = {};
    for (const [key, v] of Object.entries(limits)) {
      if (!isLimitKey(key)) continue;
      const n = checkLimit(key, v);
      if (n !== null) kept[key] = n;
    }
    if (Object.keys(kept).length) out.limits = kept;
  }
  return out;
}

function parseHold(raw: unknown): UsageHold | null {
  const hold = raw as Partial<Record<keyof UsageHold, unknown>> | undefined;
  if (!hold || typeof hold !== 'object' || (hold.kind !== 'usage' && hold.kind !== 'account') || !isTime(hold.at) || typeof hold.text !== 'string') return null;
  return { kind: hold.kind, at: hold.at, text: hold.text.slice(0, 300), ...(isTime(hold.until) ? { until: hold.until } : {}) };
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

/** You signed in to ChatGPT from HQ or turned on its login (on), or signed out or turned it off (off). */
export function setChatGptLogin(on: boolean, at = new Date().toISOString()): HqSettings {
  const next: HqSettings = { ...settings() };
  if (on) {
    next.chatgptLogin = { at };
    next.wentLive ??= { at };
  } else delete next.chatgptLogin;
  return save(next);
}

/** The model and effort GPT desks use from the next run on. Null goes back to Codex's default; undefined leaves it. */
export function setGpt(change: { model?: string | null; effort?: string | null }): HqSettings {
  const next: HqSettings = { ...settings() };
  if (change.model !== undefined) {
    if (change.model) next.gptModel = change.model;
    else delete next.gptModel;
  }
  if (change.effort !== undefined) {
    if (change.effort) next.gptEffort = change.effort;
    else delete next.gptEffort;
  }
  return save(next);
}

/** Sets limits from the next check on. Null goes back to .env or the default. Values must already pass checkLimit. */
export function setLimits(patch: LimitsPatch): HqSettings {
  const limits: Partial<Record<LimitKey, number>> = { ...settings().limits };
  for (const [key, v] of Object.entries(patch) as [LimitKey, number | null | undefined][]) {
    if (v === null) delete limits[key];
    else if (v !== undefined) limits[key] = v;
  }
  const next: HqSettings = { ...settings() };
  if (Object.keys(limits).length) next.limits = limits;
  else delete next.limits;
  return save(next);
}

/** HQ started live: noted once, and kept (see HqSettings.wentLive). */
export function noteWentLive(at = new Date().toISOString()): HqSettings {
  const s = settings();
  return s.wentLive ? s : save({ ...s, wentLive: { at } });
}

/** Claude or ChatGPT refused a run (or its hold cleared): that model's projects wait while it lasts. */
export function setUsageHold(provider: Provider, hold: UsageHold | null): HqSettings {
  const holds: Partial<Record<Provider, UsageHold>> = { ...settings().usageHolds };
  if (hold) holds[provider] = hold;
  else delete holds[provider];
  const next: HqSettings = { ...settings() };
  if (Object.keys(holds).length) next.usageHolds = holds;
  else delete next.usageHolds;
  return save(next);
}

/** Every model's hold goes at once. Resume clears them one model at a time (resumeAll); tests start clean with this. */
export function clearUsageHolds(): HqSettings {
  const next: HqSettings = { ...settings() };
  delete next.usageHolds;
  return save(next);
}
