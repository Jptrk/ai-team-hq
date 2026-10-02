import { MCP_PRESETS, presetById, presetDefaults, type PresetValues } from '../../../shared/mcpPresets';
import { isLoopbackHost, nameProblem, type AddRequest, type AddScope, type AddTransport, type KeyValue } from '../../../shared/mcpSpec';
import type { ConnectionRow, McpSource } from '../../../shared/types';

/** The Add connection form, before it becomes a request. Pure, so the tests can run it. */
export interface AddForm {
  /** A preset id, or 'custom'. */
  pick: string;
  name: string;
  scope: AddScope;
  values: PresetValues;
  transport: AddTransport;
  url: string;
  headers: KeyValue[];
  command: string;
  /** One argument per line. */
  argsText: string;
  env: KeyValue[];
  trust: boolean;
}

export const CUSTOM = 'custom';

export function initialForm(pick: string, hasFolder: boolean): AddForm {
  const preset = presetById(pick);
  return {
    pick: preset ? preset.id : CUSTOM,
    name: preset?.defaultName ?? '',
    scope: hasFolder ? 'project' : 'all',
    values: preset ? presetDefaults(preset) : {},
    transport: 'http',
    url: '',
    headers: [],
    command: '',
    argsText: '',
    env: [],
    trust: false,
  };
}

/** A new header or variable row. Secret unless you untick it: most values typed here are tokens. */
export function blankRow(): KeyValue {
  return { name: '', value: '', secret: true };
}

/** One argument per line. Blank lines are dropped; spaces inside a line stay. */
export function splitArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function toRequest(f: AddForm): AddRequest {
  const base = { name: f.name.trim(), scope: f.scope };
  if (f.pick !== CUSTOM) return { ...base, preset: f.pick, values: f.values };
  const rows = (r: KeyValue[]) => r.filter((x) => x.name.trim() || x.value).map((x) => ({ name: x.name.trim(), value: x.value, secret: Boolean(x.secret) }));
  if (f.transport === 'stdio') {
    return { ...base, transport: 'stdio', command: f.command.trim(), args: splitArgs(f.argsText), env: rows(f.env), trustCommand: f.trust };
  }
  return { ...base, transport: f.transport, url: f.url.trim(), headers: rows(f.headers) };
}

const WHERE: Record<McpSource, string> = {
  folder: "this project's settings",
  repo: "the repo's .mcp.json",
  user: 'all projects',
  'claude-ai': 'claude.ai',
};

/** "Already set up (all projects)" for a preset card, from the rows on the page. */
export function alreadySetUp(rows: ConnectionRow[], name: string): string | null {
  const row = rows.find((r) => r.name === name && r.present);
  return row ? `Already set up (${WHERE[row.source]})` : null;
}

export function presetCards(rows: ConnectionRow[]): { id: string; title: string; blurb: string; already: string | null }[] {
  return MCP_PRESETS.map((p) => ({ id: p.id, title: p.title, blurb: p.blurb, already: alreadySetUp(rows, p.defaultName) }));
}

const isWeb = (row: ConnectionRow) => row.transport === 'http' || row.transport === 'sse';

function isLoopbackTarget(row: ConnectionRow): boolean {
  try {
    return isLoopbackHost(new URL(row.target).hostname);
  } catch {
    return false;
  }
}

/** Servers you sign in to with a browser: web servers with no token in their config. */
export function canSignIn(row: ConnectionRow): boolean {
  return row.source !== 'claude-ai' && row.present && isWeb(row) && row.auth === 'oauth';
}

/**
 * Which sign-in buttons a row shows. One way at a time: after a failed sign-in only its Try again
 * (or the terminal command), never Log in as well. The command is only offered for plain names,
 * since it is pasted into a terminal or run there.
 */
export function signInButtons(row: ConnectionRow): { login: boolean; logout: boolean; tryAgain: boolean; command: boolean } {
  const state = row.check?.state ?? 'unchecked';
  const failed = row.login?.state === 'failed';
  const unsupported = Boolean(row.login?.unsupported);
  return {
    login: canSignIn(row) && state === 'needs-login' && !row.login,
    logout: canSignIn(row) && state === 'connected' && !isLoopbackTarget(row),
    tryAgain: failed && !unsupported,
    command: failed && unsupported && nameProblem(row.name) === null,
  };
}

/** The host a sign-in link goes to, shown on the button so you know where you're going. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Seconds left as m:ss. */
export function timeLeft(expiresAt: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
