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
}

const FILE = path.resolve(process.cwd(), 'data', 'settings.json');
let current: HqSettings | null = null;

/** Keeps only known fields with valid values, so a hand-edited file can't break a run. Exported for tests. */
export function parseSettings(raw: unknown): HqSettings {
  const out: HqSettings = {};
  if (!raw || typeof raw !== 'object') return out;
  const effort = (raw as { effort?: unknown }).effort;
  if (isEffortLevel(effort)) out.effort = effort;
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

/** Sets the effort for every desk run from the next one on. Null goes back to the model's default. */
export function setEffort(effort: EffortLevel | null): HqSettings {
  const next: HqSettings = { ...settings() };
  if (effort) next.effort = effort;
  else delete next.effort;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);
  current = next;
  return next;
}
